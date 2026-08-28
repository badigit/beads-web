"use client";

import { CornerDownRight, PackageOpen } from "lucide-react";

import { CopyableText } from "@/components/copyable-text";
import { LabelChips } from "@/components/label-chips";
import { formatStatus, getStatusDotColor, isBlocked, truncate } from "@/lib/bead-utils";
import { cn } from "@/lib/utils";
import type { Bead } from "@/types";

/**
 * Human-readable type label for a row.
 *
 * Epics are called out explicitly; everything else shows its raw issue type
 * (task / bug / feature) capitalised, which is strictly more information than
 * the kanban card's Epic/Task collapse and helps the dense flat list stay
 * scannable.
 */
function formatType(bead: Bead): string {
  if (bead.issue_type === "epic") return "Epic";
  const t = bead.issue_type || "task";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface BoardListRowProps {
  bead: Bead;
  /** All beads on the board, used to resolve dep statuses for blocked detection. */
  allBeads: Bead[];
  ticketNumber?: number;
  isSelected?: boolean;
  onSelect: (bead: Bead) => void;
}

/**
 * A single dense row of the flat list view.
 *
 * Layout mirrors the beads-ui reference: `grid-template-columns: 1fr auto`,
 * with status and priority/type stacked on the right. The whole row is one
 * activation target (role="button") that opens the detail panel; the bead id
 * is a nested CopyableText that stops propagation so copying never opens the
 * panel.
 */
export function BoardListRow({
  bead,
  allBeads,
  ticketNumber,
  isSelected = false,
  onSelect,
}: BoardListRowProps) {
  const blocked = isBlocked(bead, allBeads);
  const isClosed = bead.status === "closed";
  const statusLabel = formatStatus(bead.status);

  return (
    <div
      data-bead-id={bead.id}
      role="button"
      tabIndex={0}
      aria-label={`Bead ${bead.id}: ${bead.title}, status ${statusLabel}`}
      onClick={() => onSelect(bead)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(bead);
        }
      }}
      className={cn(
        "grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5",
        "border-b border-b-default/50 last:border-b-0 cursor-pointer",
        "hover:bg-surface-overlay/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isClosed && "opacity-50",
        isSelected && "bg-info/5"
      )}
    >
      {/* Left: id/ticket + title, with a child breadcrumb underneath */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <CopyableText
            copyText={bead.id}
            label={`Copy bead id ${bead.id}`}
            className="shrink-0 font-mono text-xs text-t-muted tabular-nums"
          >
            {ticketNumber !== undefined && (
              <>
                <span className="font-semibold text-t-secondary">#{ticketNumber}</span>{" "}
              </>
            )}
            <span className="inline-block max-w-[120px] truncate align-bottom">{bead.id}</span>
          </CopyableText>
          <span
            className={cn(
              "truncate text-sm text-t-primary",
              isClosed && "line-through decoration-t-faint"
            )}
          >
            {truncate(bead.title, 90)}
          </span>
          <LabelChips labels={bead.labels} max={2} className="shrink-0" />
        </div>
        {bead.parent_id && (
          <div
            className="mt-0.5 flex items-center gap-1 text-[10px] text-t-muted"
            title={`Child of ${bead.parent_id}`}
          >
            <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">in {bead.parent_id}</span>
          </div>
        )}
      </div>

      {/* Right: status (dot + label) stacked over priority/type */}
      <div className="grid shrink-0 justify-items-end gap-1 text-right">
        <span className="flex items-center gap-1.5 text-[11px]">
          <span
            className={cn("size-2 shrink-0 rounded-full bg-current", getStatusDotColor(bead.status))}
            aria-hidden="true"
          />
          <span className="text-t-secondary">{statusLabel}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-t-tertiary">
          {blocked && <span className="font-semibold text-danger">Blocked</span>}
          <span
            className={cn(
              "tabular-nums",
              bead.priority === 0 && "font-semibold text-danger",
              bead.priority === 1 && "font-semibold text-blocked-accent"
            )}
          >
            P{bead.priority}
          </span>
          <span>{formatType(bead)}</span>
        </span>
      </div>
    </div>
  );
}

export interface BoardListProps {
  /**
   * The beads to render, one row each. Already filtered, type-filtered and
   * sorted by the board (via `selectListBeads`) — the list renders them flat
   * at all depths and does not re-order them.
   */
  beads: Bead[];
  /** All beads for resolving dep statuses (blocked detection). */
  allBeads: Bead[];
  selectedBeadId?: string | null;
  ticketNumbers?: Map<string, number>;
  onSelectBead: (bead: Bead) => void;
}

/**
 * Dense flat list view of the board — an alternative to the kanban columns
 * that fits many more tasks on screen with less scrolling.
 *
 * Status is a per-row field (no status columns, no grouping); every bead is
 * its own row regardless of depth, with child rows carrying a parent
 * breadcrumb. There is no drag-and-drop here — status changes happen in the
 * detail panel, same as everywhere else.
 */
export function BoardList({
  beads,
  allBeads,
  selectedBeadId,
  ticketNumbers,
  onSelectBead,
}: BoardListProps) {
  if (beads.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-b-strong/50 px-10 py-8">
          <PackageOpen className="mb-2 size-8 text-t-muted" aria-hidden="true" />
          <span className="text-sm text-t-muted">No beads</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="overflow-hidden rounded-md border border-b-default/50 bg-surface-raised/30">
        {beads.map((bead) => (
          <BoardListRow
            key={bead.id}
            bead={bead}
            allBeads={allBeads}
            ticketNumber={ticketNumbers?.get(bead.id)}
            isSelected={selectedBeadId === bead.id}
            onSelect={onSelectBead}
          />
        ))}
      </div>
    </div>
  );
}
