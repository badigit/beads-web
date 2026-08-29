//! Workspace activity feed.
//!
//! Answers "what happened in this project, by day" — the question the board
//! itself cannot answer, because a kanban column shows the current state and
//! says nothing about how it got there.
//!
//! The data already exists: every beads database carries an `events` table
//! (`issue_id`, `event_type`, `actor`, `old_value`, `new_value`, `comment`,
//! `created_at`) written by `bd` itself. This endpoint only reads it — no
//! separate history collection, no writes.

use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::db::Database;
use super::search::build_project_index;

use super::beads::{
    ensure_dolt_online, error_response, resolve_beads_dir, resolve_project_dolt, RouteError,
    DOLT_PATH_PREFIX,
};
use crate::dolt::{self, DoltManager};

/// Largest page the endpoint will serve, whatever the caller asks for.
///
/// The feed is paged deliberately: active projects accumulate thousands of
/// events, and "just render everything" turns the first paint into a download.
const MAX_LIMIT: u32 = 500;
/// Page size used when the caller does not ask for one.
const DEFAULT_LIMIT: u32 = 100;

/// How many databases are read concurrently when merging every project's feed.
/// Matches the global search: the shared pool holds four connections.
const MAX_CONCURRENCY: usize = 4;

/// Longest `detail` string shipped to the client.
///
/// Close reasons are free text and occasionally hold a paragraph; the feed
/// shows one line per event, so the tail would only inflate the payload.
const MAX_DETAIL: usize = 200;

/// Query parameters for `GET /api/activity`.
#[derive(Debug, Deserialize)]
pub struct ActivityParams {
    /// Project path, or `dolt://<database>`.
    pub path: String,
    /// Page size (capped at [`MAX_LIMIT`]).
    pub limit: Option<u32>,
    /// Page backwards: only events strictly older than this ISO timestamp.
    pub before: Option<String>,
    /// Incremental refresh: only events strictly newer than this ISO timestamp.
    pub since: Option<String>,
}

/// Query parameters for `GET /api/activity/all`.
///
/// Same paging as the per-project feed minus `path`: this endpoint spans every
/// database, so demanding one project's path would make it unusable.
#[derive(Debug, Deserialize)]
pub struct AllActivityParams {
    pub limit: Option<u32>,
    pub before: Option<String>,
    pub since: Option<String>,
}

/// One row of the feed.
///
/// Deliberately narrow. `old_value`/`new_value` in the table hold whole issue
/// snapshots as JSON — a `status_changed` row alone carries the entire issue —
/// so they never leave the server. What the feed needs is folded into
/// [`ActivityEvent::detail`] instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityEvent {
    pub id: String,
    pub issue_id: String,
    /// Title of the bead the event belongs to, resolved by the same query.
    /// `None` when the bead is gone (deleted or compacted away).
    pub issue_title: Option<String>,
    pub event_type: String,
    pub actor: String,
    /// Short human-readable specifics: the new status, the label added, the
    /// close reason. `None` when the event type carries nothing worth a line.
    pub detail: Option<String>,
    pub created_at: String,
    /// Which project the event belongs to. Only set by the cross-project feed —
    /// inside one project the answer is already on screen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}

/// Raw columns of one `events` row, before folding.
#[derive(Debug, Clone, Default)]
pub struct RawActivityRow {
    pub id: String,
    pub issue_id: String,
    pub issue_title: Option<String>,
    pub event_type: String,
    pub actor: String,
    pub new_value: Option<String>,
    pub comment: Option<String>,
    pub created_at: String,
}

/// Pulls the one useful line out of an event's raw values.
///
/// `bd` uses the value columns inconsistently, and every shape here was read
/// off live data rather than guessed:
/// - `status_changed` — `new_value` is `{"status":"in_progress"}` (the matching
///   `old_value` holds the whole previous issue and is never even selected);
/// - `label_added` / `label_removed` — values are NULL, the label name lives in
///   `comment` as `Added label: <name>`;
/// - `closed` — `new_value` is the close reason, in plain text;
/// - `created`, `claimed` — nothing worth showing beyond the verb itself.
pub(crate) fn detail_for(row: &RawActivityRow) -> Option<String> {
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };

    let detail = match row.event_type.as_str() {
        "status_changed" => status_from_json(row.new_value.as_deref()),
        "closed" => trimmed(&row.new_value),
        _ => trimmed(&row.comment),
    }?;

    Some(truncate(&detail, MAX_DETAIL))
}

