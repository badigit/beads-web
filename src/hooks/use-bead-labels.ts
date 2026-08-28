"use client";

/**
 * Hook loading a project's label vocabulary from the backend.
 *
 * Beads stores labels in a flat `(issue_id, label)` link table and keeps no
 * dictionary beside it, so the vocabulary is whatever `SELECT DISTINCT label`
 * says — the backend aggregates it (`GET /api/beads/labels`) instead of the
 * board guessing from the beads it happens to have loaded.
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "@/lib/api";
import type { LabelCount } from "@/types";

export interface UseBeadLabelsResult {
  /** Labels that exist in the project, most used first. */
  labels: LabelCount[];
  isLoading: boolean;
  /** Error message from the last failed load, if any. */
  error: string | null;
  /** Reload the vocabulary (e.g. after beads change). */
  refresh: () => void;
}

export function useBeadLabels(projectPath: string): UseBeadLabelsResult {
  const [labels, setLabels] = useState<LabelCount[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!projectPath) {
      setLabels([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    api.beads
      .labels(projectPath)
      .then((data) => {
        if (cancelled) return;
        setLabels(data.labels);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A project without labels (or an older schema) must not break the
        // board — the caller falls back to the labels seen on loaded beads.
        setLabels([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, reloadToken]);

  return { labels, isLoading, error, refresh };
}
