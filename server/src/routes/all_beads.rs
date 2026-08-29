//! Cross-project bead grid.
//!
//! One table over every beads database, so the state of thirty projects can be
//! read without opening thirty boards. The per-project board answers "what is
//! in this project"; this answers "what is open anywhere".

use axum::{
    extract::{Extension, Query},
    response::IntoResponse,
    Json,
};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use super::search::build_project_index;
use crate::db::Database;
use crate::dolt::DoltManager;

/// How many databases are read concurrently — the shared pool holds four.
const MAX_CONCURRENCY: usize = 4;

/// Rows per database before the merge, and the ceiling for the merged page.
///
/// Both are bounded on purpose: a grid is read screen by screen, and "every
/// bead of every project" is a download, not a view.
const DEFAULT_LIMIT: u32 = 500;
const MAX_LIMIT: u32 = 2000;

/// Query parameters for `GET /api/beads/all`.
///
/// Repeated values arrive comma-separated (`status=open,in_progress`) — the
/// grid builds them from checkbox groups and one parameter per filter keeps the
/// URL readable.
#[derive(Debug, Deserialize, Default)]
pub struct AllBeadsParams {
    pub status: Option<String>,
    pub priority: Option<String>,
    pub label: Option<String>,
    pub limit: Option<u32>,
}

/// What slice of the issue tables to read.
#[derive(Debug, Clone, Default)]
pub struct IssueQuery {
    pub statuses: Vec<String>,
    pub priorities: Vec<i32>,
    /// OR semantics: a bead qualifies when it carries any of these labels.
    pub labels: Vec<String>,
    pub limit: u32,
}

/// One row of the grid.
///
/// No `description`, `design` or `notes`: the grid shows a line per bead, and
/// the long text is what makes a full read expensive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IssueRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: Option<i32>,
    pub issue_type: Option<String>,
    pub owner: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}