/// Reads `{"status":"..."}` out of a `status_changed` value.
///
/// Falls back to `None` rather than showing raw JSON: a broken line is worse
/// than a missing one in a feed scanned by eye.
fn status_from_json(value: Option<&str>) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value?.trim()).ok()?;
    parsed
        .get("status")?
        .as_str()
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .map(str::to_string)
}

/// Shortens `text` to `max` characters, appending an ellipsis when it cuts.
/// Counts characters, not bytes — descriptions here are mostly Cyrillic.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{}…", kept.trim_end())
}

/// Folds raw rows into feed events, dropping the bulky value columns.
pub(crate) fn events_from_rows(rows: Vec<RawActivityRow>) -> Vec<ActivityEvent> {
    rows.into_iter()
        .map(|row| ActivityEvent {
            detail: detail_for(&row),
            id: row.id,
            issue_id: row.issue_id,
            issue_title: row.issue_title,
            event_type: row.event_type,
            actor: row.actor,
            created_at: row.created_at,
            project_id: None,
            project_name: None,
        })
        .collect()
}

/// Merges per-database pages into one feed, newest first.
///
/// Each database is asked for its own newest page, so the merge has to sort
/// again: "newest 100 overall" is not the concatenation of per-project pages.
/// Sorting by `(created_at, id)` keeps the order stable when two projects
/// record an event in the same second.
pub(crate) fn merge_feeds(feeds: Vec<Vec<ActivityEvent>>, limit: usize) -> Vec<ActivityEvent> {
    let mut merged: Vec<ActivityEvent> = feeds.into_iter().flatten().collect();
    merged.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    merged.truncate(limit);
    merged
}

/// Normalizes a requested page size into the served one.
pub(crate) fn resolve_limit(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

/// GET /api/activity?path=/path/to/project&limit=&before=&since=
///
/// Returns the project's events, newest first, for a feed grouped by day on the
/// client. Paging is by `before` (older than) and incremental refresh by
/// `since` (newer than); both take the ISO timestamps this endpoint emits.
///
/// A project whose data source has no `events` table — the bd CLI and JSONL
/// tiers have no event history at all — gets an empty list, not an error: "no
/// history here" is a fact about the source, not a failure.
pub async fn read_activity(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Query(params): Query<ActivityParams>,
) -> impl IntoResponse {
    let path = params.path.replace('\\', "/");
    let query = dolt::ActivityQuery {
        limit: resolve_limit(params.limit),
        before: params.before.clone(),
        since: params.since.clone(),
    };

    match resolve_activity(&dolt_manager, &path, &query).await {
        Ok((events, source)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "events": events, "source": source })),
        ),
        Err((status, body)) => {
            tracing::warn!(
                path = %path,
                status = status.as_u16(),
                "Failed to resolve activity: {:?}",
                body.0.get("error")
            );
            (status, body)
        }
    }
}

/// Resolves the feed through the same tier cascade as the rest of the reads:
/// `dolt://` direct → per-project Dolt → central Dolt. There is no bd CLI or
/// JSONL tier here — neither exposes the event history — so a project that
/// reaches neither Dolt tier gets an empty feed.
async fn resolve_activity(
    dolt_manager: &DoltManager,
    path: &str,
    query: &dolt::ActivityQuery,
) -> Result<(Vec<ActivityEvent>, &'static str), RouteError> {
    if let Some(db_name) = path.strip_prefix(DOLT_PATH_PREFIX) {
        ensure_dolt_online(dolt_manager).await?;
        return match dolt_manager.read_activity(db_name, query).await {
            Ok(rows) => Ok((events_from_rows(rows), "dolt-direct")),
            Err(e) => Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                e.to_string(),
            )),
        };
    }

    let project_path = PathBuf::from(path);
    let beads_dir = resolve_beads_dir(&project_path)?;

    // Tier 0: per-project Dolt server.
    if let Some((port, db_name)) = resolve_project_dolt(&beads_dir, &project_path).await {
        match dolt::read_activity_on_port(port, &db_name, query).await {
            Ok(rows) => return Ok((events_from_rows(rows), "dolt-project")),
            Err(e) => tracing::warn!(
                "Per-project Dolt activity on port {} failed: {}, falling back",
                port,
                e
            ),
        }
    }

    // Tier 1: central Dolt SQL server.
    if dolt_manager.is_available() {
        if let Some(db_name) = dolt::database_name_for_project(&project_path) {
            match dolt_manager.read_activity(&db_name, query).await {
                Ok(rows) => return Ok((events_from_rows(rows), "dolt-central")),
                Err(e) => tracing::info!(
                    "Dolt activity read failed for {} ({}), reporting empty feed",
                    db_name,
                    e
                ),
            }
        }
    }

    Ok((Vec::new(), "none"))
}

