//! Dolt database connection manager.
//!
//! Provides direct MySQL connection to Dolt for reading beads data,
//! with database discovery via `SHOW DATABASES`.

use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, TxOpts};
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::routes::activity::RawActivityRow;
use crate::routes::beads::{Bead, Comment, DOLT_PATH_PREFIX};

/// Connection parameters for a Dolt SQL server (central or per-project host).
#[derive(Clone)]
struct DoltConnectConfig {
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
}

/// Debug пишется вручную по той же причине, что и у `config::PasswordResolution`:
/// производный напечатал бы пароль целиком, а `tracing::debug!("{:?}", config)`
/// — слишком естественный способ незаметно добавить утечку в будущей правке.
/// Значение заменяется на `<redacted>`, факт наличия остаётся видимым.
/// Закреплено тестом `debug_output_never_contains_the_password_value`.
impl std::fmt::Debug for DoltConnectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DoltConnectConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl DoltConnectConfig {
    /// Resolves connection parameters via `crate::config` -- the single
    /// in-process source of truth for Dolt env vars / credentials-file /
    /// legacy files (see `config.rs` module docs for the full source chain).
    fn from_env() -> Self {
        let (host, _) = crate::config::resolve_dolt_host();
        let (port, _) = crate::config::resolve_dolt_port();
        let (user, _) = crate::config::resolve_dolt_user();
        let (password, _) = crate::config::resolve_dolt_password(&host, port);
        Self {
            host,
            port,
            user,
            password,
        }
    }

    fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    fn build_opts(&self, port_override: Option<u16>, pool_opts: PoolOpts) -> Opts {
        let mut builder = OptsBuilder::default()
            .ip_or_hostname(&self.host)
            .tcp_port(port_override.unwrap_or(self.port))
            .user(Some(self.user.as_str()))
            .pool_opts(pool_opts);
        if let Some(ref password) = self.password {
            builder = builder.pass(Some(password.as_str()));
        }
        builder.into()
    }
}

/// Errors from Dolt operations.
#[derive(Debug, thiserror::Error)]
pub enum DoltError {
    #[error("MySQL connection failed: {0}")]
    ConnectionFailed(String),

    #[error("SQL query failed: {0}")]
    QueryFailed(String),

    #[error("Database not found: {0}")]
    DatabaseNotFound(String),
}

/// Manages the connection pool and operations against a Dolt MySQL server.
pub struct DoltManager {
    pool: Pool,
    config: DoltConnectConfig,
    available: AtomicBool,
    /// Где на этой машине лежат проекты обнаруженных баз — см.
    /// [`LocalProjectIndex`].
    local_projects: LocalProjectIndex,
}

