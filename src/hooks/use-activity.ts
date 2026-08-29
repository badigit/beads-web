"use client";

/**
 * Hooks loading an activity feed page by page.
 *
 * Two feeds share one implementation: a single project's events and the
 * cross-project feed merged from every beads database. Paging is by timestamp
 * rather than offset — the feed grows while it is being read, and an offset
 * would quietly skip or repeat rows as it shifts.
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

/** Fetches one page; `before` walks backwards through the feed. */
type PageFetcher = (options: { limit: number; before?: string }) => Promise<{
  events: ActivityEvent[];
}>;

/**
 * The paging machinery both feeds use.
 *
 * `key` identifies the feed: changing it (another project, or switching to the
 * cross-project feed) restarts from the top instead of appending to a stale list.
 */
function usePagedActivity(fetchPage: PageFetcher, key: string, enabled: boolean): UseActivityResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Guards a second page request while one is in flight — scroll handlers fire
  // far more often than pages arrive.
  const loadingMoreRef = useRef(false);
  // Kept in a ref so `loadMore` stays stable while the list grows.
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!key || !enabled) return;

    let cancelled = false;
    setIsLoading(true);

    fetchRef
      .current({ limit: PAGE_SIZE })
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
  }, [key, enabled, reloadToken]);

  const loadMore = useCallback(() => {
    const current = eventsRef.current;
    const oldest = current[current.length - 1];
    if (!oldest || loadingMoreRef.current || !hasMore) return;

    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    fetchRef
      .current({ limit: PAGE_SIZE, before: oldest.created_at })
      .then((data) => {
        // Several events can share a timestamp, so the boundary alone would
        // re-deliver rows we already show; drop by id instead.
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
  }, [hasMore]);

  return { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh };
}

/**
 * One project's feed.
 *
 * @param projectPath project root or `dolt://<database>`; empty disables loading
 * @param enabled skip the request entirely while the feed is not on screen
 */
export function useActivity(projectPath: string, enabled = true): UseActivityResult {
  const fetchPage = useCallback<PageFetcher>(
    (options) => api.activity.read(projectPath, options),
    [projectPath]
  );

  return usePagedActivity(fetchPage, projectPath, enabled);
}

/**
 * The cross-project feed: every beads database merged into one timeline.
 *
 * This is the view that answers "what have I been working on" without opening
 * thirty projects one at a time.
 */
export function useAllActivity(enabled = true): UseActivityResult {
  const fetchPage = useCallback<PageFetcher>((options) => api.activity.all(options), []);

  return usePagedActivity(fetchPage, "all", enabled);
}
