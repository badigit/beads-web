"use client";

/**
 * Hook for loading and managing beads with real-time file watching.
 *
 * Combines the beads parser with file watcher to provide automatic
 * updates when the issues.jsonl file changes.
 *
 * Reads and writes a module-level cache (`@/lib/beads-cache`) keyed by project
 * path, so re-opening an already visited project paints instantly from stale
 * data while a fresh fetch runs in the background (stale-while-revalidate).
 */

import { useState, useEffect, useCallback, useRef } from "react";

import { useFileWatcher } from "@/hooks/use-file-watcher";
import {
  getCachedBeads,
  setCachedBeads,
  shouldReconcile,
  mergeBeads,
  maxUpdatedAt,
} from "@/lib/beads-cache";
import {
  loadProjectBeads,
  groupBeadsByStatus,
  assignTicketNumbers,
} from "@/lib/beads-parser";
import { isDoltProject } from "@/lib/utils";
import type { Bead, BeadStatus } from "@/types";

/** Options for a (re)load of the bead set. */
export interface RefreshOptions {
  /**
   * Ask for an incremental fetch (`updated_after`) instead of a full one.
   *
   * Only a hint: it is ignored when there is nothing cached to merge into, or
   * when the periodic full reconcile is due. Omit it (the default) for
   * user-triggered refreshes after a mutation, where deletions must show up
   * immediately.
   */
  incremental?: boolean;
}

/**
 * Result type for the useBeads hook
 */
export interface UseBeadsResult {
  /** Array of all beads from the project */
  beads: Bead[];
  /** Beads grouped by status for kanban columns */
  beadsByStatus: Record<BeadStatus, Bead[]>;
  /** Map of bead ID to sequential ticket number (1-indexed by creation order) */
  ticketNumbers: Map<string, number>;
  /** Whether beads are loading with nothing to show yet (cold start) */
  isLoading: boolean;
  /** Whether a background refresh is running behind already rendered beads */
  isRevalidating: boolean;
  /** Any error that occurred during loading */
  error: Error | null;
  /** Manually refresh beads (full reconcile unless told otherwise) */
  refresh: (options?: RefreshOptions) => Promise<void>;
}

/** The three views the hook exposes; always derived together. */
interface BeadsState {
  beads: Bead[];
  beadsByStatus: Record<BeadStatus, Bead[]>;
  ticketNumbers: Map<string, number>;
}

/** Derive the grouped and ticket-numbered views from a flat bead list. */
function deriveState(beads: Bead[]): BeadsState {
  return {
    beads,
    beadsByStatus: groupBeadsByStatus(beads),
    ticketNumbers: assignTicketNumbers(beads),
  };
}

const EMPTY_STATE: BeadsState = deriveState([]);