impl DoltManager {
    /// Creates a new DoltManager with a connection pool to Dolt.
    pub fn new() -> Self {
        let config = DoltConnectConfig::from_env();
        let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 4).unwrap());
        let opts = config.build_opts(None, pool_opts);

        Self {
            pool: Pool::new(opts),
            config,
            available: AtomicBool::new(false),
            local_projects: LocalProjectIndex::new(),
        }
    }

    /// Индекс «имя базы -> папка проекта» этой машины, из кэша или свежий.
    pub async fn local_project_index(
        &self,
        roots: Vec<PathBuf>,
    ) -> Arc<HashMap<String, PathBuf>> {
        self.local_projects.get(roots).await
    }

    /// Configured Dolt endpoint (`host:port`) for status messages.
    pub fn endpoint(&self) -> String {
        self.config.endpoint()
    }

    /// Checks if Dolt server is reachable via TCP.
    pub async fn check_server(&self) -> bool {
        let host = self.config.host.clone();
        let port = self.config.port;
        let reachable = TcpStream::connect((host.as_str(), port)).await.is_ok();
        self.available.store(reachable, Ordering::Relaxed);
        reachable
    }

    /// Returns cached availability (set by `check_server`).
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    /// Discovers Beads databases by schema instead of relying on a name prefix.
    /// Any database containing an `issues` table is considered a Beads database.
    pub async fn discover_databases(&self) -> Result<Vec<DoltDatabase>, DoltError> {
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

        let rows: Vec<Row> = conn
            .query(
                "SELECT DISTINCT TABLE_SCHEMA \
             FROM information_schema.TABLES \
             WHERE TABLE_NAME = 'issues' \
             ORDER BY TABLE_SCHEMA",
            )
            .await
            .map_err(|e| DoltError::QueryFailed(e.to_string()))?;

        let mut databases = Vec::new();
        for row in rows {
            let name: String = row.get(0).unwrap_or_default();
            if !name.is_empty() {
                let project_name = name.strip_prefix("beads_").unwrap_or(&name).to_string();
                databases.push(DoltDatabase {
                    name,
                    project_name,
                    local_path: None,
                });
            }
        }

        self.available.store(true, Ordering::Relaxed);
        Ok(databases)
    }

    /// Reads beads (issues + comments + dependencies) from a specific Dolt database.
    pub async fn read_beads(&self, db_name: &str) -> Result<Vec<Bead>, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        let beads = read_beads_from_conn(&mut conn, db_name).await?;
        self.available.store(true, Ordering::Relaxed);
        info!("Read {} beads from Dolt SQL (db: {})", beads.len(), db_name);
        Ok(beads)
    }

    /// Aggregates issues per raw status without transferring any issue rows.
    ///
    /// This is the cheap counterpart of [`read_beads`](Self::read_beads) used by
    /// `GET /api/beads/counts`: the home page only needs four numbers, so the
    /// `GROUP BY` runs on the Dolt server instead of shipping every description,
    /// comment and dependency over the wire.
    pub async fn count_issues_by_status(
        &self,
        db_name: &str,
    ) -> Result<Vec<(String, i64)>, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        let counts = query_status_counts(&mut conn, db_name).await?;
        self.available.store(true, Ordering::Relaxed);
        Ok(counts)
    }

    /// Aggregates the database's label vocabulary as `(label, count)` pairs.
    ///
    /// The cheap counterpart of reading every bead just to learn which labels
    /// exist: the `GROUP BY` runs on the Dolt server, so the filter menu costs
    /// one row per distinct label.
    pub async fn count_labels(&self, db_name: &str) -> Result<Vec<(String, i64)>, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        let counts = query_label_counts(&mut conn, db_name).await?;
        self.available.store(true, Ordering::Relaxed);
        Ok(counts)
    }

    /// Reads one page of the database's event log, newest first.
    ///
    /// Feeds `GET /api/activity`: the board shows the current state, this shows
    /// how it got there.
    pub async fn read_activity(
        &self,
        db_name: &str,
        query: &ActivityQuery,
    ) -> Result<Vec<RawActivityRow>, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        let rows = query_activity(&mut conn, db_name, query).await?;
        self.available.store(true, Ordering::Relaxed);
        Ok(rows)
    }

    /// Returns a hash identifying the database's current working-set state.
    ///
    /// Used by the live-update poller to tell "nothing changed" from "reload" at
    /// the cost of a single scalar query, instead of refetching every issue.
    ///
    /// Hashes the *working set* rather than `HEAD`: `bd` writes into the working
    /// set and does not always commit, so a `HASHOF('HEAD')` probe would miss
    /// changes that readers can already see (bweb-489.5.3).
    pub async fn database_revision(&self, db_name: &str) -> Result<String, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        // `DOLT_HASHOF_DB` resolves against the session's current database, and
        // with no database selected it silently hashes whichever one the session
        // defaults to — the wrong revision, reported as success. Select the
        // database first, on this same connection, exactly like the commit paths.
        conn.query_drop(format!("USE `{}`", db_name))
            .await
            .map_err(|e| DoltError::QueryFailed(format!("use database: {}", e)))?;
        let revision: Option<String> = conn
            .query_first("SELECT DOLT_HASHOF_DB('WORKING')")
            .await
            .map_err(|e| DoltError::QueryFailed(format!("database_revision: {}", e)))?;
        self.available.store(true, Ordering::Relaxed);
        revision.ok_or_else(|| {
            DoltError::QueryFailed("database_revision returned no rows".to_string())
        })
    }

    /// Returns the issue prefix stored by `bd init`, falling back to the database name.
    pub async fn issue_prefix(&self, db_name: &str) -> Result<String, DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;
        let query = format!(
            "SELECT value FROM `{}`.config WHERE `key` = 'issue_prefix' LIMIT 1",
            db_name
        );
        let prefix: Option<String> = conn
            .query_first(query)
            .await
            .map_err(|e| DoltError::QueryFailed(format!("issue_prefix: {}", e)))?;
        Ok(prefix
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                db_name
                    .strip_prefix("beads_")
                    .unwrap_or(db_name)
                    .to_string()
            }))
    }

    /// Creates a new bead in a Dolt database and commits the change.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_bead(
        &self,
        db_name: &str,
        id: &str,
        title: &str,
        description: Option<&str>,
        issue_type: &str,
        priority: i32,
        parent_id: Option<&str>,
    ) -> Result<(), DoltError> {
        validate_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

        // First, query the table schema to find all NOT NULL columns without defaults
        // so we can provide empty values for them
        let schema_query = "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'issues' \
             AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL \
             AND COLUMN_NAME NOT IN ('id', 'title', 'description', 'status', 'priority', \
             'issue_type', 'owner', 'created_at', 'updated_at')";
        let extra_cols: Vec<String> = conn
            .exec_map(
                schema_query,
                mysql_async::params! { "db" => db_name },
                |col_name: String| col_name,
            )
            .await
            .unwrap_or_default();

        // Build INSERT with all required columns
        let mut columns = vec![
            "id",
            "title",
            "description",
            "status",
            "priority",
            "issue_type",
            "owner",
            "created_at",
            "updated_at",
        ];
        let mut values = vec![
            ":id",
            ":title",
            ":desc",
            "'open'",
            ":priority",
            ":type",
            "'web-ui'",
            ":now",
            ":now",
        ];

        // Add empty string for any extra NOT NULL columns
        for col in &extra_cols {
            columns.push(col);
            values.push("''");
        }

        // Dependency layout must be introspected before the transaction starts,
        // since the transaction takes exclusive hold of the connection.
        let dep_schema = match parent_id {
            Some(_) => Some(detect_dependency_schema(&mut conn, db_name).await),
            None => None,
        };

        let query = format!(
            "INSERT INTO `{}`.issues ({}) VALUES ({})",
            db_name,
            columns
                .iter()
                .map(|c| format!("`{}`", c))
                .collect::<Vec<_>>()
                .join(", "),
            values.join(", "),
        );
        let mut tx = conn
            .start_transaction(TxOpts::default())
            .await
            .map_err(|e| DoltError::QueryFailed(format!("start_transaction: {}", e)))?;
        tx.exec_drop(
            &query,
            mysql_async::params! {
                "id" => id,
                "title" => title,
                "desc" => description,
                "priority" => priority,
                "type" => issue_type,
                "now" => &now,
            },
        )
        .await
        .map_err(|e| DoltError::QueryFailed(format!("insert: {}", e)))?;

        // Insert parent-child dependency if parent specified
        if let (Some(parent), Some(dep_schema)) = (parent_id, dep_schema.as_ref()) {
            let mut dep_columns = vec![
                "issue_id".to_string(),
                dep_schema.target_column.clone(),
                "type".to_string(),
                "created_by".to_string(),
            ];
            let mut dep_values = vec![":child", ":parent", "'parent-child'", ":created_by"];
            // v53+ surrogate primary key has no default — generate one.
            let dep_id = uuid::Uuid::new_v4().to_string();
            if dep_schema.has_surrogate_id {
                dep_columns.insert(0, "id".to_string());
                dep_values.insert(0, ":dep_id");
            }

            let dep_query = format!(
                "INSERT INTO `{}`.dependencies ({}) VALUES ({})",
                db_name,
                dep_columns
                    .iter()
                    .map(|c| format!("`{}`", c))
                    .collect::<Vec<_>>()
                    .join(", "),
                dep_values.join(", "),
            );
            tx.exec_drop(
                &dep_query,
                mysql_async::params! {
                    "child" => id,
                    "parent" => parent,
                    "created_by" => "web-ui",
                    "dep_id" => &dep_id,
                },
            )
            .await
            .map_err(|e| DoltError::QueryFailed(format!("dependency: {}", e)))?;
        }

        tx.commit()
            .await
            .map_err(|e| DoltError::QueryFailed(format!("transaction_commit: {}", e)))?;

        // Dolt commit — must USE the database first
        let use_query = format!("USE `{}`", db_name);
        conn.query_drop(&use_query)
            .await
            .map_err(|e| DoltError::QueryFailed(format!("use_db: {}", e)))?;
        let commit_query = format!("CALL DOLT_COMMIT('-Am', 'web-ui: create {}')", id);
        conn.query_drop(&commit_query)
            .await
            .map_err(|e| DoltError::QueryFailed(format!("dolt_commit: {}", e)))?;

        info!("Created bead {} in Dolt (db: {})", id, db_name);
        Ok(())
    }

    /// Updates a bead's fields in a Dolt database and commits the change.
    pub async fn update_bead(
        &self,
        db_name: &str,
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        status: Option<&str>,
    ) -> Result<(), DoltError> {
        validate_database_name(db_name)?;
        let mut sets = Vec::new();
        let mut params: Vec<(Vec<u8>, mysql_async::Value)> = Vec::new();

        if let Some(t) = title {
            sets.push("title = :title".to_string());
            params.push((b"title".to_vec(), t.into()));
        }
        if let Some(d) = description {
            sets.push("description = :desc".to_string());
            params.push((b"desc".to_vec(), d.into()));
        }
        if let Some(s) = status {
            sets.push("status = :status".to_string());
            params.push((b"status".to_vec(), s.into()));
        }

        if sets.is_empty() {
            return Ok(());
        }

        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        sets.push("updated_at = :now".to_string());
        params.push((b"now".to_vec(), now.into()));
        params.push((b"id".to_vec(), id.into()));

        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

        let query = format!(
            "UPDATE `{}`.issues SET {} WHERE id = :id",
            db_name,
            sets.join(", ")
        );
        conn.exec_drop(
            &query,
            mysql_async::Params::Named(params.into_iter().collect()),
        )
        .await
        .map_err(|e| DoltError::QueryFailed(format!("update: {}", e)))?;

        // Dolt commit — must USE the database first
        let use_query = format!("USE `{}`", db_name);
        conn.query_drop(&use_query)
            .await
            .map_err(|e| DoltError::QueryFailed(format!("use_db: {}", e)))?;
        let commit_query = format!("CALL DOLT_COMMIT('-Am', 'web-ui: update {}')", id);
        conn.query_drop(&commit_query)
            .await
            .map_err(|e| DoltError::QueryFailed(format!("dolt_commit: {}", e)))?;

        info!("Updated bead {} in Dolt (db: {})", id, db_name);
        Ok(())
    }

    /// Runs a case-insensitive substring search over `id` and `title` in one
    /// database, used by the global cross-project search endpoint.
    ///
    /// `pattern` must be a ready-to-use lowercase `LIKE` pattern with wildcards
    /// already escaped by the caller (see `routes::search::escape_like`).
    pub async fn search_issues(
        &self,
        db_name: &str,
        pattern: &str,
        limit: u32,
    ) -> Result<Vec<SearchRow>, DoltError> {
        validate_discovered_database_name(db_name)?;
        let mut conn = self
            .pool
            .get_conn()
            .await
            .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

        let query = format!(
            "SELECT id, title, status FROM `{}`.issues \
             WHERE LOWER(id) LIKE :pattern OR LOWER(title) LIKE :pattern \
             LIMIT {}",
            db_name, limit
        );
        let rows: Vec<Row> = conn
            .exec(&query, mysql_async::params! { "pattern" => pattern })
            .await
            .map_err(|e| DoltError::QueryFailed(format!("search: {}", e)))?;

        Ok(rows
            .iter()
            .map(|row| SearchRow {
                id: get_str(row, "id"),
                title: get_str(row, "title"),
                status: get_opt_str(row, "status").unwrap_or_else(|| "open".to_string()),
            })
            .collect())
    }
}

/// A single issue row matched by the global search query.
#[derive(Debug, Clone)]
pub struct SearchRow {
    pub id: String,
    pub title: String,
    pub status: String,
}

/// Rejects any database name that is not a bare identifier.
///
/// Names reach SQL only inside the backticks of ``USE `{}` ``, so the character
/// that must never get through is the backtick itself; `-` is inert there and is
/// allowed because discovery surfaces hyphenated databases such as
/// `beads_ai-photo-factory`. Keeping one validator for both discovered and
/// caller-supplied names is deliberate — the split version rejected `-` on the
/// `read_beads` / `issue_prefix` paths while allowing it on the search path,
/// which broke those paths for hyphenated databases (bweb-489.14).
fn validate_database_name(db_name: &str) -> Result<(), DoltError> {
    if db_name.is_empty()
        || !db_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(DoltError::DatabaseNotFound(db_name.to_string()));
    }
    Ok(())
}

