"use client";

import { useState, useEffect, useCallback, useRef } from "react";

import * as api from "@/lib/api";
import {
  getProjectsWithTags,
  createProject,
  type CreateProjectInput,
} from "@/lib/db";
import {
  findUnlistedDatabases,
  ignoredNamesForProject,
  loadIgnoredDatabases,
  addIgnoredDatabases,
  projectRegistrationFor,
  databaseNameForProject,
} from "@/lib/dolt-autosync";
import type { Project, Tag, BeadCounts } from "@/types";

interface UseProjectsResult {
  projects: Project[];
  isLoading: boolean;
  loadingStatus: string | null;
  error: Error | null;
  showArchived: boolean;
  refetch: () => Promise<void>;
  /** Refetch, preceded by a scan for Dolt databases missing from the registry. */
  refresh: () => Promise<void>;
  addProject: (input: CreateProjectInput) => Promise<Project>;
  updateProjectTags: (projectId: string, tags: Tag[]) => void;
  archiveProject: (id: string) => Promise<void>;
  unarchiveProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  toggleShowArchived: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const loadingRef = useRef(0);
  const beadsAbortRef = useRef<AbortController | null>(null);
  const showArchivedRef = useRef(false);
  const projectsRef = useRef<Project[]>([]);
  const syncedRef = useRef(false);