/**
 * Hook to load and watch beads from a project directory.
 *
 * Automatically refreshes when the issues.jsonl file changes.
 *
 * @param projectPath - The absolute path to the project root
 * @returns Object containing beads, grouped beads, loading state, error, and refresh function
 *
 * @example
 * ```tsx
 * function KanbanBoard({ projectPath }: { projectPath: string }) {
 *   const { beadsByStatus, isLoading, error, refresh } = useBeads(projectPath);
 *
 *   if (isLoading) return <Loading />;
 *   if (error) return <Error message={error.message} />;
 *
 *   return (
 *     <div>
 *       <Column title="Open" beads={beadsByStatus.open} />
 *       <Column title="In Progress" beads={beadsByStatus.in_progress} />
 *       <Column title="In Review" beads={beadsByStatus.inreview} />
 *       <Column title="Closed" beads={beadsByStatus.closed} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useBeads(projectPath: string): UseBeadsResult {
  const [state, setState] = useState<BeadsState>(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // `null` is never a valid path, so the seeding block below also runs on mount.
  const [seededPath, setSeededPath] = useState<string | null>(null);

  // Mirror of `state.beads` so an incremental merge can read the current set
  // without a functional setState (which would make the cache write impure).
  const beadsRef = useRef<Bead[]>(EMPTY_STATE.beads);
  // Whether something renderable already exists for the current project.
  const hasLoadedRef = useRef(false);
  // Cursor for incremental fetches.
  const lastUpdatedRef = useRef<string | null>(null);
  // When the last full (reconciling) fetch completed.
  const lastFullFetchAtRef = useRef(0);
  // Path of the request currently in flight — prevents polling overlap.
  const inFlightPathRef = useRef<string | null>(null);
  // Path the hook currently renders, so a late response for a project we have
  // navigated away from cannot overwrite the new one.
  const activePathRef = useRef<string | null>(null);

  // Seed from the module-level cache during render — on mount and on every
  // project change — so a revisited project paints without a spinner frame.
  if (seededPath !== projectPath) {
    const cached = getCachedBeads(projectPath);
    const seeded = cached ? deriveState(cached.beads) : EMPTY_STATE;

    beadsRef.current = seeded.beads;
    hasLoadedRef.current = Boolean(cached);
    lastUpdatedRef.current = cached?.lastUpdatedAt ?? null;
    lastFullFetchAtRef.current = cached?.lastFullFetchAt ?? 0;
    activePathRef.current = projectPath;

    setSeededPath(projectPath);
    setState(seeded);
    setIsLoading(!cached);
    setIsRevalidating(false);
    setError(null);
  }

  /**
   * Load beads for the current project, incrementally when that is safe.
   */
  const loadBeads = useCallback(
    async (options?: RefreshOptions) => {
      if (!projectPath) {
        beadsRef.current = EMPTY_STATE.beads;
        setState(EMPTY_STATE);
        setIsLoading(false);
        setIsRevalidating(false);
        return;
      }

      // Skip if a request for this same project is already in flight.
      if (inFlightPathRef.current === projectPath) return;
      inFlightPathRef.current = projectPath;

      const servingStale = hasLoadedRef.current;
      if (servingStale) {
        setIsRevalidating(true);
      } else {
        setIsLoading(true);
      }

      // Incremental is only safe with a set to merge into, a cursor to ask
      // from, and no reconcile due. Incremental responses carry no deletion
      // signal (and `updated_after` is ignored outright by the Dolt tier), so
      // without the periodic reconcile deleted beads would never leave the UI.
      const incremental =
        Boolean(options?.incremental) &&
        servingStale &&
        lastUpdatedRef.current !== null &&
        !shouldReconcile(projectPath);

      const updatedAfter = incremental ? lastUpdatedRef.current ?? undefined : undefined;

      try {
        const fetched = await loadProjectBeads(projectPath, { updatedAfter });
        const nextBeads = incremental ? mergeBeads(beadsRef.current, fetched) : fetched;
        const nextCursor = maxUpdatedAt(fetched, lastUpdatedRef.current);
        const fullFetchAt = incremental ? lastFullFetchAtRef.current : Date.now();

        setCachedBeads(projectPath, {
          beads: nextBeads,
          lastUpdatedAt: nextCursor,
          lastFullFetchAt: fullFetchAt,
        });

        // A response for a project we have navigated away from still refreshes
        // the cache above, but must not touch the rendered state.
        if (activePathRef.current === projectPath) {
          lastUpdatedRef.current = nextCursor;
          lastFullFetchAtRef.current = fullFetchAt;
          beadsRef.current = nextBeads;
          setState(deriveState(nextBeads));
          setError(null);
          hasLoadedRef.current = true;
        }
      } catch (err) {
        const loadError = err instanceof Error ? err : new Error(String(err));
        if (servingStale) {
          // Keep the stale board on screen — a failed background refresh is not
          // worth blanking the UI for.
          console.warn("Beads refresh failed (non-fatal):", loadError.message);
        } else if (activePathRef.current === projectPath) {
          setError(loadError);
          console.error("Failed to load beads:", loadError);
        }
      } finally {
        if (inFlightPathRef.current === projectPath) {
          inFlightPathRef.current = null;
        }
        if (activePathRef.current === projectPath) {
          setIsLoading(false);
          setIsRevalidating(false);
        }
      }
    },
    [projectPath]
  );

  /**
   * Public refresh — a full reconcile by default, because callers reach for it
   * right after a mutation that may have removed a bead.
   */
  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      await loadBeads(options);
    },
    [loadBeads]
  );

  /** Background revalidation used by the watcher and the dolt:// poller. */
  const revalidate = useCallback(() => {
    void loadBeads({ incremental: true });
  }, [loadBeads]);

  // Load when the project path changes. Stale data (if any) is already on
  // screen by the time this runs, so it behaves as a background revalidation.
  useEffect(() => {
    void loadBeads({ incremental: true });
  }, [loadBeads]);

  // Set up file watcher for real-time updates
  // Note: useFileWatcher expects the project root path, not the full issues.jsonl path,
  // because the backend watch API appends .beads/issues.jsonl to the provided path
  const { error: watchError } = useFileWatcher(
    projectPath,
    revalidate,
    100 // 100ms debounce as per spec
  );

  // Combine any watch error with load error
  useEffect(() => {
    if (watchError && !error) {
      // Only log watch errors, don't surface them as main error
      // since the app can still function without file watching
      console.warn("File watcher error:", watchError);
    }
  }, [watchError, error]);

  // Polling for dolt:// projects (no file watcher available)
  useEffect(() => {
    if (!projectPath || !isDoltProject(projectPath)) return;

    const intervalId = setInterval(revalidate, 15_000);

    return () => clearInterval(intervalId);
  }, [projectPath, revalidate]);

  return {
    beads: state.beads,
    beadsByStatus: state.beadsByStatus,
    ticketNumbers: state.ticketNumbers,
    isLoading,
    isRevalidating,
    error,
    refresh,
  };
}
