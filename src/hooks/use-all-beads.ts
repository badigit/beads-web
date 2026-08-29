"use client";

/**
 * Hook loading the cross-project grid.
 *
 * Filters live here rather than in the component because they are server-side:
 * changing a status checkbox refetches, it does not hide rows we already paid
 * to transfer.
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "@/lib/api";
import type { BeadRow } from "@/types";

export interface GridFilters {
  /** Empty means every status. */
  statuses: string[];
  /** Empty means every priority. */
  priorities: number[];
  /** OR semantics; empty means no label filter. */
  labels: string[];
}

/** What the grid opens on: the work in flight, not the archive. */
export const DEFAULT_GRID_FILTERS: GridFilters = {
  statuses: ["open", "in_progress"],
  priorities: [],
  labels: [],
};

export interface UseAllBeadsResult {
  rows: BeadRow[];
  isLoading: boolean;
  error: string | null;
  /** True when the server returned a full page — something is cut off. */
  truncated: boolean;
  refresh: () => void;
}

/** Rows per load. The endpoint caps at 2000; this is what the grid asks for. */
const PAGE_SIZE = 500;

export function useAllBeads(filters: GridFilters): UseAllBeadsResult {
  const [rows, setRows] = useState<BeadRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Serialized so the effect re-runs on a changed filter set rather than on
  // every new array identity.
  const key = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const parsed = JSON.parse(key) as GridFilters;

    api.beads
      .all({
        statuses: parsed.statuses,
        priorities: parsed.priorities,
        labels: parsed.labels,
        limit: PAGE_SIZE,
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data.beads);
        setTruncated(data.beads.length >= PAGE_SIZE);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setTruncated(false);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, reloadToken]);

  return { rows, isLoading, error, truncated, refresh };
}
