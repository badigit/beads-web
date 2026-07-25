//! Live-update SSE endpoint for projects whose data lives in Dolt.
//!
//! Filesystem projects get change notifications from [`super::watch`], which
//! relies on `notify`. Dolt-backed projects have no file to watch, so the UI used
//! to poll `GET /api/beads` every 15 seconds — refetching every issue, comment
//! and dependency regardless of whether anything had changed.
//!
//! ## Why the endpoint takes a project path
//!
//! "Dolt-backed" is not the same as "registered as `dolt://…`": in practice every
//! project is registered by filesystem path while `bd` keeps its issues on the
//! central Dolt server. A client cannot tell the two apart from the path alone,
//! so it would have to know the database name to subscribe — which is why the
//! subscription silently never happened for any real project (bweb-wh2). The
//! endpoint therefore accepts `project_path` and resolves the database here,
//! reusing the same [`crate::dolt::database_name_for_project`] that `/api/beads`
//! already reads through.
//!
//! This module replaces that with a cheap revision probe. One poller runs per
//! database, shared by every connected client through a broadcast channel, and
//! only emits when the revision actually moves.
//!
//! ## Why `DOLT_HASHOF_DB('WORKING')`
//!
//! `bd` writes into the Dolt working set and does not always commit, so
//! `HASHOF('HEAD')` misses changes that are already visible to readers.
//! Hashing the working set catches both committed and uncommitted writes.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tracing::{debug, info, warn};

use super::beads::DOLT_PATH_PREFIX;
use crate::dolt::{self, DoltError, DoltManager};

/// How often the shared poller asks Dolt for the current revision.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Buffer size of the per-database broadcast channel.
///
/// Revision changes are rare and clients only care about the newest one, so a
/// small buffer is enough; lagging receivers are handled by skipping.
const BROADCAST_CAPACITY: usize = 16;

/// Query parameters for the Dolt watch endpoint.
///
/// Either names the target directly or leaves it to the server to resolve;
/// at least one of the two must be present.
#[derive(Debug, Default, Deserialize)]
pub struct DoltWatchParams {
    /// The Dolt database to watch, when the caller already knows its name.
    pub database: Option<String>,
    /// A registered project path — filesystem or `dolt://…` — to resolve into a
    /// database name. This is what the UI sends, because it does not know which
    /// projects are Dolt-backed.
    pub project_path: Option<String>,
}

/// Error payload shape shared with the other route modules.
type WatchError = (StatusCode, Json<serde_json::Value>);

/// Builds the JSON error body returned when no stream can be opened.
fn watch_error(status: StatusCode, message: impl Into<String>) -> WatchError {
    (
        status,
        Json(serde_json::json!({ "error": message.into() })),
    )
}

/// Trims a query parameter, treating blank as absent.
fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// Names the database to watch, preferring an explicit `database` parameter.
fn resolve_database(params: &DoltWatchParams) -> Option<String> {
    if let Some(database) = present(&params.database) {
        return Some(database.to_string());
    }
    database_for_project_path(present(&params.project_path)?)
}

/// Resolves a project path to its Dolt database.
///
/// `dolt://<db>` carries the name in the path itself; a filesystem path is
/// resolved from `.beads/`, which also answers "is this project on Dolt at all?"
/// — projects on another backend yield `None`.
fn database_for_project_path(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix(DOLT_PATH_PREFIX) {
        let database = rest.trim_end_matches('/');
        return (!database.is_empty()).then(|| database.to_string());
    }
    dolt::database_name_for_project(Path::new(path))
}

/// Revision change event sent to clients.
#[derive(Debug, Clone, Serialize)]
pub struct RevisionChangeEvent {
    /// The database whose revision moved.
    pub database: String,
    /// The new working-set hash.
    pub revision: String,
}

/// Decides whether an observed revision is worth notifying clients about.
///
/// The first observation establishes a baseline without emitting: a client that
/// just connected has already loaded the current data, so telling it to reload
/// immediately would be a wasted round trip.
#[derive(Debug, Default)]
pub struct RevisionTracker {
    last_seen: Option<String>,
}