  // Keep refs in sync with state
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  const fetchProjects = useCallback(async () => {
    const loadId = ++loadingRef.current;

    // Abort any previous beads loading cycle FIRST to free browser connections
    if (beadsAbortRef.current) {
      beadsAbortRef.current.abort();
      beadsAbortRef.current = null;
    }

    try {
      setError(null);

      const data = await getProjectsWithTags(showArchivedRef.current);
      if (loadId !== loadingRef.current) return;

      // Show projects immediately. Seed bead counts from (in priority order):
      //   1. The previous in-memory project (covers live refreshes).
      //   2. The server-provided `cachedCounts` from the SQLite cache
      //      (covers cold loads — instant donut paint).
      //   3. `zeroCounts` as a last-resort empty state. In that case
      //      `countsLoaded` stays false so the card can render a dashed
      //      placeholder donut instead of misleading "0/0/0/0" values.
      const zeroCounts: BeadCounts = { open: 0, in_progress: 0, inreview: 0, closed: 0 };
      setProjects((prev) => {
        const prevMap = new Map(prev.map((p) => [p.id, p]));
        return data.map((p) => {
          const prevProject = prevMap.get(p.id);
          const cached = p.cachedCounts ?? null;

          // Prefer previous in-memory counts (freshest), then server cache.
          const hasPrev = prevProject?.beadCounts !== undefined && prevProject.countsLoaded === true;
          const beadCounts: BeadCounts = hasPrev
            ? prevProject!.beadCounts!
            : cached
              ? {
                  open: cached.open,
                  in_progress: cached.in_progress,
                  inreview: cached.inreview,
                  closed: cached.closed,
                }
              : zeroCounts;

          const dataSource = hasPrev
            ? prevProject!.dataSource
            : cached?.dataSource ?? undefined;

          const countsLoaded = hasPrev || cached !== null;

          return {
            ...p,
            beadCounts,
            dataSource: dataSource ?? undefined,
            countsLoaded,
          };
        });
      });
      setIsLoading(false);

      beadsAbortRef.current = new AbortController();
      const beadsSignal = beadsAbortRef.current.signal;

      // Skip beads loading for archived projects
      const activeData = data.filter(p => !p.archivedAt);

      // Then load counts per-project, updating each as it completes.
      // This hits the aggregate endpoint (`/api/beads/counts`) — the donut
      // only needs four numbers, so downloading every bead with its
      // descriptions, comments and dependencies would be pure waste.
      let loaded = 0;
      const total = activeData.length;

      const loadBeads = async (project: Project) => {
        try {
          if (beadsSignal.aborted) return null;
          const result = await api.beads.counts(project.path);
          if (beadsSignal.aborted) return null;
          return {
            id: project.id,
            beadCounts: result.counts,
            dataSource: result.source,
            beadError: undefined,
          };
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return null;
          const message = err instanceof Error ? err.message : 'Unknown error';
          return { id: project.id, beadCounts: zeroCounts, dataSource: undefined, beadError: message };
        }
      };

      // Limit concurrent beads requests to avoid overloading Dolt servers
      const MAX_CONCURRENT = 3;
      let running = 0;
      const queue = [...activeData];

      await new Promise<void>((resolve) => {
        const next = () => {
          while (running < MAX_CONCURRENT && queue.length > 0) {
            const project = queue.shift()!;
            running++;
            loadBeads(project).then((result) => {
              running--;
              if (result && loadId === loadingRef.current) {
                loaded++;
                setLoadingStatus(
                  loaded < total
                    ? `Loading beads: ${project.name} (${loaded}/${total})`
                    : null
                );
                setProjects((prev) =>
                  prev.map((p) =>
                    p.id === result.id
                      ? {
                          ...p,
                          beadCounts: result.beadCounts,
                          dataSource: result.dataSource,
                          beadError: result.beadError,
                          // Fresh data has landed — donut should switch from
                          // dashed (if it was dashed) to solid.
                          countsLoaded: true,
                        }
                      : p
                  )
                );
              }
              if (queue.length === 0 && running === 0) {
                resolve();
              } else {
                next();
              }
            });
          }
          // Handle edge case: empty queue from the start
          if (queue.length === 0 && running === 0) {
            resolve();
          }
        };
        next();
      });
    } catch (err) {
      if (loadId !== loadingRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch projects"));
      setIsLoading(false);
      setLoadingStatus(null);
    }
  }, []);

  const addProject = useCallback(
    async (input: CreateProjectInput): Promise<Project> => {
      const newProject = await createProject(input);
      await fetchProjects();
      return newProject;
    },
    [fetchProjects]
  );

  const updateProjectTags = useCallback((projectId: string, tags: Tag[]) => {
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId ? { ...project, tags } : project
      )
    );
  }, []);

  const archiveProject = useCallback(async (id: string) => {
    await api.projects.archive(id);
    await fetchProjects();
  }, [fetchProjects]);

  const unarchiveProject = useCallback(async (id: string) => {
    await api.projects.unarchive(id);
    await fetchProjects();
  }, [fetchProjects]);

  const deleteProject = useCallback(async (id: string) => {
    // Remember the removal so the auto-sync below does not bring the database
    // back on the next refresh. A filesystem project keeps the database name
    // out of reach of the browser, so it is read back from discovery — without
    // it the project returns under its folder name on the very next sync.
    const removed = projectsRef.current.find((project) => project.id === id);
    if (removed) {
      let databaseName: string | null = null;
      try {
        const { databases } = await api.dolt.databases();
        databaseName = databaseNameForProject(removed, databases);
      } catch (err) {
        // Dolt unreachable means the auto-sync cannot resurrect anything
        // either, so losing the database name here costs nothing.
        console.error("Dolt: failed to resolve database before delete", err);
      }
      addIgnoredDatabases(
        ignoredNamesForProject(removed.name, removed.path, databaseName)
      );
    }
    await api.projects.delete(id);
    await fetchProjects();
  }, [fetchProjects]);

  /**
   * Register Dolt databases that have no project yet.
   *
   * A database created straight on the central server (`bd init`) is invisible
   * in the dashboard until it lands in the local registry — this closes that
   * gap without the user going through Add Project. The server resolves each
   * database to its project folder when that folder exists on this machine, so
   * the registration is a full filesystem project rather than a read-only
   * `dolt://` entry (see `projectRegistrationFor`).
   */
  const syncDoltDatabases = useCallback(async (): Promise<number> => {
    let unlisted: Awaited<ReturnType<typeof api.dolt.databases>>["databases"] = [];
    try {
      const [{ databases }, existing] = await Promise.all([
        api.dolt.databases(),
        getProjectsWithTags(true),
      ]);
      unlisted = findUnlistedDatabases(
        databases,
        existing.map((project) => project.name),
        loadIgnoredDatabases()
      );
    } catch (err) {
      // Dolt being unreachable must not take the project list down with it.
      console.error("Dolt auto-sync: failed to list databases", err);
      return 0;
    }

    let added = 0;
    for (const database of unlisted) {
      try {
        await createProject(projectRegistrationFor(database));
        added++;
      } catch (err) {
        console.error(`Dolt auto-sync: failed to add "${database.name}"`, err);
      }
    }
    return added;
  }, []);

  const refresh = useCallback(async () => {
    await syncDoltDatabases();
    await fetchProjects();
  }, [syncDoltDatabases, fetchProjects]);

  const toggleShowArchived = useCallback(() => {
    setShowArchived(prev => !prev);
  }, []);

  // Fetch projects on mount and when showArchived changes
  useEffect(() => {
    fetchProjects();
    return () => {
      beadsAbortRef.current?.abort();
    };
  }, [fetchProjects, showArchived]);

  // Pick up databases created outside the dashboard — once per mount, after the
  // list is on screen, so discovery never delays the first paint.
  useEffect(() => {
    if (syncedRef.current) return;
    syncedRef.current = true;
    syncDoltDatabases().then((added) => {
      if (added > 0) fetchProjects();
    });
  }, [syncDoltDatabases, fetchProjects]);

  return {
    projects,
    isLoading,
    loadingStatus,
    error,
    showArchived,
    refetch: fetchProjects,
    refresh,
    addProject,
    updateProjectTags,
    archiveProject,
    unarchiveProject,
    deleteProject,
    toggleShowArchived,
  };
}