/// Retained as the discovery-path spelling of [`validate_database_name`], which
/// now applies the same rules to every caller.
fn validate_discovered_database_name(db_name: &str) -> Result<(), DoltError> {
    validate_database_name(db_name)
}

/// Reads beads from a Dolt server on a specific port.
/// Creates a temporary connection pool to the given port, reads data, then drops it.
pub async fn read_beads_on_port(port: u16, db_name: &str) -> Result<Vec<Bead>, DoltError> {
    let config = DoltConnectConfig::from_env();
    let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 2).unwrap());
    let opts = config.build_opts(Some(port), pool_opts);

    let pool = Pool::new(opts);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

    let result = read_beads_from_conn(&mut conn, db_name).await;

    drop(conn);
    if let Err(e) = pool.disconnect().await {
        tracing::warn!("Failed to disconnect temporary pool (port {}): {}", port, e);
    }

    let beads = result?;
    info!(
        "Read {} beads from per-project Dolt SQL (port: {}, db: {})",
        beads.len(),
        port,
        db_name
    );
    Ok(beads)
}

/// Aggregates issues per raw status on a Dolt server listening on `port`.
///
/// Per-project counterpart of [`DoltManager::count_issues_by_status`], mirroring
/// [`read_beads_on_port`] but transferring one row per distinct status instead
/// of the whole issue table.
pub async fn count_issues_by_status_on_port(
    port: u16,
    db_name: &str,
) -> Result<Vec<(String, i64)>, DoltError> {
    let config = DoltConnectConfig::from_env();
    let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 2).unwrap());
    let opts = config.build_opts(Some(port), pool_opts);

    let pool = Pool::new(opts);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

    let result = query_status_counts(&mut conn, db_name).await;

    drop(conn);
    if let Err(e) = pool.disconnect().await {
        tracing::warn!("Failed to disconnect temporary pool (port {}): {}", port, e);
    }

    result
}

/// Discover the beads database name by connecting to a Dolt server and looking
/// for a database that has an `issues` table.
pub async fn discover_database_on_port(port: u16) -> Result<String, DoltError> {
    let config = DoltConnectConfig::from_env();
    let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 2).unwrap());
    let opts = config.build_opts(Some(port), pool_opts);

    let pool = Pool::new(opts);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

    // Get all databases, excluding system ones
    let rows: Vec<Row> = conn
        .query("SHOW DATABASES")
        .await
        .map_err(|e| DoltError::QueryFailed(e.to_string()))?;

    let system_dbs = ["information_schema", "mysql", "dolt_cluster"];
    let mut db_names: Vec<String> = Vec::new();
    for row in rows {
        let db: String = row.get(0).unwrap_or_default();
        if !system_dbs.contains(&db.as_str()) {
            db_names.push(db);
        }
    }

    // Try each database — look for one with an `issues` table
    for db_name in &db_names {
        let query = format!(
            "SELECT COUNT(*) FROM `{}`.`issues` LIMIT 1",
            db_name.replace('`', "``")
        );
        match conn.query_first::<i64, _>(&query).await {
            Ok(Some(_)) => {
                tracing::info!("Discovered beads database '{}' on port {}", db_name, port);
                drop(conn);
                let _ = pool.disconnect().await;
                return Ok(db_name.clone());
            }
            _ => continue,
        }
    }

    drop(conn);
    let _ = pool.disconnect().await;
    Err(DoltError::DatabaseNotFound(format!(
        "No database with issues table found on port {}",
        port
    )))
}

/// Shared logic for reading beads from a Dolt MySQL connection.
///
/// Reads issues, comments, and dependencies from the given database,
/// then merges them into a single `Vec<Bead>`.
async fn read_beads_from_conn(
    conn: &mut mysql_async::Conn,
    db_name: &str,
) -> Result<Vec<Bead>, DoltError> {
    ensure_database_exists(conn, db_name).await?;

    let beads = query_issues(conn, db_name).await?;
    let mut beads = merge_comments(conn, db_name, beads).await?;
    merge_dependencies(conn, db_name, &mut beads).await?;
    merge_labels(conn, db_name, &mut beads).await;
    Ok(beads)
}

/// Helper to safely get nullable string columns from a MySQL row.
fn get_opt_str(row: &Row, col: &str) -> Option<String> {
    row.get::<Option<String>, _>(col).flatten()
}

fn get_str(row: &Row, col: &str) -> String {
    get_opt_str(row, col).unwrap_or_default()
}

/// Fails with [`DoltError::DatabaseNotFound`] unless the schema exists.
async fn ensure_database_exists(
    conn: &mut mysql_async::Conn,
    db_name: &str,
) -> Result<(), DoltError> {
    let db_exists: Option<Row> = conn
        .exec_first(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :db",
            mysql_async::params! { "db" => db_name },
        )
        .await
        .map_err(|e| DoltError::QueryFailed(e.to_string()))?;

    if db_exists.is_none() {
        return Err(DoltError::DatabaseNotFound(db_name.to_string()));
    }
    Ok(())
}

/// Runs `SELECT status, COUNT(*) … GROUP BY status` and returns the raw
/// `(status, count)` pairs.
///
/// Mapping raw statuses onto the four kanban columns is deliberately left to
/// the caller (`routes::beads`) so that the SQL tiers and the in-memory tiers
/// share exactly one mapping implementation.
async fn query_status_counts(
    conn: &mut mysql_async::Conn,
    db_name: &str,
) -> Result<Vec<(String, i64)>, DoltError> {
    // The database name is interpolated into the statement, so it must be
    // validated first — it can originate from project metadata on disk.
    validate_discovered_database_name(db_name)?;
    ensure_database_exists(conn, db_name).await?;

    let query = format!(
        "SELECT status, COUNT(*) AS cnt FROM `{}`.issues GROUP BY status",
        db_name
    );
    let rows: Vec<Row> = conn
        .query(&query)
        .await
        .map_err(|e| DoltError::QueryFailed(format!("status counts: {}", e)))?;

    Ok(rows
        .iter()
        .map(|row| {
            // A NULL status is treated as "open" downstream, matching the
            // default applied by `query_issues`.
            let status = get_str(row, "status");
            let count = row.get::<i64, _>("cnt").unwrap_or(0);
            (status, count)
        })
        .collect())
}

/// Returns `true` when `db_name` has a table called `table`.
async fn has_table(conn: &mut mysql_async::Conn, db_name: &str, table: &str) -> bool {
    let query = "SELECT COUNT(*) AS cnt FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl";
    match conn
        .exec_first::<i64, _, _>(query, mysql_async::params! { "db" => db_name, "tbl" => table })
        .await
    {
        Ok(Some(count)) => count > 0,
        Ok(None) => false,
        Err(e) => {
            warn!(
                "Failed to introspect table {} in db {}: {} — assuming absent",
                table, db_name, e
            );
            false
        }
    }
}

/// Returns `true` when `table` in `db_name` has a column called `column`.
///
/// Used to keep the issues query working against older Dolt schemas that
/// predate a column — a missing column would otherwise fail the whole read.
async fn has_column(
    conn: &mut mysql_async::Conn,
    db_name: &str,
    table: &str,
    column: &str,
) -> bool {
    let query = "SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = :db AND TABLE_NAME = :tbl AND COLUMN_NAME = :col";
    match conn
        .exec_first::<i64, _, _>(
            query,
            mysql_async::params! { "db" => db_name, "tbl" => table, "col" => column },
        )
        .await
    {
        Ok(Some(count)) => count > 0,
        Ok(None) => false,
        Err(e) => {
            warn!(
                "Failed to introspect column {}.{} in db {}: {} — assuming absent",
                table, column, db_name, e
            );
            false
        }
    }
}

