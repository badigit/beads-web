"use client";

/**
 * Live updates for projects whose beads live in Dolt.
 *
 * `useFileWatcher` watches `.beads/issues.jsonl`, which only exists while `bd`
 * runs in file mode; against a Dolt server that file is never written, so the
 * board used to poll every 15 seconds and refetch all beads unconditionally.
 * This hook subscribes to the backend's revision stream instead: the server
 * watches the database's working-set hash and only emits when it actually moves.
 *
 * The subscription is keyed by project *path* and is attempted for every
 * project, filesystem ones included — only the server can tell whether a path is
 * backed by Dolt, and gating on the `dolt://` prefix meant no real project ever
 * subscribed (bweb-wh2). A project without a Dolt database gets a 404, which
 * `EventSource` treats as fatal, so nothing retries.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";

/** Return type for the useDoltWatcher hook. */
export interface UseDoltWatcherResult {
  /** Whether the SSE stream is currently connected. */
  isConnected: boolean;
}

/**
 * Watches a project's Dolt database and invokes a callback when it changes.
 *
 * @param projectPath - Project path (filesystem or `dolt://…`), or null/empty to
 *   watch nothing. The server resolves it to a database.
 * @param onChange - Called after a revision change settles.
 * @param debounceMs - Window used to coalesce bursts (default: 100).
 */
export function useDoltWatcher(
  projectPath: string | null,
  onChange: () => void,
  debounceMs: number = 100
): UseDoltWatcherResult {
  const [isConnected, setIsConnected] = useState(false);

  // Refs keep the effect from re-subscribing whenever the caller passes a new
  // callback identity — resubscribing would drop and reopen the SSE stream.
  const callbackRef = useRef(onChange);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRevisionRef = useRef<string | null>(null);

  useEffect(() => {
    callbackRef.current = onChange;
  }, [onChange]);

  const handleRevision = useCallback(
    (revision: string) => {
      // The server already suppresses unchanged revisions; this also covers the
      // replay a reconnect can produce.
      if (lastRevisionRef.current === revision) return;
      lastRevisionRef.current = revision;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        callbackRef.current();
      }, debounceMs);
    },
    [debounceMs]
  );

  useEffect(() => {
    if (!projectPath) return;

    const close = api.watch.doltRevision(
      projectPath,
      (event) => handleRevision(event.revision),
      setIsConnected
    );

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      lastRevisionRef.current = null;
      close();
    };
  }, [projectPath, handleRevision]);

  return { isConnected };
}
