//! Live-update SSE endpoint for `dolt://` projects.
//!
//! Filesystem projects get change notifications from [`super::watch`], which
//! relies on `notify`. Dolt-only projects have no file to watch, so the UI used
//! to poll `GET /api/beads` every 15 seconds — refetching every issue, comment
//! and dependency regardless of whether anything had changed.
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
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{Extension, Query},
    response::sse::{Event, KeepAlive, Sse},
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tracing::{debug, info, warn};

use crate::dolt::DoltManager;

/// How often the shared poller asks Dolt for the current revision.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Buffer size of the per-database broadcast channel.
///
/// Revision changes are rare and clients only care about the newest one, so a
/// small buffer is enough; lagging receivers are handled by skipping.
const BROADCAST_CAPACITY: usize = 16;

/// Query parameters for the Dolt watch endpoint.
#[derive(Debug, Deserialize)]
pub struct DoltWatchParams {
    /// The Dolt database to watch.
    pub database: String,
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

/// GET /api/dolt/watch?database=&lt;db&gt;
///
/// Server-Sent Events stream that emits whenever the database's working-set
/// revision changes. Reconnection is handled by the browser's `EventSource`.
pub async fn watch_dolt(
    Extension(dolt): Extension<Arc<DoltManager>>,
    Extension(registry): Extension<SharedWatchRegistry>,
    Query(params): Query<DoltWatchParams>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let database = params.database.clone();
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

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("ping"),
    )
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
