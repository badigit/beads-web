/**
 * Hook for persisting the project board view mode ("kanban" vs "list")
 * in localStorage.
 *
 * Mirrors `use-projects-view`: state initialises to the default on the
 * server and first client render, then a `useEffect` reconciles it with
 * the stored value. This avoids a React hydration mismatch while still
 * honouring the previously chosen view.
 */

import { useState, useEffect, useCallback } from "react";

/** Available board view modes. */
export type BoardView = "kanban" | "list";

/** Default view when nothing is stored. */
export const DEFAULT_BOARD_VIEW: BoardView = "kanban";

/** localStorage key for the persisted board view mode. */
export const BOARD_VIEW_STORAGE_KEY = "beads-web:board-view";

/**
 * Safely coerce a raw stored value into a valid `BoardView`.
 *
 * Only a recognised `"kanban"` / `"list"` survives; a missing or unknown
 * value falls back to the default.
 *
 * Exported for unit testing of the persistence/validation behaviour.
 */
export function parseStoredBoardView(stored: string | null): BoardView {
  if (stored === "kanban" || stored === "list") return stored;
  return DEFAULT_BOARD_VIEW;
}

/** Result type for the `useBoardView` hook. */
export interface UseBoardViewResult {
  /** Currently selected view mode. */
  view: BoardView;
  /** Persist and switch to a new view mode. */
  setView: (view: BoardView) => void;
  /** True once the stored value has been reconciled on the client. */
  isLoaded: boolean;
}

/**
 * Manage the persisted board view mode.
 */
export function useBoardView(): UseBoardViewResult {
  const [view, setViewState] = useState<BoardView>(DEFAULT_BOARD_VIEW);
  const [isLoaded, setIsLoaded] = useState(false);

  // Reconcile with localStorage after mount (avoids hydration mismatch).
  useEffect(() => {
    setViewState(parseStoredBoardView(localStorage.getItem(BOARD_VIEW_STORAGE_KEY)));
    setIsLoaded(true);
  }, []);

  const setView = useCallback((next: BoardView) => {
    setViewState(next);
    localStorage.setItem(BOARD_VIEW_STORAGE_KEY, next);
  }, []);

  return { view, setView, isLoaded };
}
