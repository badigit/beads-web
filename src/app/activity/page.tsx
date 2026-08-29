"use client";

import { useCallback, useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { ArrowLeft, History, RefreshCw } from "lucide-react";

import { ActivityDays } from "@/components/activity-days";
import { BeadDetail } from "@/components/bead-detail";
import { CommentList } from "@/components/comment-list";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import { useAllActivity } from "@/hooks/use-activity";
import { useBeads } from "@/hooks/use-beads";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Bead, Project } from "@/types";

/**
 * Cross-project activity: every beads database merged into one timeline.
 *
 * The dashboard's answer to "what have I been working on" — with thirty
 * projects, opening each one to read its own feed is not an answer at all.
 *
 * A row opens its bead in the same detail panel the board uses, right here:
 * being thrown onto another page to read one bead defeats the point of having
 * everything in one list.
 */
export default function ActivityPage() {
  const router = useRouter();
  const { events, isLoading, isLoadingMore, error, hasMore, loadMore, refresh } = useAllActivity();

  // The feed carries project ids; the path (needed to read beads and to write
  // through bd) lives in the registry, so the list is fetched once.
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((e: unknown) => {
        console.error("Activity: project registry unavailable", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [selected, setSelected] = useState<{ beadId: string; projectId: string } | null>(null);
  const selectedProject = projects.find((project) => project.id === selected?.projectId);

  // Beads of the clicked project only: the detail panel needs siblings to
  // resolve dependencies, children and blocked state. Loading stays scoped to
  // one project and is cached by the hook between clicks.
  const { beads, refresh: refreshBeads } = useBeads(selectedProject?.path ?? "");
  const bead = selected ? (beads.find((item) => item.id === selected.beadId) ?? null) : null;

  const openBead = useCallback((beadId: string, projectId?: string | null) => {
    // Without a registry entry there is nothing to load the bead from — the row
    // still renders, it just cannot be opened.
    if (!projectId) return;
    setSelected({ beadId, projectId });
  }, []);

  const openChild = useCallback((child: Bead) => {
    setSelected((current) => (current ? { ...current, beadId: child.id } : current));
  }, []);

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

      <ErrorBoundary label="Bead Detail">
        {bead && selectedProject && (
          <BeadDetail
            bead={bead}
            open
            onOpenChange={(open) => {
              if (!open) setSelected(null);
            }}
            projectPath={selectedProject.path}
            projectId={selectedProject.id}
            allBeads={beads}
            onChildClick={openChild}
            onUpdate={refreshBeads}
          >
            <CommentList
              comments={bead.comments}
              beadId={bead.id}
              projectPath={selectedProject.path}
              onCommentAdded={refreshBeads}
            />
          </BeadDetail>
        )}
      </ErrorBoundary>
    </div>
  );
}
