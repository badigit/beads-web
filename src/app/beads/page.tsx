"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useRouter } from "next/navigation";

import { ArrowLeft, RefreshCw, Search, Table2, X } from "lucide-react";

import { BeadDetail } from "@/components/bead-detail";
import { BeadGrid } from "@/components/bead-grid";
import { CommentList } from "@/components/comment-list";
import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAllBeads, DEFAULT_GRID_FILTERS, type GridFilters } from "@/hooks/use-all-beads";
import { useBeads } from "@/hooks/use-beads";
import * as api from "@/lib/api";
import { filterRows, labelsOf, sortRows, type GridColumn, type SortDirection } from "@/lib/bead-grid";
import { cn } from "@/lib/utils";
import type { Bead, Project } from "@/types";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "deferred", label: "Deferred" },
  { value: "closed", label: "Closed" },
];

const PRIORITY_OPTIONS = [0, 1, 2, 3];

/** Toggles a value in a filter list. */
function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * The cross-project bead grid.
 *
 * The board shows one project as columns; this shows every project as one list,
 * which is the only way to answer "what is open anywhere" without opening
 * thirty boards. Status, priority and label filters are applied by the backend;
 * sorting and the text search work on the loaded page.
 */
export default function BeadsPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<GridFilters>(DEFAULT_GRID_FILTERS);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<GridColumn>("updated_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const { rows, isLoading, error, truncated, refresh } = useAllBeads(filters);

  const visible = useMemo(
    () => sortRows(filterRows(rows, search), sortColumn, sortDirection),
    [rows, search, sortColumn, sortDirection]
  );
  const labels = useMemo(() => labelsOf(rows), [rows]);

  const handleSort = useCallback((column: GridColumn) => {
    setSortColumn((current) => {
      if (current === column) {
        setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
        return current;
      }
      // A new column starts descending for dates and ascending for everything
      // else — freshest first is what you want from a date, A-Z from a name.
      setSortDirection(column === "updated_at" ? "desc" : "asc");
      return column;
    });
  }, []);

  // Registry lookup, so a row can be opened in its own project.
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((e: unknown) => console.error("Grid: project registry unavailable", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const [selected, setSelected] = useState<{ beadId: string; projectId: string } | null>(null);
  const selectedProject = projects.find((project) => project.id === selected?.projectId);
  const { beads, refresh: refreshBeads } = useBeads(selectedProject?.path ?? "");
  const bead = selected ? (beads.find((item) => item.id === selected.beadId) ?? null) : null;

  const openBead = useCallback((beadId: string, projectId?: string | null) => {
    if (!projectId) return;
    setSelected({ beadId, projectId });
  }, []);

  const openChild = useCallback((child: Bead) => {
    setSelected((current) => (current ? { ...current, beadId: child.id } : current));
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-base">
      <header className="sticky top-0 z-20 border-b border-b-default bg-surface-base/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1400px] items-center gap-3 px-6 py-3">
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

          <Table2 className="size-5 text-t-tertiary" aria-hidden="true" />
          <div className="flex-1">
            <h1 className="text-base font-semibold text-t-primary">All beads</h1>
            <p className="text-xs text-t-muted">
              {isLoading
                ? "Loading…"
                : `${visible.length} of ${rows.length} beads across your projects`}
              {truncated && " · page limit reached, narrow the filters"}
            </p>
          </div>

          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-t-muted"
              aria-hidden="true"
            />
            <Input
              type="text"
              aria-label="Search beads"
              placeholder="Search id, title, project…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 w-[240px] border-b-strong bg-surface-overlay/50 pl-8 pr-8 text-t-primary placeholder:text-t-muted"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-t-muted hover:text-t-secondary"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            mode="icon"
            onClick={refresh}
            aria-label="Reload beads"
            className="text-t-tertiary hover:text-t-primary"
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </Button>
        </div>

        {/* Filters — server-side, so each change refetches rather than hiding
            rows that were already paid for. */}
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-1.5 px-6 pb-3">
          {STATUS_OPTIONS.map((option) => {
            const active = filters.statuses.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    statuses: toggle(current.statuses, option.value),
                  }))
                }
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-epic/20 text-epic"
                    : "bg-surface-overlay/50 text-t-tertiary hover:text-t-secondary"
                )}
              >
                {option.label}
              </button>
            );
          })}

          <span className="mx-1 h-4 w-px bg-b-default" aria-hidden="true" />

          {PRIORITY_OPTIONS.map((priority) => {
            const active = filters.priorities.includes(priority);
            return (
              <button
                key={priority}
                type="button"
                aria-pressed={active}
                aria-label={`Priority ${priority}`}
                onClick={() =>
                  setFilters((current) => ({
                    ...current,
                    priorities: toggle(current.priorities, priority),
                  }))
                }
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors",
                  active
                    ? "bg-epic/20 text-epic"
                    : "bg-surface-overlay/50 text-t-tertiary hover:text-t-secondary"
                )}
              >
                P{priority}
              </button>
            );
          })}

          {labels.length > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-b-default" aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-1.5">
                {labels.slice(0, 12).map(({ label, count }) => {
                  const active = filters.labels.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        setFilters((current) => ({
                          ...current,
                          labels: toggle(current.labels, label),
                        }))
                      }
                      className={cn(
                        "rounded-md px-2 py-1 text-xs transition-colors",
                        active
                          ? "bg-info/20 text-info"
                          : "bg-surface-overlay/50 text-t-tertiary hover:text-t-secondary"
                      )}
                    >
                      {label}
                      <span className="ml-1 tabular-nums text-t-faint">{count}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {(filters.statuses.length > 0 ||
            filters.priorities.length > 0 ||
            filters.labels.length > 0) && (
            <button
              type="button"
              onClick={() => setFilters({ statuses: [], priorities: [], labels: [] })}
              className="ml-auto rounded-md px-2 py-1 text-xs text-danger hover:bg-surface-overlay/50"
            >
              Clear filters
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-3">
        {error && (
          <p className="py-4 text-sm text-danger" role="status">
            {error}
          </p>
        )}

        {!error && isLoading && rows.length === 0 && (
          <div className="space-y-2 py-3" role="status" aria-label="Loading beads">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
              <div key={row} className="h-6 animate-pulse rounded bg-surface-overlay/60" />
            ))}
          </div>
        )}

        {!error && !isLoading && visible.length === 0 && (
          <p className="py-6 text-sm text-t-muted">
            Nothing matches. Loosen the filters or clear the search.
          </p>
        )}

        {visible.length > 0 && (
          <BeadGrid
            rows={visible}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            onRowClick={openBead}
          />
        )}
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
