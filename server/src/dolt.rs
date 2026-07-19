//! Dolt database connection manager.
//!
//! Provides direct MySQL connection to Dolt for reading beads data,
//! with database discovery via `SHOW DATABASES`.

use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, TxOpts};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::routes::beads::{Bead, Comment};

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
        }
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

/// Like [`validate_database_name`], but also accepts `-`, which occurs in
/// discovered database names such as `beads_ai-photo-factory`.
fn validate_discovered_database_name(db_name: &str) -> Result<(), DoltError> {
    if db_name.is_empty()
        || !db_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(DoltError::DatabaseNotFound(db_name.to_string()));
    }
    Ok(())
}

fn validate_database_name(db_name: &str) -> Result<(), DoltError> {
    if db_name.is_empty()
        || !db_name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err(DoltError::DatabaseNotFound(db_name.to_string()));
    }
    Ok(())
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
    // Check database exists
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

    let beads = query_issues(conn, db_name).await?;
    let mut beads = merge_comments(conn, db_name, beads).await?;
    merge_dependencies(conn, db_name, &mut beads).await?;
    Ok(beads)
}

/// Helper to safely get nullable string columns from a MySQL row.
fn get_opt_str(row: &Row, col: &str) -> Option<String> {
    row.get::<Option<String>, _>(col).flatten()
}

fn get_str(row: &Row, col: &str) -> String {
    get_opt_str(row, col).unwrap_or_default()
}

/// Queries issues from a Dolt database.
async fn query_issues(conn: &mut mysql_async::Conn, db_name: &str) -> Result<Vec<Bead>, DoltError> {
    let query = format!(
        "SELECT id, title, description, `design`, status, priority, issue_type, \
         owner, assignee, \
         DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at, \
         created_by, \
         DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at, \
         DATE_FORMAT(closed_at, '%Y-%m-%dT%H:%i:%sZ') AS closed_at, \
         close_reason \
         FROM `{}`.issues",
        db_name
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
            design_doc: get_opt_str(row, "design"),
            parent_id: None,
            children: None,
            deps: None,
            relates_to: None,
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
            host: "10.9.0.105".to_string(),
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
        assert!(rendered.contains("10.9.0.105"));
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
}
