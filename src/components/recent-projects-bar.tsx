"use client";

import { useEffect, useMemo, useState } from "react";

import { useSearchParams } from "next/navigation";

import * as api from "@/lib/api";
import { selectRecentProjects } from "@/lib/recent-projects";
import type { Project } from "@/types";

/**
 * Horizontal strip of recently opened projects, mounted globally in the root
 * layout so switching projects is one click from anywhere.
 *
 * It sits in normal flow (not sticky): the pages that have their own
 * `sticky top-0` header — settings, for one — keep working unchanged, because
 * the bar has already scrolled away by the time their header pins itself.
 * Height is reserved via `--recent-bar-h` (see globals.css), which the page
 * shells subtract from their own height, so mounting the bar adds no scrollbar
 * and the content below never jumps once the async list lands.
 */
export function RecentProjectsBar() {
  const searchParams = useSearchParams();
  const currentId = searchParams.get("id");
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => {
        console.warn("Failed to load recent projects:", err);
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recent = useMemo(
    () => selectRecentProjects(projects ?? [], currentId),
    [projects, currentId]
  );

  return (
    <nav
      aria-label="Recent projects"
      className="h-[var(--recent-bar-h)] shrink-0 border-b border-b-default bg-surface-raised"
    >
      <div className="flex h-full items-center gap-1 overflow-x-auto px-2">
        {recent.map((project) =>
          project.isCurrent ? (
            <span
              key={project.id}
              aria-current="page"
              className="max-w-48 shrink-0 truncate rounded-md bg-surface-overlay px-2 py-1 text-xs font-medium text-t-primary"
            >
              {project.name}
            </span>
          ) : (
            <a
              key={project.id}
              href={`/project?id=${encodeURIComponent(project.id)}`}
              className="max-w-48 shrink-0 truncate rounded-md px-2 py-1 text-xs text-t-tertiary transition-colors duration-150 hover:bg-surface-overlay/50 hover:text-t-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-t-tertiary"
            >
              {project.name}
            </a>
          )
        )}
      </div>
    </nav>
  );
}
