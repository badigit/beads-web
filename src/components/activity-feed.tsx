"use client";

import { History, RefreshCw } from "lucide-react";

import { ActivityDays } from "@/components/activity-days";
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

/**
 * One project's activity, as a side panel next to Memory and Agents.
 *
 * The cross-project view lives at `/activity`; this one answers the narrower
 * question "what happened in the project I have open". Data loads only while
 * the panel is open — the event log is the largest table a busy project has.
 */
export function ActivityFeed({ open, onOpenChange, projectPath, onBeadClick }: ActivityFeedProps) {
  const { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh } = useActivity(
    projectPath,
    open
  );

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
          <ActivityDays
            events={events}
            isLoading={isLoading}
            isLoadingMore={isLoadingMore}
            error={error}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onBeadClick={(beadId) => onBeadClick?.(beadId)}
          />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
