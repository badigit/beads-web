"use client";

import { useMemo } from "react";

import { History, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useActivity } from "@/hooks/use-activity";
import { describeRun, groupByDay, isSingleBeadRun, type ActivityRun } from "@/lib/activity";
import { cn } from "@/lib/utils";

export interface ActivityFeedProps {
  /** Whether the panel is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Project root path or `dolt://<database>` */
  projectPath: string;
  /** Open a bead in the detail panel */
  onBeadClick?: (beadId: string) => void;
}

/** `14:32` — the day is already the heading, so a date here would only repeat it. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ActivityRow({
  run,
  onBeadClick,
}: {
  run: ActivityRun;
  onBeadClick?: (beadId: string) => void;
}) {
  // A run over several beads has no single title to show; one over a single
  // bead keeps its title and gathers the specifics after it.
  const folded = run.count > 1 && !isSingleBeadRun(run);
  const title = run.issue_title ?? run.issue_id;
  const details = run.details.join(", ");

  return (
    <li className="flex items-baseline gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-overlay/40">
      <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-t-faint">
        {formatTime(run.created_at)}
      </span>

      <div className="min-w-0 flex-1">
        <span className="text-t-tertiary">{run.actor}</span>{" "}
        <span className="text-t-secondary">{describeRun(run)}</span>{" "}
        {folded ? (
          // A folded run spans several beads — naming one of them would be a lie.
          <span className="font-mono text-xs text-t-faint" title={run.beadIds.join(", ")}>
            {run.beadIds.slice(0, 3).join(", ")}
            {run.beadIds.length > 3 ? ", …" : ""}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onBeadClick?.(run.issue_id)}
            className="text-left text-t-primary underline-offset-2 hover:underline"
          >
            {title}
          </button>
        )}
        {details && !folded && <span className="text-t-muted"> — {details}</span>}
      </div>
    </li>
  );
}

/**
 * Workspace activity feed: what happened in this project, grouped by day.
 *
 * The board answers "what is the state now"; this answers "what did we do" —
 * the question you actually arrive with after a few days away (bweb-lle.1).
 * Data is loaded only while the panel is open: the event log is the largest
 * table a busy project has.
 */
export function ActivityFeed({ open, onOpenChange, projectPath, onBeadClick }: ActivityFeedProps) {
  const { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh } = useActivity(
    projectPath,
    open
  );

  const days = useMemo(() => groupByDay(events), [events]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col border-b-default bg-surface-base sm:max-w-lg md:max-w-xl"
      >
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2 text-t-primary">
            <History className="size-5" aria-hidden="true" />
            Activity
            <Button
              variant="ghost"
              size="sm"
              mode="icon"
              onClick={refresh}
              aria-label="Reload activity"
              className="ml-auto size-7 text-t-tertiary hover:text-t-primary"
            >
              <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
            </Button>
          </SheetTitle>
          <SheetDescription className="text-t-muted">
            What happened in this project, newest first.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="-mx-2 min-h-0 flex-1 px-2">
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
            <p className="px-2 py-6 text-sm text-t-muted">
              No recorded activity yet. Events show up here as beads are created, moved and closed.
            </p>
          )}

          {days.map((day) => (
            <section key={day.key}>
              <h3 className="sticky top-0 z-10 bg-surface-base/95 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-t-faint backdrop-blur">
                {day.label}
              </h3>
              <ul>
                {day.events.map((run) => (
                  <ActivityRow key={run.id} run={run} onBeadClick={onBeadClick} />
                ))}
              </ul>
            </section>
          ))}

          {hasMore && (
            <div className="py-3">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
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
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
