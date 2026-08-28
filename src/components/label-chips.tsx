"use client";

import { cn } from "@/lib/utils";

export interface LabelChipsProps {
  /** Labels carried by the bead. Missing/empty renders nothing. */
  labels?: string[];
  /**
   * How many chips to render before collapsing the rest into a `+N` chip.
   * Cards are dense — a bead with eight labels must not push its title out.
   */
  max?: number;
  className?: string;
}

/**
 * Read-only row of label chips for a bead.
 *
 * Labels live in a flat `(issue_id, label)` link table with no dictionary and
 * no colours, so every chip is rendered the same neutral way — the text is the
 * whole signal. Shared by the kanban card, the flat list row and the detail
 * panel so a label looks identical wherever it shows up.
 */
export function LabelChips({ labels, max = 3, className }: LabelChipsProps) {
  const visible = (labels ?? []).filter((label) => label.trim() !== "");
  if (visible.length === 0) return null;

  const shown = visible.slice(0, max);
  const hidden = visible.slice(max);

  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((label) => (
        <span
          key={label}
          className="theme-badge max-w-[140px] truncate border border-b-default/60 bg-surface-overlay/80 px-1.5 py-0.5 text-[10px] font-medium text-t-tertiary"
        >
          {label}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.join(", ")}
          className="theme-badge border border-b-default/60 bg-surface-overlay/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-t-faint"
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