/// Queries issues from a Dolt database.
async fn query_issues(conn: &mut mysql_async::Conn, db_name: &str) -> Result<Vec<Bead>, DoltError> {
    // `defer_until` arrived with a later bd schema; older databases don't have
    // it, so select a NULL placeholder there and keep a single row-mapping path.
    let defer_until_select = if has_column(conn, db_name, "issues", "defer_until").await {
        "DATE_FORMAT(defer_until, '%Y-%m-%dT%H:%i:%sZ') AS defer_until"
    } else {
        "NULL AS defer_until"
    };
    let query = format!(
        "SELECT id, title, description, `design`, status, priority, issue_type, \
         owner, assignee, \
         DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at, \
         created_by, \
         DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at, \
         DATE_FORMAT(closed_at, '%Y-%m-%dT%H:%i:%sZ') AS closed_at, \
         close_reason, {defer_until_select} \
         FROM `{db_name}`.issues"
    );
    let rows: Vec<Row> = conn
        .query(&query)
        .await
        .map_err(|e| DoltError::QueryFailed(format!("issues: {}", e)))?;

    Ok(rows
        .iter()
        .map(|row| Bead {
            id: get_str(row, "id"),
            title: get_str(row, "title"),
            description: get_opt_str(row, "description"),
            status: get_opt_str(row, "status").unwrap_or_else(|| "open".to_string()),
            priority: row.get::<Option<i32>, _>("priority").flatten(),
            issue_type: get_opt_str(row, "issue_type"),
            owner: get_opt_str(row, "owner"),
            created_at: get_opt_str(row, "created_at"),
            created_by: get_opt_str(row, "created_by"),
            updated_at: get_opt_str(row, "updated_at"),
            closed_at: get_opt_str(row, "closed_at"),
            close_reason: get_opt_str(row, "close_reason"),
            defer_until: get_opt_str(row, "defer_until"),
            design_doc: get_opt_str(row, "design"),
            parent_id: None,
            children: None,
            deps: None,
            relates_to: None,
            labels: None,
            comments: None,
            dependencies: None,
        })
        .collect())
}

/// Queries comments and merges them into beads.
async fn merge_comments(
    conn: &mut mysql_async::Conn,
    db_name: &str,
    mut beads: Vec<Bead>,
) -> Result<Vec<Bead>, DoltError> {
    let query = format!(
        "SELECT id, issue_id, author, text, \
         DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at \
         FROM `{}`.comments ORDER BY issue_id, id",
        db_name
    );
    let rows: Vec<Row> = conn
        .query(&query)
        .await
        .map_err(|e| DoltError::QueryFailed(format!("comments: {}", e)))?;

    let mut map: HashMap<String, Vec<Comment>> = HashMap::new();
    for row in &rows {
        let issue_id = get_str(row, "issue_id");
        map.entry(issue_id.clone()).or_default().push(Comment {
            id: get_str(row, "id"),
            issue_id,
            author: get_str(row, "author"),
            text: get_str(row, "text"),
            created_at: get_str(row, "created_at"),
        });
    }
    for bead in &mut beads {
        if let Some(comments) = map.remove(&bead.id) {
            bead.comments = Some(comments);
        }
    }
    Ok(beads)
}

/// Target column holding the depended-on issue id in bd ≥ 1.1.0 (Dolt schema v53).
const DEP_TARGET_COLUMN: &str = "depends_on_issue_id";
/// Target column name used by bd ≤ 1.0.x (Dolt schema ≤ v32).
const DEP_TARGET_COLUMN_LEGACY: &str = "depends_on_id";

/// Column layout of the `dependencies` table.
///
/// Migration 0041 (bd 1.1.0, Dolt schema v53) renamed `depends_on_id` to
/// `depends_on_issue_id`, added the alternative `depends_on_wisp_id` /
/// `depends_on_external` targets, and introduced a surrogate `id` primary key
/// that has no default and must therefore be supplied on INSERT.
#[derive(Debug, Clone, PartialEq)]
struct DependencySchema {
    /// Column holding the target issue id.
    target_column: String,
    /// Whether the table has the surrogate `id` primary key.
    has_surrogate_id: bool,
}

impl DependencySchema {
    /// Derives the layout from the table's column names.
    ///
    /// Falls back to the current (v53) layout when introspection yields nothing,
    /// so an unreadable `information_schema` never pins us to the dead column.
    fn from_columns(columns: &[String]) -> Self {
        let has = |name: &str| columns.iter().any(|c| c.eq_ignore_ascii_case(name));

        if !has(DEP_TARGET_COLUMN) && has(DEP_TARGET_COLUMN_LEGACY) {
            return Self {
                target_column: DEP_TARGET_COLUMN_LEGACY.to_string(),
                has_surrogate_id: has("id"),
            };
        }
        Self {
            target_column: DEP_TARGET_COLUMN.to_string(),
            has_surrogate_id: columns.is_empty() || has("id"),
        }
    }
}

/// Introspects the `dependencies` table layout of the given database.
async fn detect_dependency_schema(
    conn: &mut mysql_async::Conn,
    db_name: &str,
) -> DependencySchema {
    let query = "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = :db AND TABLE_NAME = 'dependencies'";
    let columns: Vec<String> = conn
        .exec_map(
            query,
            mysql_async::params! { "db" => db_name },
            |name: String| name,
        )
        .await
        .unwrap_or_else(|e| {
            warn!(
                "Failed to introspect dependencies schema for db {}: {} — assuming current layout",
                db_name, e
            );
            Vec::new()
        });
    DependencySchema::from_columns(&columns)
}

/// Queries dependencies and merges parent/blocking/related into beads.
async fn merge_dependencies(
    conn: &mut mysql_async::Conn,
    db_name: &str,
    beads: &mut [Bead],
) -> Result<(), DoltError> {
    let schema = detect_dependency_schema(conn, db_name).await;
    // Rows targeting a wisp or an external ref (v53+) have a NULL issue target
    // and are irrelevant to the board — filter them out in SQL.
    let query = format!(
        "SELECT issue_id, `{col}` AS depends_on, `type` FROM `{db}`.dependencies \
         WHERE `{col}` IS NOT NULL",
        col = schema.target_column,
        db = db_name
    );
    let rows: Vec<Row> = conn
        .query(&query)
        .await
        .map_err(|e| DoltError::QueryFailed(format!("dependencies: {}", e)))?;

    let mut parent_map: HashMap<String, String> = HashMap::new();
    let mut blocking_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut related_map: HashMap<String, Vec<String>> = HashMap::new();

    for row in &rows {
        let issue_id = get_str(row, "issue_id");
        let depends_on = get_str(row, "depends_on");
        match get_str(row, "type").as_str() {
            "parent-child" | "parent" => {
                parent_map.insert(issue_id, depends_on);
            }
            "relates-to" | "related" => {
                related_map.entry(issue_id).or_default().push(depends_on);
            }
            _ => {
                blocking_map.entry(issue_id).or_default().push(depends_on);
            }
        }
    }

    for bead in beads.iter_mut() {
        if let Some(pid) = parent_map.remove(&bead.id) {
            bead.parent_id = Some(pid);
        }
        if let Some(b) = blocking_map.remove(&bead.id) {
            bead.deps = Some(b);
        }
        if let Some(r) = related_map.remove(&bead.id) {
            bead.relates_to = Some(r);
        }
    }
    Ok(())
}

/// Folds raw `(issue_id, label)` rows into per-issue label lists.
///
/// Blank ids/labels and duplicates are dropped and each list is sorted, so the
/// board renders chips in a stable order whatever order the table returns.
pub(crate) fn fold_label_rows(rows: Vec<(String, String)>) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for (issue_id, label) in rows {
        let label = label.trim().to_string();
        if issue_id.is_empty() || label.is_empty() {
            continue;
        }
        let entry = map.entry(issue_id).or_default();
        if !entry.iter().any(|existing| existing == &label) {
            entry.push(label);
        }
    }
    for labels in map.values_mut() {
        labels.sort();
    }
    map
}

/// Queries labels and merges them into beads.
///
/// One query for the whole database, never one per card: `labels` is a flat
/// `(issue_id, label)` link table, so every chip on the board costs a single
/// round trip.
///
/// Never fails the read. A database whose schema predates the table (or an
/// unreadable one) must still render its beads — the error is logged and the
/// beads come back label-less.
async fn merge_labels(conn: &mut mysql_async::Conn, db_name: &str, beads: &mut [Bead]) {
    let query = format!(
        "SELECT issue_id, label FROM `{}`.labels ORDER BY issue_id, label",
        db_name
    );
    let rows: Vec<Row> = match conn.query(&query).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(
                "Failed to read labels for db {}: {} — beads render without labels",
                db_name, e
            );
            return;
        }
    };

    let pairs = rows
        .iter()
        .map(|row| (get_str(row, "issue_id"), get_str(row, "label")))
        .collect();
    let mut map = fold_label_rows(pairs);

    for bead in beads.iter_mut() {
        if let Some(labels) = map.remove(&bead.id) {
            bead.labels = Some(labels);
        }
    }
}