/// GET /api/activity/all?limit=&before=
///
/// The same feed across every beads database on the central server — the view
/// that answers "what did I work on lately" without opening thirty projects one
/// by one. Each row carries the project it belongs to.
///
/// Never fails hard: an unreachable server or a broken database yields a
/// partial feed rather than an error status, exactly like the global search.
pub async fn read_all_activity(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<AllActivityParams>,
) -> impl IntoResponse {
    let limit = resolve_limit(params.limit);
    let query = dolt::ActivityQuery {
        limit,
        before: params.before.clone(),
        since: params.since.clone(),
    };

    if !dolt_manager.is_available() && !dolt_manager.check_server().await {
        tracing::warn!("Cross-project activity skipped: Dolt server unavailable");
        return Json(serde_json::json!({ "events": [], "source": "unavailable" }));
    }

    let databases = match dolt_manager.discover_databases().await {
        Ok(databases) => databases,
        Err(e) => {
            tracing::error!(error = %e, "Cross-project activity: discovery failed");
            return Json(serde_json::json!({ "events": [], "source": "unavailable" }));
        }
    };

    let database_count = databases.len();
    let names: Vec<String> = databases.into_iter().map(|entry| entry.name).collect();
    let projects = build_project_index(&db);
    let feeds = read_every_database(Arc::clone(&dolt_manager), names, query, &projects).await;
    let read = feeds.len();
    let events = merge_feeds(feeds, limit as usize);

    tracing::info!(
        databases = database_count,
        databases_read = read,
        events = events.len(),
        "Cross-project activity"
    );

    Json(serde_json::json!({ "events": events, "source": "dolt-central" }))
}