impl RevisionTracker {
    /// Creates a tracker with no baseline yet.
    pub fn new() -> Self {
        Self { last_seen: None }
    }

    /// Records a revision, returning `true` when it differs from the previous one.
    pub fn observe(&mut self, revision: &str) -> bool {
        let changed = matches!(self.last_seen.as_deref(), Some(prev) if prev != revision);
        self.last_seen = Some(revision.to_string());
        changed
    }
}

/// Broadcast channels keyed by database name, one per watched database.
///
/// The registry hands out a receiver per client and only spawns a poller the
/// first time a database is watched. Entries are kept after the last client
/// disconnects — the poller stops on its own once no receivers remain, and the
/// stale sender is replaced on the next subscribe.
#[derive(Default)]
pub struct DoltWatchRegistry {
    channels: Mutex<HashMap<String, broadcast::Sender<RevisionChangeEvent>>>,
}

impl DoltWatchRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribes to a database, returning the receiver and whether a poller
    /// must be spawned for it.
    ///
    /// A poller is needed when this database has no sender yet, or when the
    /// previous poller exited because everyone had disconnected.
    pub fn subscribe(
        &self,
        database: &str,
    ) -> (broadcast::Receiver<RevisionChangeEvent>, bool) {
        let mut channels = self.channels.lock().unwrap();

        if let Some(sender) = channels.get(database) {
            if sender.receiver_count() > 0 {
                return (sender.subscribe(), false);
            }
        }

        let (sender, receiver) = broadcast::channel(BROADCAST_CAPACITY);
        channels.insert(database.to_string(), sender);
        (receiver, true)
    }
}

/// Shared registry type stored in the Axum extension layer.
pub type SharedWatchRegistry = Arc<DoltWatchRegistry>;

/// Creates the registry placed into the router's extension layer at startup.
pub fn new_registry() -> SharedWatchRegistry {
    Arc::new(DoltWatchRegistry::new())
}

/// Confirms that a database can actually be watched before a stream is opened.
///
/// A name resolved from a filesystem path is partly a guess — the last resort in
/// [`crate::dolt::database_name_for_project`] derives it from the directory name
/// — and an `EventSource` that connects but never receives anything looks exactly
/// like a working one. Failing the request instead makes "this project has no
/// Dolt database" visible to the client, and per the SSE spec a non-200 response
/// stops the browser from reconnecting, so a non-Dolt project costs one failed
/// request rather than an endless retry loop.
async fn ensure_watchable(dolt: &DoltManager, database: &str) -> Result<(), WatchError> {
    match dolt.database_revision(database).await {
        Ok(_) => Ok(()),
        // A dead server is temporary and says nothing about the project, so it
        // must not be reported as "no such database".
        Err(DoltError::ConnectionFailed(e)) => {
            warn!("Dolt watch unavailable for {}: {}", database, e);
            Err(watch_error(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("Dolt server is unreachable: {}", e),
            ))
        }
        Err(e) => {
            debug!("Dolt watch declined for {}: {}", database, e);
            Err(watch_error(
                StatusCode::NOT_FOUND,
                format!("Database '{}' cannot be watched: {}", database, e),
            ))
        }
    }
}

