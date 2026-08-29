"use client";

import { useRouter } from "next/navigation";

import { ArrowLeft, History, RefreshCw } from "lucide-react";

import { ActivityDays } from "@/components/activity-days";
import { Button } from "@/components/ui/button";
import { useAllActivity } from "@/hooks/use-activity";
import { cn } from "@/lib/utils";

/**
 * Cross-project activity: every beads database merged into one timeline.
 *
 * The dashboard's answer to "what have I been working on" — with thirty
 * projects, opening each one to see its own feed is not an answer at all.
 * Rows carry their project, and clicking one opens that bead in its project.
 */
export default function ActivityPage() {
  const router = useRouter();
  const { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh } = useAllActivity();

  const openBead = (beadId: string, projectId?: string | null) => {
    // Without a registry entry there is no project page to open — the feed
    // still shows the row, it just cannot route anywhere.
    if (!projectId) return;
    router.push(`/project?id=${projectId}&bead=${encodeURIComponent(beadId)}`);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-surface-base">
      <header className="sticky top-0 z-20 border-b border-b-default bg-surface-base/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1000px] items-center gap-3 px-6 py-3">
          <Button
            variant="ghost"
            size="sm"
            mode="icon"
            aria-label="Back to projects"
            onClick={() => router.push("/")}
            className="text-t-tertiary hover:text-t-primary"
          >
            <ArrowLeft className="size-4" />
          </Button>

          <History className="size-5 text-t-tertiary" aria-hidden="true" />
          <div className="flex-1">
            <h1 className="text-base font-semibold text-t-primary">Activity</h1>
            <p className="text-xs text-t-muted">
              Everything that happened across all projects, newest first.
            </p>
          </div>

          <Button
            variant="ghost"
            size="sm"
            mode="icon"
            onClick={refresh}
            aria-label="Reload activity"
            className="text-t-tertiary hover:text-t-primary"
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1000px] flex-1 px-6 py-4">
        <ActivityDays
          events={events}
          isLoading={isLoading}
          isLoadingMore={isLoadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onBeadClick={openBead}
          showProject
          emptyMessage="No recorded activity across your projects yet."
        />
      </main>
    </div>
  );
}
