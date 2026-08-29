/**
 * Sorting and text filtering for the cross-project grid.
 *
 * Pure functions, kept out of the component so the ordering rules can be tested
 * without a DOM — and so the grid and any future consumer sort identically.
 */

import type { BeadRow } from "@/types";

export type GridColumn = "id" | "title" | "status" | "priority" | "issue_type" | "project" | "updated_at";
export type SortDirection = "asc" | "desc";

/** Status order for sorting: the workflow's own order, not the alphabet. */
const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
  inreview: 3,
  deferred: 4,
  closed: 5,
};

function statusRank(status: string): number {
  return STATUS_ORDER[status] ?? 99;
}

/** The value a column sorts on. */
function sortKey(row: BeadRow, column: GridColumn): string | number {
  switch (column) {
    case "id":
      return row.id;
    case "title":
      return row.title.toLocaleLowerCase();
    case "status":
      return statusRank(row.status);
    case "priority":
      // A missing priority sorts after every real one instead of ahead of P0.
      return row.priority ?? 99;
    case "issue_type":
      return row.issue_type ?? "";
    case "project":
      return (row.project_name ?? "").toLocaleLowerCase();
    case "updated_at":
      return row.updated_at ?? "";
  }
}

/**
 * Sorts a page of rows. Ties break on id so the order never wobbles between
 * renders of the same data.
 */
export function sortRows(rows: BeadRow[], column: GridColumn, direction: SortDirection): BeadRow[] {
  const factor = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = sortKey(a, column);
    const right = sortKey(b, column);

    if (left === right) return a.id.localeCompare(b.id);
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * factor;
    }
    return String(left).localeCompare(String(right)) * factor;
  });
}

/**
 * Text filter over what is on screen: id, title and project.
 *
 * Trimmed, because a stray space pasted from `bd` output or a chat should not
 * silently empty the grid.
 */
export function filterRows(rows: BeadRow[], search: string): BeadRow[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return rows;

  return rows.filter((row) => {
    const haystack = `${row.id} ${row.title} ${row.project_name ?? ""}`.toLocaleLowerCase();
    return haystack.includes(needle);
  });
}

/** Labels present on the loaded rows, most used first, ties alphabetical. */
export function labelsOf(rows: BeadRow[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const raw of row.labels) {
      const label = raw.trim();
      if (!label) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([label, count]) => ({ label, count })).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label)
  );
}
