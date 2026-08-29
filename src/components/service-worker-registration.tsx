"use client";

import { useEffect } from "react";

/**
 * Registers the service worker so Chrome offers "Install app".
 *
 * Installability is the whole point: installed, Beads Web gets its own window
 * and its own taskbar icon instead of living in a browser tab. The worker
 * itself caches nothing (see `public/sw.js`).
 *
 * Registration is best-effort — over plain HTTP it only works on localhost,
 * which is exactly where this runs; anywhere else the failure is logged and
 * the app carries on as an ordinary page.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("Service worker registration failed (app install unavailable):", error);
    });
  }, []);

  return null;
}
