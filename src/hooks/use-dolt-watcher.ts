"use client";

/**
 * Live updates for `dolt://` projects.
 *
 * Filesystem projects are covered by `useFileWatcher`, which watches
 * `.beads/issues.jsonl`. Dolt-only projects have no such file, so the board used
 * to poll every 15 seconds and refetch all beads unconditionally. This hook
 * subscribes to the backend's revision stream instead: the server watches the
 * database's working-set hash and only emits when it actually moves.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";

/** Return type for the useDoltWatcher hook. */
export interface UseDoltWatcherResult {
  /** Whether the SSE stream is currently connected. */
  isConnected: boolean;
}

/**
 * Watches a Dolt database for changes and invokes a callback when it changes.
 *
 * @param database - Dolt database name, or null to watch nothing.
 * @param onChange - Called after a revision change settles.
 * @param debounceMs - Window used to coalesce bursts (default: 100).
 */
export function useDoltWatcher(
  database: string | null,
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
    if (!database) return;

    const close = api.watch.doltRevision(
      database,
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
  }, [database, handleRevision]);

  return { isConnected };
}