/// Splits `open,in_progress` into values, dropping blanks.
pub(crate) fn split_values(raw: Option<&str>) -> Vec<String> {
    raw.map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// Same split for priorities, ignoring anything that is not a number.
pub(crate) fn split_priorities(raw: Option<&str>) -> Vec<i32> {
    split_values(raw)
        .into_iter()
        .filter_map(|value| value.parse::<i32>().ok())
        .collect()
}

/// Normalizes a requested page size into the served one.
pub(crate) fn resolve_limit(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// Merges per-database pages into one grid page, freshest first.
///
/// Each database contributed its own newest rows, so the merge has to sort
/// again: "the 500 most recently touched beads" is not the concatenation of
/// per-project pages. Ties break on id so the order is stable between loads.
pub(crate) fn merge_rows(pages: Vec<Vec<IssueRow>>, limit: usize) -> Vec<IssueRow> {
    let mut merged: Vec<IssueRow> = pages.into_iter().flatten().collect();
    merged.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    merged.truncate(limit);
    merged
}

/// GET /api/beads/all?status=&priority=&label=&limit=
///
/// The whole workspace as one list. Never fails hard: an unreachable server or
/// a broken database yields a partial grid rather than an error status, exactly
/// like the global search and the activity feed.
pub async fn read_all_beads(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<AllBeadsParams>,
) -> impl IntoResponse {
    let limit = resolve_limit(params.limit);
    let query = IssueQuery {
        statuses: split_values(params.status.as_deref()),
        priorities: split_priorities(params.priority.as_deref()),
        labels: split_values(params.label.as_deref()),
        limit,
    };

    if !dolt_manager.is_available() && !dolt_manager.check_server().await {
        tracing::warn!("Cross-project grid skipped: Dolt server unavailable");
        return Json(serde_json::json!({ "beads": [], "source": "unavailable" }));
    }

    let databases = match dolt_manager.discover_databases().await {
        Ok(databases) => databases,
        Err(e) => {
            tracing::error!(error = %e, "Cross-project grid: discovery failed");
            return Json(serde_json::json!({ "beads": [], "source": "unavailable" }));
        }
    };

    let database_count = databases.len();
    let names: Vec<String> = databases.into_iter().map(|entry| entry.name).collect();
    let projects = build_project_index(&db);
    let pages = read_every_database(Arc::clone(&dolt_manager), names, query, &projects).await;
    let read = pages.len();
    let beads = merge_rows(pages, limit as usize);

    tracing::info!(
        databases = database_count,
        databases_read = read,
        beads = beads.len(),
        "Cross-project grid"
    );

    Json(serde_json::json!({ "beads": beads, "source": "dolt-central" }))
}

/// Reads every database concurrently; a failing one is skipped, not fatal.
async fn read_every_database(
    dolt_manager: Arc<DoltManager>,
    databases: Vec<String>,
    query: IssueQuery,
    projects: &HashMap<String, (String, String)>,
) -> Vec<Vec<IssueRow>> {
    stream::iter(databases.into_iter().map(|database| {
        let dolt_manager = Arc::clone(&dolt_manager);
        let query = query.clone();
        let project = projects.get(&database).cloned();
        async move {
            match dolt_manager.read_issue_rows(&database, &query).await {
                Ok(rows) => {
                    let (project_id, project_name) = match project {
                        Some((id, name)) => (Some(id), Some(name)),
                        // A database with no registry entry still belongs
                        // somewhere: name it after itself rather than blank.
                        None => (None, Some(database.clone())),
                    };
                    Some(
                        rows.into_iter()
                            .map(|row| IssueRow {
                                project_id: project_id.clone(),
                                project_name: project_name.clone(),
                                ..row
                            })
                            .collect::<Vec<_>>(),
                    )
                }
                Err(e) => {
                    tracing::warn!(
                        database = %database,
                        error = %e,
                        "Cross-project grid: skipping database"
                    );
                    None
                }
            }
        }
    }))
    .buffer_unordered(MAX_CONCURRENCY)
    .filter_map(|page| async move { page })
    .collect()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, updated_at: &str) -> IssueRow {
        IssueRow {
            id: id.to_string(),
            title: "T".to_string(),
            status: "open".to_string(),
            priority: Some(1),
            issue_type: Some("task".to_string()),
            owner: None,
            created_at: None,
            updated_at: Some(updated_at.to_string()),
            labels: Vec::new(),
            project_id: None,
            project_name: None,
        }
    }

    #[test]
    fn filters_arrive_comma_separated() {
        assert_eq!(
            split_values(Some("open, in_progress ,")),
            vec!["open".to_string(), "in_progress".to_string()]
        );
        assert!(split_values(None).is_empty());
        assert!(split_values(Some(" , ")).is_empty());
    }

    #[test]
    fn priorities_ignore_anything_that_is_not_a_number() {
        assert_eq!(split_priorities(Some("0,1,высокий,2")), vec![0, 1, 2]);
    }

    #[test]
    fn limit_is_clamped_to_a_servable_page() {
        assert_eq!(resolve_limit(None), DEFAULT_LIMIT);
        assert_eq!(resolve_limit(Some(0)), 1);
        assert_eq!(resolve_limit(Some(50)), 50);
        assert_eq!(resolve_limit(Some(999_999)), MAX_LIMIT);
    }

    #[test]
    fn merging_interleaves_projects_by_freshness() {
        // Concatenating per-project pages would put one project's stale beads
        // above another's fresh ones.
        let merged = merge_rows(
            vec![
                vec![
                    row("a", "2026-08-29T10:00:00Z"),
                    row("c", "2026-08-20T10:00:00Z"),
                ],
                vec![row("b", "2026-08-25T10:00:00Z")],
            ],
            10,
        );

        assert_eq!(
            merged.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn merging_truncates_to_the_requested_page() {
        let merged = merge_rows(
            vec![
                vec![row("a", "2026-08-29T10:00:00Z")],
                vec![row("b", "2026-08-28T10:00:00Z")],
            ],
            1,
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, "a");
    }

    #[test]
    fn rows_never_carry_the_long_text() {
        let serialized = serde_json::to_string(&row("a", "2026-08-29T10:00:00Z")).unwrap();

        assert!(!serialized.contains("description"));
        assert!(!serialized.contains("notes"));
    }
}
