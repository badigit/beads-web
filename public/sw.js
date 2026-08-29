/*
 * Service worker, present for one reason: Chrome only offers "Install app"
 * when the page registers one with a fetch handler. Beads Web talks to a
 * backend on the same machine and is useless offline, so this worker
 * deliberately caches NOTHING — every request goes to the network.
 *
 * Caching here would be actively harmful: the UI is served by the same binary
 * that serves the API, so a cached shell could outlive a rebuild and show an
 * old interface against a new backend.
 */

self.addEventListener("install", () => {
  // Take over immediately instead of waiting for every tab to close: there is
  // nothing cached to keep consistent between versions.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