/// Reads every database concurrently; a failing one is skipped, not fatal.
async fn read_every_database(
    dolt_manager: Arc<DoltManager>,
    databases: Vec<String>,
    query: dolt::ActivityQuery,
    projects: &std::collections::HashMap<String, (String, String)>,
) -> Vec<Vec<ActivityEvent>> {
    stream::iter(databases.into_iter().map(|database| {
        let dolt_manager = Arc::clone(&dolt_manager);
        let query = query.clone();
        let project = projects.get(&database).cloned();
        async move {
            match dolt_manager.read_activity(&database, &query).await {
                Ok(rows) => {
                    let (project_id, project_name) = match project {
                        Some((id, name)) => (Some(id), Some(name)),
                        // A database with no registry entry still belongs
                        // somewhere: name it after itself rather than blank.
                        None => (None, Some(database.clone())),
                    };
                    let events = events_from_rows(rows)
                        .into_iter()
                        .map(|event| ActivityEvent {
                            project_id: project_id.clone(),
                            project_name: project_name.clone(),
                            ..event
                        })
                        .collect::<Vec<_>>();
                    Some(events)
                }
                Err(e) => {
                    tracing::warn!(
                        database = %database,
                        error = %e,
                        "Cross-project activity: skipping database"
                    );
                    None
                }
            }
        }
    }))
    .buffer_unordered(MAX_CONCURRENCY)
    .filter_map(|feed| async move { feed })
    .collect()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(event_type: &str) -> RawActivityRow {
        RawActivityRow {
            id: "e1".to_string(),
            issue_id: "bweb-1".to_string(),
            issue_title: Some("T".to_string()),
            event_type: event_type.to_string(),
            actor: "badigit".to_string(),
            created_at: "2026-08-29T09:52:48Z".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn status_change_shows_the_new_status_not_raw_json() {
        let mut raw = row("status_changed");
        raw.new_value = Some(r#"{"status":"in_progress"}"#.to_string());

        assert_eq!(detail_for(&raw), Some("in_progress".to_string()));
    }

    #[test]
    fn broken_status_json_yields_no_detail_rather_than_raw_json() {
        let mut raw = row("status_changed");
        raw.new_value = Some("{not json".to_string());

        assert_eq!(detail_for(&raw), None);
    }

    #[test]
    fn close_reason_comes_from_the_new_value() {
        let mut raw = row("closed");
        raw.new_value = Some("Смержено в badigit-main".to_string());

        assert_eq!(detail_for(&raw), Some("Смержено в badigit-main".to_string()));
    }

    #[test]
    fn label_events_take_their_detail_from_the_comment() {
        let mut raw = row("label_added");
        raw.comment = Some("Added label: visibility".to_string());

        assert_eq!(detail_for(&raw), Some("Added label: visibility".to_string()));
    }

    #[test]
    fn events_without_specifics_have_no_detail() {
        let mut raw = row("created");
        raw.new_value = Some("   ".to_string());
        raw.comment = Some(String::new());

        assert_eq!(detail_for(&raw), None);
    }

    #[test]
    fn long_details_are_truncated_by_characters() {
        let mut raw = row("closed");
        raw.new_value = Some("я".repeat(MAX_DETAIL + 50));

        let detail = detail_for(&raw).unwrap();
        assert_eq!(detail.chars().count(), MAX_DETAIL + 1); // + ellipsis
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn folding_ships_the_summary_and_not_the_raw_values() {
        // `updated` events carry a JSON diff in new_value that is worth nothing
        // on screen and can be huge — the feed must not forward it.
        let mut raw = row("updated");
        raw.new_value = Some(format!(r#"{{"description":"{}"}}"#, "x".repeat(10_000)));

        let events = events_from_rows(vec![raw]);
        let serialized = serde_json::to_string(&events).unwrap();

        assert!(!serialized.contains("new_value"));
        assert!(!serialized.contains("xxxx"));
        assert_eq!(events[0].detail, None);
    }

    fn feed_event(id: &str, created_at: &str, project: &str) -> ActivityEvent {
        ActivityEvent {
            id: id.to_string(),
            issue_id: "bweb-1".to_string(),
            issue_title: None,
            event_type: "created".to_string(),
            actor: "badigit".to_string(),
            detail: None,
            created_at: created_at.to_string(),
            project_id: None,
            project_name: Some(project.to_string()),
        }
    }

    #[test]
    fn merging_interleaves_projects_by_time() {
        // Concatenating per-project pages would list one project's whole day
        // before another's — the merge has to sort across them.
        let merged = merge_feeds(
            vec![
                vec![
                    feed_event("a", "2026-08-29T10:00:00Z", "beads-web"),
                    feed_event("b", "2026-08-27T10:00:00Z", "beads-web"),
                ],
                vec![feed_event("c", "2026-08-28T10:00:00Z", "dimcoder")],
            ],
            10,
        );

        assert_eq!(
            merged.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "c", "b"]
        );
    }

    #[test]
    fn merging_truncates_to_the_requested_page() {
        let merged = merge_feeds(
            vec![
                vec![feed_event("a", "2026-08-29T10:00:00Z", "one")],
                vec![feed_event("b", "2026-08-28T10:00:00Z", "two")],
                vec![feed_event("c", "2026-08-27T10:00:00Z", "three")],
            ],
            2,
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "a");
    }

    #[test]
    fn same_second_events_keep_a_stable_order() {
        let merged = merge_feeds(
            vec![
                vec![feed_event("a", "2026-08-29T10:00:00Z", "one")],
                vec![feed_event("b", "2026-08-29T10:00:00Z", "two")],
            ],
            10,
        );

        assert_eq!(merged[0].id, "b");
        assert_eq!(merged[1].id, "a");
    }

    #[test]
    fn limit_is_clamped_to_a_servable_page() {
        assert_eq!(resolve_limit(None), DEFAULT_LIMIT);
        assert_eq!(resolve_limit(Some(0)), 1);
        assert_eq!(resolve_limit(Some(25)), 25);
        assert_eq!(resolve_limit(Some(100_000)), MAX_LIMIT);
    }
}