/// GET /api/dolt/watch?project_path=&lt;path&gt; (or `?database=&lt;db&gt;`)
///
/// Server-Sent Events stream that emits whenever the database's working-set
/// revision changes. Reconnection is handled by the browser's `EventSource`.
///
/// Returns 404 when the project has no watchable Dolt database and 503 when the
/// Dolt server itself is unreachable.
pub async fn watch_dolt(
    Extension(dolt): Extension<Arc<DoltManager>>,
    Extension(registry): Extension<SharedWatchRegistry>,
    Query(params): Query<DoltWatchParams>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, WatchError> {
    // Resolving a filesystem path means reading files under it, so it goes
    // through the same gate as every other path-taking route.
    if let Some(path) = present(&params.project_path) {
        if !path.starts_with(DOLT_PATH_PREFIX) {
            if let Err(e) = super::validate_path_security(Path::new(path)) {
                return Err(watch_error(StatusCode::FORBIDDEN, e));
            }
        }
    }

    let Some(database) = resolve_database(&params) else {
        debug!("Dolt watch declined: no database named by {:?}", params);
        return Err(watch_error(
            StatusCode::NOT_FOUND,
            "No Dolt database for this project",
        ));
    };

    ensure_watchable(&dolt, &database).await?;

    let (receiver, needs_poller) = registry.subscribe(&database);

    if needs_poller {
        info!("Starting Dolt revision poller for database: {}", database);
        let registry_for_poller = registry.clone();
        let db_for_poller = database.clone();
        tokio::spawn(async move {
            run_poller(dolt, registry_for_poller, db_for_poller).await;
        });
    }

    let stream = BroadcastStream::new(receiver).filter_map(|result| match result {
        Ok(event) => Some(Ok(serialize_event(&event))),
        // A lagging client simply missed intermediate revisions; the next event
        // still carries the newest one, so there is nothing to recover.
        Err(_) => None,
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("ping"),
    ))
}

/// Serializes a revision event, falling back to an empty payload on failure.
fn serialize_event(event: &RevisionChangeEvent) -> Event {
    match serde_json::to_string(event) {
        Ok(json) => Event::default().data(json),
        Err(e) => {
            warn!("Failed to serialize revision event: {}", e);
            Event::default().data("{}")
        }
    }
}

/// Polls one database until every client has disconnected.
async fn run_poller(
    dolt: Arc<DoltManager>,
    registry: SharedWatchRegistry,
    database: String,
) {
    let mut tracker = RevisionTracker::new();
    let mut ticker = tokio::time::interval(POLL_INTERVAL);

    loop {
        ticker.tick().await;

        let sender = {
            let channels = registry.channels.lock().unwrap();
            channels.get(&database).cloned()
        };

        let Some(sender) = sender else {
            debug!("Dolt poller for {} stopping: channel gone", database);
            return;
        };

        if sender.receiver_count() == 0 {
            info!("Dolt poller for {} stopping: no clients left", database);
            return;
        }

        match dolt.database_revision(&database).await {
            Ok(revision) => {
                if tracker.observe(&revision) {
                    debug!("Dolt revision changed for {}: {}", database, revision);
                    // Send errors only mean everyone disconnected mid-tick; the
                    // receiver-count check above catches that on the next pass.
                    let _ = sender.send(RevisionChangeEvent {
                        database: database.clone(),
                        revision,
                    });
                }
            }
            Err(e) => {
                // A transient Dolt outage must not kill the poller — clients stay
                // connected and pick up changes once the server is reachable.
                warn!("Dolt revision probe failed for {}: {}", database, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds params the way axum would after deserializing a query string.
    fn params(database: Option<&str>, project_path: Option<&str>) -> DoltWatchParams {
        DoltWatchParams {
            database: database.map(str::to_string),
            project_path: project_path.map(str::to_string),
        }
    }

    /// Writes a `.beads/metadata.json` describing a project's backend.
    fn write_metadata(root: &std::path::Path, backend: &str, database: &str) {
        let beads = root.join(".beads");
        std::fs::create_dir_all(&beads).unwrap();
        std::fs::write(
            beads.join("metadata.json"),
            format!(r#"{{"backend": "{}", "dolt_database": "{}"}}"#, backend, database),
        )
        .unwrap();
    }

    #[test]
    fn an_explicit_database_is_watched_as_given() {
        assert_eq!(
            resolve_database(&params(Some("beads_web"), None)),
            Some("beads_web".to_string())
        );
    }

    #[test]
    fn a_dolt_url_project_path_resolves_to_its_database() {
        assert_eq!(
            resolve_database(&params(None, Some("dolt://beads_web"))),
            Some("beads_web".to_string())
        );
    }

    #[test]
    fn a_bare_dolt_url_names_no_database() {
        assert_eq!(resolve_database(&params(None, Some("dolt://"))), None);
    }

    #[test]
    fn a_filesystem_project_resolves_through_its_beads_metadata() {
        // The regression this endpoint exists for: every real project is
        // registered by filesystem path while its data lives in central Dolt.
        let temp = tempfile::tempdir().unwrap();
        write_metadata(temp.path(), "dolt", "beads_config-parser");

        assert_eq!(
            resolve_database(&params(None, Some(temp.path().to_str().unwrap()))),
            Some("beads_config-parser".to_string())
        );
    }

    #[test]
    fn a_project_on_another_backend_names_no_database() {
        let temp = tempfile::tempdir().unwrap();
        write_metadata(temp.path(), "sqlite", "beads_local");

        assert_eq!(
            resolve_database(&params(None, Some(temp.path().to_str().unwrap()))),
            None
        );
    }

    #[test]
    fn an_explicit_database_wins_over_the_project_path() {
        assert_eq!(
            resolve_database(&params(Some("beads_explicit"), Some("dolt://beads_from_path"))),
            Some("beads_explicit".to_string())
        );
    }

    #[test]
    fn blank_parameters_count_as_absent() {
        assert_eq!(resolve_database(&params(Some("  "), Some("  "))), None);
    }

    #[test]
    fn no_parameters_name_no_database() {
        assert_eq!(resolve_database(&params(None, None)), None);
    }

    #[test]
    fn first_observation_establishes_a_baseline_without_emitting() {
        let mut tracker = RevisionTracker::new();
        assert!(!tracker.observe("abc"));
    }

    #[test]
    fn repeated_identical_revisions_do_not_emit() {
        let mut tracker = RevisionTracker::new();
        tracker.observe("abc");
        assert!(!tracker.observe("abc"));
        assert!(!tracker.observe("abc"));
    }

    #[test]
    fn a_changed_revision_emits_once() {
        let mut tracker = RevisionTracker::new();
        tracker.observe("abc");
        assert!(tracker.observe("def"));
        // The new revision is now the baseline, so it must not emit again.
        assert!(!tracker.observe("def"));
    }

    #[test]
    fn returning_to_an_earlier_revision_still_emits() {
        // Dolt can move back (branch checkout, reset), and the data on screen is
        // stale either way — direction does not matter, only difference.
        let mut tracker = RevisionTracker::new();
        tracker.observe("abc");
        tracker.observe("def");
        assert!(tracker.observe("abc"));
    }

    #[test]
    fn first_subscriber_to_a_database_needs_a_poller() {
        let registry = DoltWatchRegistry::new();
        let (_rx, needs_poller) = registry.subscribe("beads_web");
        assert!(needs_poller);
    }

    #[test]
    fn a_second_subscriber_shares_the_existing_poller() {
        let registry = DoltWatchRegistry::new();
        let (_first, _) = registry.subscribe("beads_web");
        let (_second, needs_poller) = registry.subscribe("beads_web");
        assert!(!needs_poller, "one poller must serve both clients");
    }

    #[test]
    fn separate_databases_get_separate_pollers() {
        let registry = DoltWatchRegistry::new();
        let (_a, _) = registry.subscribe("beads_web");
        let (_b, needs_poller) = registry.subscribe("config_parser");
        assert!(needs_poller);
    }

    #[test]
    fn a_database_whose_clients_all_left_gets_a_fresh_poller() {
        let registry = DoltWatchRegistry::new();
        let (first, _) = registry.subscribe("beads_web");
        drop(first);

        let (_second, needs_poller) = registry.subscribe("beads_web");
        assert!(
            needs_poller,
            "the previous poller exits when it sees no receivers, so a new one is required"
        );
    }

    #[tokio::test]
    async fn subscribers_receive_broadcast_revision_events() {
        let registry = DoltWatchRegistry::new();
        let (mut rx, _) = registry.subscribe("beads_web");

        let sender = {
            let channels = registry.channels.lock().unwrap();
            channels.get("beads_web").cloned().unwrap()
        };
        sender
            .send(RevisionChangeEvent {
                database: "beads_web".to_string(),
                revision: "rev2".to_string(),
            })
            .unwrap();

        let event = rx.recv().await.unwrap();
        assert_eq!(event.revision, "rev2");
        assert_eq!(event.database, "beads_web");
    }
}
