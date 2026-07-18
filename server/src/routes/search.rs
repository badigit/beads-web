//! Global cross-project search over every Direct Dolt database.
//!
//! `GET /api/search?q=<text>` runs a case-insensitive substring match over
//! `id` and `title` in every discovered Beads database, merges the hits into a
//! single ranked list and annotates each hit with the local project id so the
//! frontend can navigate to `/project?id=...`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::{Extension, Query},
    response::IntoResponse,
    Json,
};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::dolt::{self, DoltManager, SearchRow};

/// Maximum number of results returned across all projects.
const RESULT_LIMIT: usize = 50;

/// Per-database row cap — the global limit is applied again after ranking.
const PER_DATABASE_LIMIT: u32 = 50;

/// Minimum query length (in characters) before the databases are touched.
const MIN_QUERY_CHARS: usize = 2;

/// How many databases are queried concurrently (pool holds up to 4 connections).
const MAX_CONCURRENCY: usize = 4;

/// Query parameters for `GET /api/search`.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    pub q: String,
}

/// A single search hit, ready for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchResult {
    /// Project id from the local SQLite registry (`/project?id=...`).
    /// `None` when the Dolt database is not registered as a project.
    pub project_id: Option<String>,
    /// Project display name, falling back to the Dolt database name.
    pub project_name: String,
    /// Dolt database the hit came from.
    pub database: String,
    /// Full bead id (`prefix-suffix`), globally unique.
    pub bead_id: String,
    pub title: String,
    pub status: String,
}

