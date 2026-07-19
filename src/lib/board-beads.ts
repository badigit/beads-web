/**
 * Pure selection logic for which beads become cards on the kanban board.
 *
 * Extracted from `kanban-board.tsx` so the rules can be unit tested without
 * rendering the board.
 */

import type { Bead } from "@/types";

/**
 * Issue type filter options for the board.
 */
export type IssueTypeFilter = "all" | "epics" | "tasks";

/**
 * Whether the board should render in flat search mode.
 *
 * Trimmed to match `use-bead-filters`, which trims before matching — a
 * whitespace-only query filters nothing, so the board must stay in the
 * normal hierarchy view.
 */
export function isFlatSearchMode(search: string): boolean {
  return search.trim() !== "";
}

/**
 * Apply the epics/tasks type filter.
 */
function applyTypeFilter(beads: Bead[], typeFilter: IssueTypeFilter): Bead[] {
  if (typeFilter === "epics") return beads.filter((b) => b.issue_type === "epic");
  if (typeFilter === "tasks") return beads.filter((b) => b.issue_type !== "epic");
  return beads;
}

/**
 * Pick the beads that get their own card on the board.
 *
 * Two modes:
 * - **No search** — only top-level beads (no `parent_id`) get a card; children
 *   are rendered inside their epic's card. This is the normal hierarchy view.
 * - **Active search (flat mode)** — every match gets its own card regardless of
 *   depth. Nesting here is two levels deep and `SubtaskList` renders only
 *   *direct* children, so a matching grandchild is unreachable from its root
 *   epic; without flat mode 57% of this project's beads were invisible to
 *   board search (bweb-emj).
 *
 * @param filteredBeads - beads already passed through `useBeadFilters`
 * @param typeFilter - epics/tasks/all toggle
 * @param search - the debounced search term
 */
export function selectBoardBeads(
  filteredBeads: Bead[],
  typeFilter: IssueTypeFilter,
  search: string
): Bead[] {
  const candidates = isFlatSearchMode(search)
    ? filteredBeads
    : filteredBeads.filter((b) => !b.parent_id);

  return applyTypeFilter(candidates, typeFilter);
}