/// Runs `SELECT label, COUNT(*) … GROUP BY label` and returns the raw
/// `(label, count)` pairs — the project's label vocabulary, taken from the
/// data itself because beads keeps no dictionary table beside the link table.
///
/// A missing `labels` table yields an empty vocabulary instead of an error, for
/// the same reason [`merge_labels`] never fails a read.
async fn query_label_counts(
    conn: &mut mysql_async::Conn,
    db_name: &str,
) -> Result<Vec<(String, i64)>, DoltError> {
    // The database name is interpolated into the statement, so it must be
    // validated first — it can originate from project metadata on disk.
    validate_discovered_database_name(db_name)?;
    ensure_database_exists(conn, db_name).await?;

    let query = format!(
        "SELECT label, COUNT(*) AS cnt FROM `{}`.labels GROUP BY label",
        db_name
    );
    let rows: Vec<Row> = match conn.query(&query).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(
                "Failed to aggregate labels for db {}: {} — reporting no labels",
                db_name, e
            );
            return Ok(Vec::new());
        }
    };

    Ok(rows
        .iter()
        .map(|row| {
            let label = get_str(row, "label");
            let count = row.get::<i64, _>("cnt").unwrap_or(0);
            (label, count)
        })
        .collect())
}

/// Aggregates labels on a Dolt server listening on `port`.
///
/// Per-project counterpart of [`DoltManager::count_labels`], mirroring
/// [`count_issues_by_status_on_port`].
pub async fn count_labels_on_port(
    port: u16,
    db_name: &str,
) -> Result<Vec<(String, i64)>, DoltError> {
    let config = DoltConnectConfig::from_env();
    let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 2).unwrap());
    let opts = config.build_opts(Some(port), pool_opts);

    let pool = Pool::new(opts);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

    let result = query_label_counts(&mut conn, db_name).await;

    drop(conn);
    if let Err(e) = pool.disconnect().await {
        tracing::warn!("Failed to disconnect temporary pool (port {}): {}", port, e);
    }

    result
}

/// What slice of the event log to read.
///
/// `before`/`since` take the same ISO timestamps the API emits, so the client
/// pages by handing back a value it already has instead of counting offsets —
/// an offset would drift under a feed that grows while you read it.
#[derive(Debug, Clone, Default)]
pub struct ActivityQuery {
    /// Page size. Already clamped by the caller.
    pub limit: u32,
    /// Only events strictly older than this timestamp (paging backwards).
    pub before: Option<String>,
    /// Only events strictly newer than this timestamp (incremental refresh).
    pub since: Option<String>,
}

/// Reads one page of the event log, newest first, with bead titles resolved.
///
/// One query for the whole page: the title comes from a `LEFT JOIN` on `issues`
/// rather than a lookup per row, and the join is left so an event whose bead was
/// deleted or compacted still shows up instead of silently vanishing.
///
/// A database with no `events` table (older schema) yields an empty page. Any
/// other failure is propagated: an empty feed and a broken query look identical
/// on screen, so a real error must never be laundered into "nothing happened".
async fn query_activity(
    conn: &mut mysql_async::Conn,
    db_name: &str,
    query: &ActivityQuery,
) -> Result<Vec<RawActivityRow>, DoltError> {
    // The database name is interpolated into the statement, so it must be
    // validated first — it can originate from project metadata on disk.
    validate_discovered_database_name(db_name)?;
    ensure_database_exists(conn, db_name).await?;

    if !has_table(conn, db_name, "events").await {
        return Ok(Vec::new());
    }

    // Bounds are bound as parameters; only the validated database name and the
    // integer limit are interpolated.
    let mut conditions = Vec::new();
    if query.before.is_some() {
        conditions.push("e.created_at < :before");
    }
    if query.since.is_some() {
        conditions.push("e.created_at > :since");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT e.id, e.issue_id, i.title AS issue_title, e.event_type, e.actor, \
         e.new_value, e.comment, \
         DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at \
         FROM `{db}`.events e \
         LEFT JOIN `{db}`.issues i ON i.id = e.issue_id \
         {where_clause} \
         ORDER BY e.created_at DESC, e.id DESC \
         LIMIT {limit}",
        db = db_name,
        where_clause = where_clause,
        limit = query.limit
    );

    // Named params must match the statement exactly: handing mysql_async a
    // parameter the SQL never mentions fails with "Named params given where
    // positional params are expected", so an unfiltered page uses `query`.
    let mut named: Vec<(String, mysql_async::Value)> = Vec::new();
    if let Some(before) = &query.before {
        named.push(("before".to_string(), before.as_str().into()));
    }
    if let Some(since) = &query.since {
        named.push(("since".to_string(), since.as_str().into()));
    }

    let rows: Vec<Row> = if named.is_empty() {
        conn.query(&sql).await
    } else {
        conn.exec(&sql, mysql_async::Params::from(named)).await
    }
    .map_err(|e| DoltError::QueryFailed(format!("activity: {}", e)))?;

    Ok(rows
        .iter()
        .map(|row| RawActivityRow {
            id: get_str(row, "id"),
            issue_id: get_str(row, "issue_id"),
            issue_title: get_opt_str(row, "issue_title"),
            event_type: get_str(row, "event_type"),
            actor: get_str(row, "actor"),
            new_value: get_opt_str(row, "new_value"),
            comment: get_opt_str(row, "comment"),
            created_at: get_str(row, "created_at"),
        })
        .collect())
}

/// Reads the event log from a Dolt server listening on `port`.
///
/// Per-project counterpart of [`DoltManager::read_activity`].
pub async fn read_activity_on_port(
    port: u16,
    db_name: &str,
    query: &ActivityQuery,
) -> Result<Vec<RawActivityRow>, DoltError> {
    let config = DoltConnectConfig::from_env();
    let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 2).unwrap());
    let opts = config.build_opts(Some(port), pool_opts);

    let pool = Pool::new(opts);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| DoltError::ConnectionFailed(e.to_string()))?;

    let result = query_activity(&mut conn, db_name, query).await;

    drop(conn);
    if let Err(e) = pool.disconnect().await {
        tracing::warn!("Failed to disconnect temporary pool (port {}): {}", port, e);
    }

    result
}

/// A discovered Dolt database.
#[derive(Debug, serde::Serialize)]
pub struct DoltDatabase {
    /// Full database name (e.g. `beads_ai-photo-factory`)
    pub name: String,
    /// Derived project name (e.g. `ai-photo-factory`)
    pub project_name: String,
    /// Optional local checkout matched from the project registry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

/// Metadata from `.beads/metadata.json`.
#[derive(Debug, Deserialize)]
struct BeadsMetadata {
    #[serde(default)]
    backend: Option<String>,
    #[serde(default)]
    dolt_database: Option<String>,
}

/// Config from `.beads/config.yaml`.
#[derive(Debug, Deserialize)]
struct BeadsConfig {
    #[serde(default, rename = "issue-prefix")]
    issue_prefix: Option<String>,
}

/// Resolves the Dolt database name for a project path.
///
/// Checks `.beads/metadata.json` → `dolt_database` field first,
/// then falls back to `beads_` + issue-prefix from config.yaml.
/// Returns `None` if the project doesn't use Dolt backend.
pub fn database_name_for_project(project_path: &Path) -> Option<String> {
    // Try metadata.json first
    let metadata_path = project_path.join(".beads").join("metadata.json");
    if let Ok(contents) = std::fs::read_to_string(&metadata_path) {
        if let Ok(meta) = serde_json::from_str::<BeadsMetadata>(&contents) {
            // Only use Dolt if backend is explicitly "dolt"
            if meta.backend.as_deref() != Some("dolt") {
                return None;
            }
            if let Some(db_name) = meta.dolt_database {
                if !db_name.is_empty() {
                    return Some(db_name);
                }
            }
        }
    }

    // Fallback: beads_ + issue-prefix from config.yaml
    let config_path = project_path.join(".beads").join("config.yaml");
    if let Ok(contents) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_yaml::from_str::<BeadsConfig>(&contents) {
            if let Some(prefix) = config.issue_prefix {
                if !prefix.is_empty() {
                    return Some(format!("beads_{}", prefix));
                }
            }
        }
    }

    // Last resort: derive from directory name
    project_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|name| format!("beads_{}", name))
}

/// Каталоги, внутри которых проекта заведомо нет, а файлов очень много.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
];

