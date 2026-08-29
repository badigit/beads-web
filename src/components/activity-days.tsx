"use client";

import { useMemo } from "react";

import {
  ArrowRight,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Tag,
  UserCheck,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeRun, groupByDay, isSingleBeadRun, type ActivityRun } from "@/lib/activity";
import { cn } from "@/lib/utils";
import type { ActivityEvent } from "@/types";

/** `14:32` — the day is already the heading, so a date here would only repeat it. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * What kind of action a row is, shown as colour and a mark instead of a word.
 *
 * A feed is scanned, not read: a tinted row with an icon lands in one glance,
 * where "created"/"updated"/"closed" spelled out on every line is a column of
 * noise. The word survives in the tooltip and the accessible name, so nothing
 * is lost for a screen reader or for a second look.
 *
 * The two events worth spotting from across the room get the strong colours —
 * new work is blue, finished work is green. Everything else stays neutral on
 * purpose: if every kind is highlighted, none is.
 */
const EVENT_MARKS: Record<string, { icon: LucideIcon; icon_color: string; row: string }> = {
  created: { icon: Plus, icon_color: "text-info", row: "bg-info/10 border-l-info" },
  closed: { icon: Check, icon_color: "text-success", row: "bg-success/10 border-l-success" },
  reopened: { icon: RotateCcw, icon_color: "text-warning", row: "bg-warning/10 border-l-warning" },
  status_changed: { icon: ArrowRight, icon_color: "text-t-secondary", row: "border-l-b-strong" },
  claimed: { icon: UserCheck, icon_color: "text-t-secondary", row: "border-l-b-strong" },
  updated: { icon: Pencil, icon_color: "text-t-muted", row: "border-l-transparent" },
  label_added: { icon: Tag, icon_color: "text-t-muted", row: "border-l-transparent" },
  label_removed: { icon: Tag, icon_color: "text-t-faint", row: "border-l-transparent" },
  comment_added: { icon: MessageSquare, icon_color: "text-t-muted", row: "border-l-transparent" },
};

const FALLBACK_MARK = {
  icon: Pencil,
  icon_color: "text-t-faint",
  row: "border-l-transparent",
};

export interface ActivityDaysProps {
  events: ActivityEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Open a bead. Given the project too, so a cross-project feed can route. */
  onBeadClick?: (beadId: string, projectId?: string | null) => void;
  /** Append the project name to each row (cross-project feed only). */
  showProject?: boolean;
  /** Shown when there is nothing to display. */
  emptyMessage?: string;
}

function ActivityRow({
  run,
  onBeadClick,
  showProject,
}: {
  run: ActivityRun;
  onBeadClick?: (beadId: string, projectId?: string | null) => void;
  showProject?: boolean;
}) {
  // A run over several beads has no single title to show; one over a single
  // bead keeps its title and gathers the specifics after it.
  const folded = run.count > 1 && !isSingleBeadRun(run);
  const title = run.issue_title ?? run.issue_id;
  const details = run.details.join(", ");
  const mark = EVENT_MARKS[run.event_type] ?? FALLBACK_MARK;
  const Icon = mark.icon;
  const action = describeRun(run);

  return (
    <li
      className={cn(
        // The whole row carries the colour, not just the icon: a 14px glyph is
        // not something you spot while scrolling a hundred events.
        "flex items-start gap-2 rounded border-l-2 px-2 py-1.5 text-sm transition-colors hover:bg-surface-overlay/60",
        mark.row
      )}
    >
      <span className="w-10 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-t-faint">
        {formatTime(run.created_at)}
      </span>

      <span
        className={cn("flex w-4 shrink-0 justify-center pt-0.5", mark.icon_color)}
        title={action}
      >
        <Icon className="size-4" aria-hidden="true" />
        <span className="sr-only">{action}</span>
      </span>

      <div className="min-w-0 flex-1">
        {/* One event is one line: a close reason can run to a paragraph, and a
            feed you scan must not reflow around it. */}
        <div className="truncate">
          {folded ? (
            <span className="font-mono text-xs text-t-faint" title={run.beadIds.join(", ")}>
              <span className="tabular-nums text-t-muted">×{run.count}</span>{" "}
              {run.beadIds.slice(0, 3).join(", ")}
              {run.beadIds.length > 3 ? ", …" : ""}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onBeadClick?.(run.issue_id, run.project_id)}
              className="text-left text-t-primary underline-offset-2 hover:underline"
            >
              {title}
            </button>
          )}
          {details && !folded && <span className="text-t-muted"> — {details}</span>}
        </div>

        {/* The project goes under the title: in a cross-project feed it is the
            second thing you need, and on one line it competed with the title
            for the same truncation budget. */}
        {showProject && run.project_name && (
          <div className="truncate text-xs text-t-muted">{run.project_name}</div>
        )}
      </div>
    </li>
  );
}

/**
 * The feed itself: events grouped into days, runs folded, one row per line.
 *
 * Shared by the per-project panel and the cross-project page so a row looks and
 * behaves the same in both; only the data source and the project suffix differ.
 */
export function ActivityDays({
  events,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  onLoadMore,
  onBeadClick,
  showProject,
  emptyMessage = "No recorded activity yet. Events show up here as beads are created, moved and closed.",
}: ActivityDaysProps) {
  const days = useMemo(() => groupByDay(events), [events]);

  return (
    <>
      {error && (
        <p className="px-2 py-4 text-sm text-danger" role="status">
          {error}
        </p>
      )}

      {!error && isLoading && events.length === 0 && (
        <div className="space-y-2 py-3" role="status" aria-label="Loading activity">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="h-4 animate-pulse rounded bg-surface-overlay/60" />
          ))}
        </div>
      )}

      {!error && !isLoading && events.length === 0 && (
        <p className="px-2 py-6 text-sm text-t-muted">{emptyMessage}</p>
      )}

      {days.map((day) => (
        <section key={day.key}>
          <h3 className="sticky top-0 z-10 bg-surface-base/95 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-t-faint backdrop-blur">
            {day.label}
          </h3>
          <ul>
            {day.events.map((run) => (
              <ActivityRow
                key={run.id}
                run={run}
                onBeadClick={onBeadClick}
                showProject={showProject}
              />
            ))}
          </ul>
        </section>
      ))}

      {hasMore && (
        <div className="py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="w-full"
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Loading…
              </>
            ) : (
              "Load older"
            )}
          </Button>
        </div>
      )}
    </>
  );
}
