"use client";

import { ArrowDown, ArrowUp } from "lucide-react";

import { LabelChips } from "@/components/label-chips";
import { type GridColumn, type SortDirection } from "@/lib/bead-grid";
import { getStatusDotColor } from "@/lib/bead-utils";
import { cn } from "@/lib/utils";
import { STATUS_MAP, type BeadRow, type KnownRawStatus } from "@/types";

/**
 * The grid shows RAW statuses, not the four board columns: a bead that is
 * `blocked` or `deferred` should say so here, where there are no columns to
 * fold it into. The dot colour still comes from the column it would land in,
 * so the palette matches the board.
 */
function statusDotColor(status: string): string {
  const mapping = status in STATUS_MAP ? STATUS_MAP[status as KnownRawStatus] : undefined;
  return getStatusDotColor(mapping?.column ?? "open");
}

/** `in_progress` -> `In progress`. */
function statusLabel(status: string): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const COLUMNS: { key: GridColumn; label: string; className: string }[] = [
  { key: "id", label: "ID", className: "w-[150px]" },
  { key: "title", label: "Title", className: "" },
  { key: "project", label: "Project", className: "w-[150px]" },
  { key: "status", label: "Status", className: "w-[110px]" },
  { key: "priority", label: "P", className: "w-[52px]" },
  { key: "issue_type", label: "Type", className: "w-[80px]" },
  { key: "updated_at", label: "Updated", className: "w-[92px]" },
];

/** `Aug 29` / `Aug 29, 2025` — enough to place a row in time at a glance. */
function formatDate(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export interface BeadGridProps {
  rows: BeadRow[];
  sortColumn: GridColumn;
  sortDirection: SortDirection;
  /** Clicking a header sorts by it, and flips direction when already sorted. */
  onSort: (column: GridColumn) => void;
  onRowClick?: (beadId: string, projectId?: string | null) => void;
}

/**
 * The cross-project table itself.
 *
 * Dense on purpose: the point of this view is how many beads fit on one screen,
 * so rows are single-line and every column is sized to its content rather than
 * to its longest possible value.
 */
export function BeadGrid({
  rows,
  sortColumn,
  sortDirection,
  onSort,
  onRowClick,
}: BeadGridProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-b-default text-left">
            {COLUMNS.map((column) => {
              const active = sortColumn === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={cn("px-2 py-1.5 font-medium", column.className)}
                  aria-sort={
                    active
                      ? sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => onSort(column.key)}
                    className={cn(
                      "flex items-center gap-1 text-xs uppercase tracking-wide",
                      active ? "text-t-primary" : "text-t-faint hover:text-t-secondary"
                    )}
                  >
                    {column.label}
                    {active &&
                      (sortDirection === "asc" ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden="true" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.project_id ?? row.project_name}:${row.id}`}
              onClick={() => onRowClick?.(row.id, row.project_id)}
              className="cursor-pointer border-b border-b-default/40 hover:bg-surface-overlay/50"
            >
              <td className="max-w-[150px] truncate px-2 py-1.5 font-mono text-xs text-t-muted">
                {row.id}
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "truncate text-t-primary",
                      row.status === "closed" && "text-t-muted line-through decoration-t-faint"
                    )}
                  >
                    {row.title}
                  </span>
                  <LabelChips labels={row.labels} max={2} className="shrink-0" />
                </div>
              </td>
              <td className="max-w-[150px] truncate px-2 py-1.5 text-xs text-t-muted">
                {row.project_name}
              </td>
              <td className="px-2 py-1.5">
                <span className="flex items-center gap-1.5 text-xs text-t-secondary">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full bg-current",
                      statusDotColor(row.status)
                    )}
                    aria-hidden="true"
                  />
                  {statusLabel(row.status)}
                </span>
              </td>
              <td
                className={cn(
                  "px-2 py-1.5 text-xs tabular-nums",
                  row.priority === 0 && "font-semibold text-danger",
                  row.priority === 1 && "font-semibold text-blocked-accent",
                  (row.priority ?? 9) > 1 && "text-t-muted"
                )}
              >
                {row.priority === null || row.priority === undefined ? "" : `P${row.priority}`}
              </td>
              <td className="px-2 py-1.5 text-xs capitalize text-t-muted">{row.issue_type}</td>
              <td className="px-2 py-1.5 text-xs tabular-nums text-t-muted">
                {formatDate(row.updated_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