/// Насколько глубоко от корня искать проекты. `~/GitHub/dimcoder` лежит на
/// первом уровне, `~/GitHub/MCP/umnico-mcp` — на втором; третий берётся про
/// запас, дальше цена обхода растёт быстрее пользы.
pub const PROJECT_SCAN_DEPTH: usize = 3;

/// Имя Dolt-базы, которое проект ОБЪЯВИЛ о себе в `.beads/`.
///
/// Отличие от [`database_name_for_project`] принципиальное, хотя функции
/// похожи. Та отвечает на вопрос «этот проект открыт — где его беды?» и в
/// крайнем случае конструирует имя из имени каталога. Здесь направление
/// обратное: по каталогу с диска решается, какой из существующих баз он
/// принадлежит, и догадка тут даёт ложную привязку — любая папка `tmp` стала
/// бы владельцем базы `beads_tmp`. Поэтому берётся только записанное.
fn declared_database_name(project_path: &Path) -> Option<String> {
    let metadata_path = project_path.join(".beads").join("metadata.json");
    if let Ok(contents) = std::fs::read_to_string(&metadata_path) {
        if let Ok(meta) = serde_json::from_str::<BeadsMetadata>(&contents) {
            if meta.backend.as_deref() != Some("dolt") {
                return None;
            }
            if let Some(db_name) = meta.dolt_database.filter(|n| !n.is_empty()) {
                return Some(db_name);
            }
        }
    }

    // Тот же запасной вариант, что и у database_name_for_project: bd называет
    // базу `beads_<issue-prefix>`, и это не догадка, а его собственное правило.
    let config_path = project_path.join(".beads").join("config.yaml");
    let contents = std::fs::read_to_string(&config_path).ok()?;
    let config = serde_yaml::from_str::<BeadsConfig>(&contents).ok()?;
    config
        .issue_prefix
        .filter(|p| !p.is_empty())
        .map(|prefix| format!("beads_{}", prefix))
}

/// Ключ каталога для сравнения путей между собой. На Windows регистр не
/// значим, на остальных системах — значим, и `Src` там законно отличается от
/// `src`.
fn visit_key(dir: &Path) -> String {
    let raw = dir.as_os_str().to_string_lossy().to_string();
    if cfg!(windows) {
        raw.to_lowercase()
    } else {
        raw
    }
}

/// Один ли это каталог — см. [`visit_key`] про регистр.
fn same_dir(a: &Path, b: &Path) -> bool {
    visit_key(a) == visit_key(b)
}

/// Корни, в которых имеет смысл искать репозитории на ЭТОЙ машине.
///
/// Первыми идут родители уже заведённых проектов: где лежит один репозиторий,
/// там лежат и остальные, и этот список не надо ниоткуда конфигурировать. Для
/// чистой машины, где в реестре ещё нет ни одного пути, добавлены типовые
/// каталоги — иначе первый же запуск на ноутбуке не нашёл бы ничего.
pub fn project_roots(known_project_paths: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let push = |candidate: PathBuf, roots: &mut Vec<PathBuf>| {
        // `~/GitHub` и `~/github` — на Windows один и тот же каталог, и без
        // сравнения без учёта регистра он попал бы в список дважды. Тогда путь
        // проекта уезжал бы в написании того корня, который обошли первым, и
        // расходился с тем, что уже записано в реестре.
        if candidate.is_dir() && !roots.iter().any(|root| same_dir(root, &candidate)) {
            roots.push(candidate);
        }
    };

    for path in known_project_paths {
        if path.starts_with(DOLT_PATH_PREFIX) {
            continue;
        }
        if let Some(parent) = Path::new(path).parent() {
            push(parent.to_path_buf(), &mut roots);
        }
    }

    if let Some(home) = directories::UserDirs::new().map(|d| d.home_dir().to_path_buf()) {
        for name in ["GitHub", "github", "src", "projects", "code", "dev", "repos", "git"] {
            push(home.join(name), &mut roots);
        }
    }

    roots
}

/// Насколько долго индекс локальных проектов считается свежим.
///
/// Индекс строится обходом диска, а спрашивают его на каждое открытие главной —
/// пересобирать его каждый раз незачем: репозитории не появляются чаще. Цена
/// задержки мала и понятна: только что созданный `bd init` виден в дашборде на
/// следующем опросе, а не мгновенно.
const INDEX_TTL: Duration = Duration::from_secs(60);

/// Кэш индекса локальных проектов.
///
/// Скан — синхронный обход файловой системы, поэтому он уезжает в blocking-пул:
/// в async-хендлере он занял бы воркер целиком. Мьютекс держится через `await`
/// намеренно — так параллельные запросы ждут один скан вместо того, чтобы
/// запускать свой.
pub struct LocalProjectIndex {
    cached: tokio::sync::Mutex<Option<CachedIndex>>,
}

struct CachedIndex {
    built_at: Instant,
    /// Корни, по которым индекс построен: список меняется вместе с реестром, и
    /// на других корнях прежний ответ уже не годится.
    roots: Vec<PathBuf>,
    entries: Arc<HashMap<String, PathBuf>>,
}

impl LocalProjectIndex {
    pub fn new() -> Self {
        Self {
            cached: tokio::sync::Mutex::new(None),
        }
    }

    /// Индекс не старше [`INDEX_TTL`], построенный по этим корням.
    pub async fn get(&self, roots: Vec<PathBuf>) -> Arc<HashMap<String, PathBuf>> {
        let mut guard = self.cached.lock().await;

        if let Some(cached) = guard.as_ref() {
            if cached.roots == roots && cached.built_at.elapsed() < INDEX_TTL {
                return Arc::clone(&cached.entries);
            }
        }

        let scan_roots = roots.clone();
        let entries = tokio::task::spawn_blocking(move || {
            index_local_projects(&scan_roots, PROJECT_SCAN_DEPTH)
        })
        .await
        .unwrap_or_else(|e| {
            warn!("Local project scan failed: {e}");
            HashMap::new()
        });

        let entries = Arc::new(entries);
        *guard = Some(CachedIndex {
            built_at: Instant::now(),
            roots,
            entries: Arc::clone(&entries),
        });
        entries
    }
}

