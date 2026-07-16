/**
 * Hook for persisting the home-page project sort mode
 * ("alpha" vs "activity") in localStorage.
 *
 * Follows the same hydration-safe pattern as `use-projects-view`:
 * state initialises to the default on the server and first client render,
 * then a `useEffect` reconciles it with the stored value. This avoids a
 * React hydration mismatch while still honouring the previously chosen sort.
 */

import { useState, useEffect, useCallback } from "react";

import type { ProjectsSort } from "@/lib/sort-projects";

/** Default sort when nothing is stored. */
export const DEFAULT_PROJECTS_SORT: ProjectsSort = "alpha";

/** localStorage key for the persisted sort mode. */
export const PROJECTS_SORT_STORAGE_KEY = "beads-web:projects-sort";

/**
 * Safely coerce a raw stored value into a valid `ProjectsSort`.
 *
 * Exported for unit testing of the persistence/validation behaviour.
 */
export function parseStoredSort(stored: string | null): ProjectsSort {
  return stored === "activity" ? "activity" : DEFAULT_PROJECTS_SORT;
}

/** Result type for the `useProjectsSort` hook. */
export interface UseProjectsSortResult {
  /** Currently selected sort mode. */
  sort: ProjectsSort;
  /** Persist and switch to a new sort mode. */
  setSort: (sort: ProjectsSort) => void;
  /** True once the stored value has been reconciled on the client. */
  isLoaded: boolean;
}

/**
 * Manage the persisted project sort mode.
 */
export function useProjectsSort(): UseProjectsSortResult {
  const [sort, setSortState] = useState<ProjectsSort>(DEFAULT_PROJECTS_SORT);
  const [isLoaded, setIsLoaded] = useState(false);

  // Reconcile with localStorage after mount (avoids hydration mismatch).
  useEffect(() => {
    setSortState(parseStoredSort(localStorage.getItem(PROJECTS_SORT_STORAGE_KEY)));
    setIsLoaded(true);
  }, []);

  const setSort = useCallback((next: ProjectsSort) => {
    setSortState(next);
    localStorage.setItem(PROJECTS_SORT_STORAGE_KEY, next);
  }, []);

  return { sort, setSort, isLoaded };
}
