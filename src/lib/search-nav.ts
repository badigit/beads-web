/**
 * Pure helpers for the global search palette.
 *
 * Kept free of React/DOM so the navigation and routing rules can be unit
 * tested without rendering the dialog.
 */

import type { SearchResult } from '@/lib/api';
import { buildProjectUrl } from '@/lib/bead-link';

/**
 * Minimal shape of a keyboard event needed to decide on the shortcut.
 */
export interface SearchShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Computes the next highlighted row index for arrow-key navigation.
 *
 * Wraps around at both ends. `current < 0` means "nothing highlighted yet":
 * moving down lands on the first row, moving up on the last one.
 * Returns `-1` when the list is empty.
 */
export function nextResultIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return (current + direction + total) % total;
}

/**
 * Builds the route for a hit — straight to the specific bead's detail card,
 * not just the board — or `null` when the Dolt database is not registered as
 * a local project (nothing to navigate to).
 */
export function searchResultHref(result: Pick<SearchResult, 'project_id' | 'bead_id'>): string | null {
  if (!result.project_id) return null;
  return buildProjectUrl(result.project_id, result.bead_id);
}

/**
 * Whether a hit can be opened — i.e. it maps to a local project.
 */
export function isSearchResultNavigable(result: Pick<SearchResult, 'project_id' | 'bead_id'>): boolean {
  return searchResultHref(result) !== null;
}

/**
 * Whether a pathname is the projects home page.
 *
 * The home page hosts its own always-visible search field, so the global
 * dialog palette and its floating trigger stand down there. Tolerates a
 * trailing slash and an empty/null pathname (both mean the root route).
 */
export function isHomePath(pathname: string | null | undefined): boolean {
  if (!pathname) return true;
  const normalized = pathname.replace(/\/+$/, '');
  return normalized === '';
}

/**
 * Whether a keydown should open the palette.
 *
 * Stays out of the way when the palette is already open (the input owns the
 * keyboard then) and when focus sits in another editable field, so the native
 * Ctrl+K behaviour of those inputs is preserved.
 */
export function shouldOpenSearchPalette(
  event: SearchShortcutEvent,
  isOpen: boolean,
  isEditableTarget: boolean
): boolean {
  if (isOpen || isEditableTarget) return false;
  if (event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === 'k';
}