impl Default for LocalProjectIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Индекс «имя Dolt-базы -> каталог проекта на этой машине».
///
/// Путь к репозиторию машинно-зависим, поэтому он нигде не хранится: ни в
/// git-репозитории, ни в самой базе — на другом ПК он был бы другим. Вместо
/// этого связь восстанавливается из того, что реально лежит на диске: у каждого
/// репозитория с бедами есть `.beads/`, где записано имя его базы.
pub fn index_local_projects(roots: &[PathBuf], max_depth: usize) -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, PathBuf> = HashMap::new();
    // Обход в ширину и с головы очереди: корни разобраны в том порядке, в
    // котором их вернул `project_roots`, где первыми идут каталоги уже
    // заведённых проектов. Порядок решает исход коллизии, поэтому он не должен
    // зависеть от того, как устроена очередь.
    let mut queue: VecDeque<(PathBuf, usize)> =
        roots.iter().map(|r| (r.clone(), 0usize)).collect();
    // Корни пересекаются штатно: `~/GitHub` и `~/GitHub/MCP` оба приходят как
    // родители заведённых проектов, и без этого вложенный каталог обходился бы
    // дважды. При обходе в ширину корень успевает попасть сюда раньше, чем до
    // него дойдёт родитель, так что приоритет корней не страдает.
    let mut visited: HashSet<String> = HashSet::new();

    while let Some((dir, depth)) = queue.pop_front() {
        if !visited.insert(visit_key(&dir)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };

        // read_dir не обещает порядок, а он решает исход коллизии: две копии
        // одного репозитория объявляют одну базу. Сортировка делает выбор
        // повторяемым, иначе привязка скакала бы между запусками.
        let mut children: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|entry| entry.path())
            .collect();
        children.sort();

        for child in children {
            let Some(name) = child.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Скрытые каталоги отсекают заодно и `.claude/worktrees/*`: worktree
            // несёт ту же `.beads/metadata.json`, что и основной checkout, и
            // претендовал бы на ту же базу.
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name) {
                continue;
            }

            if let Some(db_name) = declared_database_name(&child) {
                index.entry(db_name).or_insert(child);
                // Внутрь найденного проекта не спускаемся: вложенные checkout'ы
                // того же репозитория — не отдельные проекты.
                continue;
            }

            if depth + 1 < max_depth {
                queue.push_back((child, depth + 1));
            }
        }
    }

    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Тот же инвариант, что закреплён для `PasswordResolution` в `config.rs`:
    /// производный `Debug` напечатал бы пароль целиком, а
    /// `tracing::debug!("{:?}", config)` — слишком естественный способ
    /// незаметно добавить утечку в будущей правке.
    #[test]
    fn debug_output_never_contains_the_password_value() {
        let config = DoltConnectConfig {
            host: "dolt.example".to_string(),
            port: 3307,
            user: "beads".to_string(),
            password: Some("super-secret-value".to_string()),
        };

        let rendered = format!("{config:?}");

        assert!(
            !rendered.contains("super-secret-value"),
            "пароль утёк в Debug-вывод: {rendered}"
        );
        assert!(
            rendered.contains("<redacted>"),
            "факт наличия пароля должен оставаться видимым: {rendered}"
        );
        // остальные поля по-прежнему диагностируемы
        assert!(rendered.contains("dolt.example"));
        assert!(rendered.contains("beads"));
    }

    #[test]
    fn debug_output_distinguishes_absent_password() {
        let config = DoltConnectConfig {
            host: "127.0.0.1".to_string(),
            port: 3307,
            user: "root".to_string(),
            password: None,
        };

        let rendered = format!("{config:?}");

        assert!(rendered.contains("None"), "отсутствие пароля должно быть видно: {rendered}");
        assert!(!rendered.contains("<redacted>"));
    }

    // ── DependencySchema tests ─────────────────────────────────────────

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_dependency_schema_v53() {
        // bd 1.1.0 / Dolt schema v53: renamed target column + surrogate id PK
        let schema = DependencySchema::from_columns(&cols(&[
            "id",
            "issue_id",
            "type",
            "created_at",
            "created_by",
            "depends_on_issue_id",
            "depends_on_wisp_id",
            "depends_on_external",
        ]));
        assert_eq!(schema.target_column, "depends_on_issue_id");
        assert!(schema.has_surrogate_id);
    }

    #[test]
    fn test_dependency_schema_legacy_v32() {
        // Pre-migration schema: depends_on_id, composite PK (no `id` column)
        let schema = DependencySchema::from_columns(&cols(&[
            "issue_id",
            "depends_on_id",
            "type",
            "created_at",
            "created_by",
        ]));
        assert_eq!(schema.target_column, "depends_on_id");
        assert!(!schema.has_surrogate_id);
    }

    #[test]
    fn test_dependency_schema_defaults_to_current_when_unknown() {
        // Empty/unreadable introspection must not fall back to the dead column
        let schema = DependencySchema::from_columns(&[]);
        assert_eq!(schema.target_column, "depends_on_issue_id");
        assert!(schema.has_surrogate_id);
    }

    // ── database_name_for_project tests ─────────────────────────────────

    #[test]
    fn test_db_name_from_metadata_json() {
        // When metadata.json has backend=dolt and dolt_database set, use it
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("my-project");
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("metadata.json"),
            r#"{"backend": "dolt", "dolt_database": "beads_custom_name"}"#,
        )
        .unwrap();

        assert_eq!(
            database_name_for_project(&project),
            Some("beads_custom_name".to_string())
        );
    }

    #[test]
    fn test_db_name_non_dolt_backend_returns_none() {
        // When backend is not "dolt", return None even if dolt_database is set
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("my-project");
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("metadata.json"),
            r#"{"backend": "jsonl", "dolt_database": "beads_something"}"#,
        )
        .unwrap();

        assert_eq!(database_name_for_project(&project), None);
    }

    #[test]
    fn test_db_name_dolt_backend_empty_db_name_falls_through() {
        // backend=dolt but dolt_database is empty -> fall through to config.yaml
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("my-project");
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("metadata.json"),
            r#"{"backend": "dolt", "dolt_database": ""}"#,
        )
        .unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "issue-prefix: cool-project\n",
        )
        .unwrap();

        assert_eq!(
            database_name_for_project(&project),
            Some("beads_cool-project".to_string())
        );
    }

    #[test]
    fn fold_label_rows_groups_sorts_and_dedupes() {
        let map = fold_label_rows(vec![
            ("a".to_string(), "tooling".to_string()),
            ("a".to_string(), "agent-ux".to_string()),
            ("a".to_string(), "tooling".to_string()),
            ("b".to_string(), " night-ok ".to_string()),
        ]);

        assert_eq!(map["a"], vec!["agent-ux".to_string(), "tooling".to_string()]);
        // Whitespace around a label is storage noise, not part of its name.
        assert_eq!(map["b"], vec!["night-ok".to_string()]);
    }

    #[test]
    fn fold_label_rows_skips_blank_ids_and_labels() {
        let map = fold_label_rows(vec![
            ("".to_string(), "tooling".to_string()),
            ("a".to_string(), "   ".to_string()),
        ]);

        assert!(map.is_empty());
    }

    #[test]
    fn test_db_name_from_config_yaml_issue_prefix() {
        // No metadata.json, but config.yaml has issue-prefix
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("my-project");
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "issue-prefix: ai-photo-factory\n",
        )
        .unwrap();

        assert_eq!(
            database_name_for_project(&project),
            Some("beads_ai-photo-factory".to_string())
        );
    }

    #[test]
    fn test_db_name_from_directory_name_fallback() {
        // No metadata.json, no config.yaml -> derive from directory name
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("awesome-app");
        std::fs::create_dir_all(&project).unwrap();

        assert_eq!(
            database_name_for_project(&project),
            Some("beads_awesome-app".to_string())
        );
    }

    #[test]
    fn test_db_name_empty_issue_prefix_falls_through() {
        // config.yaml with empty issue-prefix -> fall through to directory name
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("fallback-dir");
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(beads_dir.join("config.yaml"), "issue-prefix: \"\"\n").unwrap();

        assert_eq!(
            database_name_for_project(&project),
            Some("beads_fallback-dir".to_string())
        );
    }

    #[test]
    fn test_db_name_root_path_returns_none() {
        // Root path has no file_name() -> returns None
        let root = PathBuf::from("/");
        // Root path: file_name() returns None on Unix-style roots
        // On Windows this may differ, so we test the logic directly
        if root.file_name().is_none() {
            assert_eq!(database_name_for_project(&root), None);
        }
    }

    // ── DoltDatabase serialization test ─────────────────────────────────

    #[test]
    fn test_dolt_database_serializes_correctly() {
        let db = DoltDatabase {
            name: "beads_ai-photo-factory".to_string(),
            project_name: "ai-photo-factory".to_string(),
            local_path: None,
        };

        let json = serde_json::to_string(&db).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["name"], "beads_ai-photo-factory");
        assert_eq!(parsed["project_name"], "ai-photo-factory");
    }

    #[test]
    fn test_dolt_database_serializes_both_fields() {
        let db = DoltDatabase {
            name: "beads_test".to_string(),
            project_name: "test".to_string(),
            local_path: Some("/repos/test".to_string()),
        };

        let json = serde_json::to_string(&db).unwrap();
        // Verify both fields are present
        assert!(json.contains("\"name\""));
        assert!(json.contains("\"project_name\""));
        assert!(json.contains("\"local_path\""));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj.len(), 3);
    }

    #[test]
    fn test_database_name_validation() {
        assert!(validate_database_name("tvp").is_ok());
        assert!(validate_database_name("_my_llm_skills_agents").is_ok());
        assert!(validate_database_name("tvp`; DROP DATABASE tvp; --").is_err());
        assert!(validate_database_name("").is_err());
    }

    #[test]
    fn test_database_name_allows_hyphen() {
        // Discovery surfaces hyphenated databases (`beads_ai-photo-factory`), and
        // read_beads/issue_prefix run the same name through this validator —
        // rejecting `-` here made those paths fail on such a database (bweb-489.14).
        assert!(validate_database_name("beads_ai-photo-factory").is_ok());
        assert!(validate_database_name("a-b-c").is_ok());
    }

    #[test]
    fn test_database_name_rejects_injection_attempts() {
        // A hyphen is inert inside the backticks of USE `{}`; a backtick is not,
        // so it must stay rejected even though `-` is now allowed.
        assert!(validate_database_name("tvp`; DROP DATABASE tvp; --").is_err());
        assert!(validate_database_name("a b").is_err());
        assert!(validate_database_name("a;b").is_err());
        assert!(validate_database_name("a/b").is_err());
    }

    #[test]
    fn test_discovered_database_name_allows_hyphen() {
        assert!(validate_discovered_database_name("beads_ai-photo-factory").is_ok());
        assert!(validate_discovered_database_name("tvp").is_ok());
    }

    #[test]
    fn test_discovered_database_name_rejects_injection() {
        assert!(validate_discovered_database_name("tvp`; DROP DATABASE tvp; --").is_err());
        assert!(validate_discovered_database_name("a b").is_err());
        assert!(validate_discovered_database_name("").is_err());
    }

    /// Заводит каталог проекта с `.beads/metadata.json` на указанную базу.
    fn make_project(root: &Path, rel: &str, database: &str) -> PathBuf {
        let dir = root.join(rel);
        std::fs::create_dir_all(dir.join(".beads")).unwrap();
        std::fs::write(
            dir.join(".beads").join("metadata.json"),
            format!(
                r#"{{"database":"dolt","backend":"dolt","dolt_mode":"server","dolt_database":"{database}"}}"#
            ),
        )
        .unwrap();
        dir
    }

    #[test]
    fn index_matches_by_declared_database_not_by_folder_name() {
        // Ровно тот случай, ради которого индекс и нужен: имя базы и имя папки
        // расходятся (skyrem лежит в skycomm-reminders, sbc — в sberbusiness_client).
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let skyrem = make_project(root, "skycomm-reminders", "skyrem");
        let sbc = make_project(root, "sberbusiness_client", "sbc");

        let index = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert_eq!(index.get("skyrem"), Some(&skyrem));
        assert_eq!(index.get("sbc"), Some(&sbc));
        assert_eq!(index.get("skycomm-reminders"), None);
    }

    #[test]
    fn index_finds_projects_nested_below_the_root() {
        // ~/GitHub/MCP/umnico-mcp — второй уровень, такие в реестре есть.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let nested = make_project(root, "MCP/umnico-mcp", "umnico");

        let index = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert_eq!(index.get("umnico"), Some(&nested));
    }

    #[test]
    fn index_ignores_folder_without_beads_metadata() {
        // Пустая папка `tmp` не должна становиться владельцем базы `tmp`:
        // именно так выглядела бы догадка по имени каталога.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("tmp")).unwrap();

        let index = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert!(index.is_empty());
    }

    #[test]
    fn index_skips_hidden_dirs_so_worktrees_do_not_claim_the_database() {
        // Worktree несёт ту же metadata.json, что и основной checkout.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let main = make_project(root, "forum_match_vibe", "fmv");
        make_project(root, "forum_match_vibe/.claude/worktrees/wt-1", "fmv");

        let index = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert_eq!(index.get("fmv"), Some(&main));
    }

    #[test]
    fn index_does_not_descend_into_skipped_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        make_project(root, "node_modules/some-package", "hijacked");

        let index = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert!(index.is_empty());
    }

    #[test]
    fn index_collision_is_stable_across_runs() {
        // Две копии одного репозитория объявляют одну базу — выбор не должен
        // зависеть от порядка, в котором ОС вернула записи каталога.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        make_project(root, "a-copy", "dup");
        make_project(root, "b-copy", "dup");

        let first = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);
        let second = index_local_projects(&[root.to_path_buf()], PROJECT_SCAN_DEPTH);

        assert_eq!(first.get("dup"), second.get("dup"));
        assert_eq!(first.get("dup"), Some(&root.join("a-copy")));
    }

    #[test]
    fn declared_name_ignores_non_dolt_backend() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("sqlite-project");
        std::fs::create_dir_all(dir.join(".beads")).unwrap();
        std::fs::write(
            dir.join(".beads").join("metadata.json"),
            r#"{"backend":"sqlite","dolt_database":"whatever"}"#,
        )
        .unwrap();

        assert_eq!(declared_database_name(&dir), None);
    }

    #[test]
    fn declared_name_falls_back_to_issue_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("prefixed");
        std::fs::create_dir_all(dir.join(".beads")).unwrap();
        std::fs::write(
            dir.join(".beads").join("config.yaml"),
            "issue-prefix: \"myproj\"\n",
        )
        .unwrap();

        assert_eq!(
            declared_database_name(&dir),
            Some("beads_myproj".to_string())
        );
    }

    #[test]
    fn index_visits_an_overlapping_root_only_once() {
        // `~/GitHub` и `~/GitHub/MCP` оба приходят как родители заведённых
        // проектов. Вложенный корень не должен обходиться дважды, а проект
        // внутри него — находиться по-прежнему.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let nested = make_project(root, "MCP/umnico-mcp", "umnico");

        let index = index_local_projects(
            &[root.to_path_buf(), root.join("MCP")],
            PROJECT_SCAN_DEPTH,
        );

        assert_eq!(index.get("umnico"), Some(&nested));
        assert_eq!(index.len(), 1);
    }

    #[tokio::test]
    async fn cached_index_is_not_rebuilt_within_the_ttl() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        make_project(&root, "first", "one");

        let cache = LocalProjectIndex::new();
        let before = cache.get(vec![root.clone()]).await;
        assert_eq!(before.len(), 1);

        // Появившийся после сборки проект попадёт в индекс только со следующим
        // сканом — ровно та задержка, которой оплачен отказ от скана на каждый
        // запрос.
        make_project(&root, "second", "two");
        let after = cache.get(vec![root.clone()]).await;
        assert_eq!(after.len(), 1);
        assert!(Arc::ptr_eq(&before, &after));
    }

    #[tokio::test]
    async fn cached_index_is_rebuilt_when_the_roots_change() {
        let temp = tempfile::tempdir().unwrap();
        let first_root = temp.path().join("a");
        let second_root = temp.path().join("b");
        make_project(&first_root, "repo", "one");
        make_project(&second_root, "repo", "two");

        let cache = LocalProjectIndex::new();
        let first = cache.get(vec![first_root]).await;
        assert!(first.contains_key("one"));

        // Реестр изменился — прежний ответ построен не по тем корням.
        let second = cache.get(vec![second_root]).await;
        assert!(second.contains_key("two"));
        assert!(!second.contains_key("one"));
    }

    #[test]
    fn index_prefers_the_root_listed_first() {
        // Порядок корней — это приоритет: каталоги уже заведённых проектов идут
        // раньше типовых, и найденное в них не должно перебиваться.
        let temp = tempfile::tempdir().unwrap();
        let preferred = make_project(&temp.path().join("first"), "repo", "shared");
        make_project(&temp.path().join("second"), "repo", "shared");

        let index = index_local_projects(
            &[temp.path().join("first"), temp.path().join("second")],
            PROJECT_SCAN_DEPTH,
        );

        assert_eq!(index.get("shared"), Some(&preferred));
    }

    #[test]
    fn project_roots_take_parents_of_known_projects_and_skip_dolt_urls() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("GitHub/dimcoder")).unwrap();
        std::fs::create_dir_all(root.join("GitHub/MCP/umnico-mcp")).unwrap();

        let known = vec![
            root.join("GitHub/dimcoder").to_string_lossy().to_string(),
            root.join("GitHub/MCP/umnico-mcp")
                .to_string_lossy()
                .to_string(),
            "dolt://orphan".to_string(),
        ];
        let roots = project_roots(&known);

        assert!(roots.contains(&root.join("GitHub")));
        assert!(roots.contains(&root.join("GitHub/MCP")));
        // `dolt://orphan` не путь — родителя у него нет и быть не должно.
        assert!(!roots.iter().any(|r| r.to_string_lossy().contains("dolt:")));
    }

    #[test]
    #[cfg(windows)]
    fn project_roots_do_not_list_the_same_dir_twice_in_another_case() {
        // На Windows `GitHub` и `github` — один каталог: попади он в список
        // дважды, путь проекта уехал бы в написании обойденного первым.
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("GitHub/dimcoder")).unwrap();

        let known = vec![
            temp.path()
                .join("GitHub/dimcoder")
                .to_string_lossy()
                .to_string(),
            temp.path()
                .join("github/dimcoder")
                .to_string_lossy()
                .to_string(),
        ];
        let roots = project_roots(&known);

        // Реальный `~/GitHub` этой машины тоже попадает в список как типовой
        // корень, поэтому считаем только то, что лежит внутри temp.
        let prefix = temp.path().to_string_lossy().to_lowercase();
        let matching = roots
            .iter()
            .filter(|r| r.to_string_lossy().to_lowercase().starts_with(&prefix))
            .count();
        assert_eq!(matching, 1);
        assert!(roots.contains(&temp.path().join("GitHub")));
    }
}