/// Normalizes a raw `q` parameter into a lowercase search term.
///
/// Returns `None` when the query is blank or shorter than [`MIN_QUERY_CHARS`],
/// which short-circuits the handler before any database work.
fn normalize_query(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() < MIN_QUERY_CHARS {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// Escapes SQL `LIKE` wildcards so user input is matched literally.
fn escape_like(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// Scores a hit: lower is better.
///
/// 0 — exact id match, 1 — id prefix, 2 — id substring, 3 — title substring.
/// Returns `None` when neither field matches (defensive; the SQL already filters).
fn rank_of(query: &str, bead_id: &str, title: &str) -> Option<u8> {
    let id = bead_id.to_lowercase();
    if id == query {
        return Some(0);
    }
    if id.starts_with(query) {
        return Some(1);
    }
    if id.contains(query) {
        return Some(2);
    }
    if title.to_lowercase().contains(query) {
        return Some(3);
    }
    None
}

/// Sorts hits by rank (then bead id for stability) and truncates to `limit`.
fn rank_and_truncate(query: &str, results: Vec<SearchResult>, limit: usize) -> Vec<SearchResult> {
    let mut ranked: Vec<(u8, SearchResult)> = results
        .into_iter()
        .filter_map(|result| {
            rank_of(query, &result.bead_id, &result.title).map(|rank| (rank, result))
        })
        .collect();

    ranked.sort_by(|(left_rank, left), (right_rank, right)| {
        left_rank
            .cmp(right_rank)
            .then_with(|| left.bead_id.cmp(&right.bead_id))
    });

    ranked
        .into_iter()
        .take(limit)
        .map(|(_, result)| result)
        .collect()
}

/// Maps Dolt database name → (project id, project name) from the local registry.
///
/// Projects are ordered by `last_opened DESC`, so if two registry entries point
/// at the same database the most recently opened one wins.
fn build_project_index(db: &Database) -> HashMap<String, (String, String)> {
    let projects = match db.get_projects_filtered(true) {
        Ok(projects) => projects,
        Err(e) => {
            tracing::warn!(error = %e, "Global search: project registry unavailable");
            return HashMap::new();
        }
    };

    let mut index = HashMap::new();
    for project in projects {
        let database = match project.path.strip_prefix("dolt://") {
            Some(name) => Some(name.to_string()),
            None => dolt::database_name_for_project(Path::new(&project.path)),
        };
        if let Some(name) = database {
            index.entry(name).or_insert((project.id, project.name));
        }
    }
    index
}

/// Queries every database concurrently; a failing database is skipped, not fatal.
async fn search_all_databases(
    dolt: Arc<DoltManager>,
    databases: Vec<String>,
    pattern: String,
) -> Vec<(String, Vec<SearchRow>)> {
    stream::iter(databases.into_iter().map(move |database| {
        let dolt = Arc::clone(&dolt);
        let pattern = pattern.clone();
        async move {
            match dolt
                .search_issues(&database, &pattern, PER_DATABASE_LIMIT)
                .await
            {
                Ok(rows) => Some((database, rows)),
                Err(e) => {
                    tracing::warn!(
                        database = %database,
                        error = %e,
                        "Global search: skipping database"
                    );
                    None
                }
            }
        }
    }))
    .buffer_unordered(MAX_CONCURRENCY)
    .filter_map(|hit| async move { hit })
    .collect()
    .await
}

/// Turns raw per-database rows into results annotated with project identity.
fn to_results(
    hits: Vec<(String, Vec<SearchRow>)>,
    projects: &HashMap<String, (String, String)>,
) -> Vec<SearchResult> {
    let mut results = Vec::new();
    for (database, rows) in hits {
        let project = projects.get(&database);
        for row in rows {
            results.push(SearchResult {
                project_id: project.map(|(id, _)| id.clone()),
                project_name: project
                    .map(|(_, name)| name.clone())
                    .unwrap_or_else(|| database.clone()),
                database: database.clone(),
                bead_id: row.id,
                title: row.title,
                status: row.status,
            });
        }
    }
    results
}

/// GET /api/search?q=<text>
///
/// Returns up to [`RESULT_LIMIT`] ranked hits from all Dolt projects.
/// Never fails hard: an unreachable server or a broken database yields an
/// empty (or partial) array rather than an error status.
pub async fn global_search(
    Query(params): Query<SearchParams>,
    Extension(dolt): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
) -> impl IntoResponse {
    let started = Instant::now();
    let query = match normalize_query(&params.q) {
        Some(query) => query,
        None => return Json(Vec::<SearchResult>::new()),
    };
    let query_chars = query.chars().count();

    if !dolt.is_available() && !dolt.check_server().await {
        tracing::warn!(query_chars, "Global search skipped: Dolt server unavailable");
        return Json(Vec::new());
    }

    let databases = match dolt.discover_databases().await {
        Ok(databases) => databases,
        Err(e) => {
            tracing::error!(query_chars, error = %e, "Global search: discovery failed");
            return Json(Vec::new());
        }
    };

    let pattern = format!("%{}%", escape_like(&query));
    let database_count = databases.len();
    let names: Vec<String> = databases.into_iter().map(|db| db.name).collect();
    let hits = search_all_databases(Arc::clone(&dolt), names, pattern).await;
    let searched = hits.len();
    let results = to_results(hits, &build_project_index(&db));
    let matched = results.len();
    let ranked = rank_and_truncate(&query, results, RESULT_LIMIT);

    tracing::info!(
        query_chars,
        databases = database_count,
        databases_searched = searched,
        matched,
        returned = ranked.len(),
        duration_ms = started.elapsed().as_millis() as u64,
        "Global search completed"
    );
    Json(ranked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(bead_id: &str, title: &str) -> SearchResult {
        SearchResult {
            project_id: Some("p1".to_string()),
            project_name: "proj".to_string(),
            database: "beads_proj".to_string(),
            bead_id: bead_id.to_string(),
            title: title.to_string(),
            status: "open".to_string(),
        }
    }

    // ── normalize_query ─────────────────────────────────────────────────

    #[test]
    fn test_normalize_query_rejects_empty() {
        assert_eq!(normalize_query(""), None);
        assert_eq!(normalize_query("   "), None);
    }

    #[test]
    fn test_normalize_query_rejects_single_char() {
        assert_eq!(normalize_query("a"), None);
        assert_eq!(normalize_query("  x  "), None);
    }

    #[test]
    fn test_normalize_query_trims_and_lowercases() {
        assert_eq!(normalize_query("  BWEB-489 "), Some("bweb-489".to_string()));
    }

    #[test]
    fn test_normalize_query_counts_characters_not_bytes() {
        // Two Cyrillic characters are 4 bytes but a valid 2-character query
        assert_eq!(normalize_query("ЛК"), Some("лк".to_string()));
    }

    // ── escape_like ─────────────────────────────────────────────────────

    #[test]
    fn test_escape_like_escapes_wildcards() {
        assert_eq!(escape_like("a_b%c"), r"a\_b\%c");
    }

    #[test]
    fn test_escape_like_escapes_backslash() {
        assert_eq!(escape_like(r"a\b"), r"a\\b");
    }

    #[test]
    fn test_escape_like_leaves_plain_text_untouched() {
        assert_eq!(escape_like("bweb-489.12"), "bweb-489.12");
    }

    // ── rank_of ─────────────────────────────────────────────────────────

    #[test]
    fn test_rank_exact_id_match_wins() {
        assert_eq!(rank_of("bweb-489", "bweb-489", "something"), Some(0));
    }

    #[test]
    fn test_rank_id_prefix() {
        assert_eq!(rank_of("bweb-489", "bweb-489.12", "something"), Some(1));
    }

    #[test]
    fn test_rank_id_substring() {
        assert_eq!(rank_of("489", "bweb-489.12", "something"), Some(2));
    }

    #[test]
    fn test_rank_title_substring() {
        assert_eq!(rank_of("search", "bweb-1", "Global search"), Some(3));
    }

    #[test]
    fn test_rank_is_case_insensitive_on_row_values() {
        assert_eq!(rank_of("bweb-489", "BWEB-489", "x"), Some(0));
        assert_eq!(rank_of("global", "bweb-1", "GLOBAL search"), Some(3));
    }

    #[test]
    fn test_rank_no_match_returns_none() {
        assert_eq!(rank_of("zzz", "bweb-1", "Global search"), None);
    }

    // ── rank_and_truncate ───────────────────────────────────────────────

    #[test]
    fn test_rank_and_truncate_orders_by_rank() {
        let input = vec![
            result("bweb-1", "mentions 489 in title"),
            result("other-489-x", "irrelevant"),
            result("bweb-489", "exact"),
            result("bweb-489.12", "prefix"),
        ];
        let ordered = rank_and_truncate("bweb-489", input, 10);
        let ids: Vec<&str> = ordered.iter().map(|r| r.bead_id.as_str()).collect();
        assert_eq!(ids, vec!["bweb-489", "bweb-489.12"]);
    }

    #[test]
    fn test_rank_and_truncate_ties_sort_by_bead_id() {
        let input = vec![
            result("bweb-489.9", "prefix"),
            result("bweb-489.1", "prefix"),
        ];
        let ordered = rank_and_truncate("bweb-489", input, 10);
        assert_eq!(ordered[0].bead_id, "bweb-489.1");
    }

    #[test]
    fn test_rank_and_truncate_applies_limit() {
        let input: Vec<SearchResult> = (0..80)
            .map(|i| result(&format!("bweb-{:03}", i), "t"))
            .collect();
        assert_eq!(rank_and_truncate("bweb", input, RESULT_LIMIT).len(), 50);
    }

    #[test]
    fn test_rank_and_truncate_drops_non_matching_rows() {
        let input = vec![result("other-1", "unrelated")];
        assert!(rank_and_truncate("bweb", input, 10).is_empty());
    }
}
