/**
 * Hook for persisting the home-page project list view mode
 * ("cards" vs "list") in localStorage.
 *
 * Follows the same hydration-safe pattern as `use-pr-settings` /
 * `use-theme`: state initialises to the default on the server and first
 * client render, then a `useEffect` reconciles it with the stored value.
 * This avoids a React hydration mismatch while still honouring the
 * previously chosen view.
 */

import { useState, useEffect, useCallback } from "react";

/** Available project list view modes. */
export type ProjectsView = "cards" | "list";

/** Default view when nothing is stored. */
export const DEFAULT_PROJECTS_VIEW: ProjectsView = "list";

/** localStorage key for the persisted view mode. */
export const PROJECTS_VIEW_STORAGE_KEY = "beads-web:projects-view";

/**
 * Safely coerce a raw stored value into a valid `ProjectsView`.
 *
 * Honours an explicitly stored `"cards"` (a prior user choice) even though
 * the default is now `"list"`; only a missing or unrecognised value falls
 * back to the default.
 *
 * Exported for unit testing of the persistence/validation behaviour.
 */
export function parseStoredView(stored: string | null): ProjectsView {
  if (stored === "cards" || stored === "list") return stored;
  return DEFAULT_PROJECTS_VIEW;
}

/** Result type for the `useProjectsView` hook. */
export interface UseProjectsViewResult {
  /** Currently selected view mode. */
  view: ProjectsView;
  /** Persist and switch to a new view mode. */
  setView: (view: ProjectsView) => void;
  /** True once the stored value has been reconciled on the client. */
  isLoaded: boolean;
}

/**
 * Manage the persisted project list view mode.
 */
export function useProjectsView(): UseProjectsViewResult {
  const [view, setViewState] = useState<ProjectsView>(DEFAULT_PROJECTS_VIEW);
  const [isLoaded, setIsLoaded] = useState(false);

  // Reconcile with localStorage after mount (avoids hydration mismatch).
  useEffect(() => {
    setViewState(parseStoredView(localStorage.getItem(PROJECTS_VIEW_STORAGE_KEY)));
    setIsLoaded(true);
  }, []);

  const setView = useCallback((next: ProjectsView) => {
    setViewState(next);
    localStorage.setItem(PROJECTS_VIEW_STORAGE_KEY, next);
  }, []);

  return { view, setView, isLoaded };
}
