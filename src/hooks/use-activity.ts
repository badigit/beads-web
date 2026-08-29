"use client";

/**
 * Hook loading the project's activity feed page by page.
 *
 * Paging is by timestamp rather than offset: the feed grows while it is being
 * read, and an offset would quietly skip or repeat rows as it shifts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import type { ActivityEvent } from "@/types";

/** How many events one page holds. */
const PAGE_SIZE = 100;

export interface UseActivityResult {
  events: ActivityEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  /** False once the server returns a short page — nothing older is left. */
  hasMore: boolean;
  /** Append the next older page. */
  loadMore: () => void;
  /** Reload from the top. */
  refresh: () => void;
}

/**
 * @param projectPath project root or `dolt://<database>`; empty disables loading
 * @param enabled skip the request entirely while the feed is not on screen
 */
export function useActivity(projectPath: string, enabled = true): UseActivityResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Guards a second page request while one is in flight — scroll handlers fire
  // far more often than pages arrive.
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!projectPath || !enabled) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    api.activity
      .read(projectPath, { limit: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setEvents(data.events);
        setHasMore(data.events.length === PAGE_SIZE);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setEvents([]);
        setHasMore(false);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, enabled, reloadToken]);

  const loadMore = useCallback(() => {
    const oldest = events[events.length - 1];
    if (!projectPath || !oldest || loadingMoreRef.current || !hasMore) return;

    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    api.activity
      .read(projectPath, { limit: PAGE_SIZE, before: oldest.created_at })
      .then((data) => {
        // Same timestamp on several events would re-deliver rows we already
        // show; drop by id rather than trusting the boundary to be exact.
        setEvents((prev) => {
          const seen = new Set(prev.map((event) => event.id));
          return [...prev, ...data.events.filter((event) => !seen.has(event.id))];
        });
        setHasMore(data.events.length === PAGE_SIZE);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      });
  }, [projectPath, events, hasMore]);

  return { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh };
}
