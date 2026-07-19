"use client";

/**
 * Hook for loading and managing a project's bd memories.
 *
 * Backed by `bd remember` / `bd memories` / `bd recall` / `bd forget` via
 * `/api/memory`. Memories live in the project's Dolt database and are injected
 * into agent sessions at `bd prime`, so anything created here is immediately
 * visible to `bd memories` on the command line, and vice versa.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import * as api from "@/lib/api";
import { isDoltProject } from "@/lib/utils";
import type { MemoryEntry, MemoryStats } from "@/types";

export interface UseMemoryResult {
  /** All memory entries for the project */
  entries: MemoryEntry[];
  /** Aggregate stats */
  stats: MemoryStats | null;
  /** Whether entries are currently being loaded */
  isLoading: boolean;
  /** Any error that occurred during loading */
  error: Error | null;
  /** Current search query */
  search: string;
  /** Set search query */
  setSearch: (value: string) => void;
  /** Entries filtered by the search query */
  filteredEntries: MemoryEntry[];
  /** Create a new memory */
  createEntry: (key: string, content: string) => Promise<void>;
  /** Replace an existing memory's content */
  editEntry: (key: string, content: string) => Promise<void>;
  /** Permanently delete a memory */
  deleteEntry: (key: string) => Promise<void>;
  /** Manually refresh entries */
  refresh: () => Promise<void>;
}

const EMPTY_STATS: MemoryStats = { total: 0 };

/**
 * Hook to load and manage a project's bd memories.
 *
 * Searching is done client-side over the already-loaded entries so that typing
 * stays responsive and does not spawn a bd process per keystroke.
 *
 * @param projectPath - The absolute path to the project root
 * @returns Object containing entries, stats, search, mutations, and refresh
 */
export function useMemory(projectPath: string): UseMemoryResult {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [search, setSearch] = useState("");

  // Track if initial load has completed
  const hasLoadedRef = useRef(false);

  /**
   * Load memory entries from the API.
   *
   * `dolt://` projects have no filesystem path for bd to run in, so they are
   * skipped rather than producing a confusing error.
   */
  const loadMemory = useCallback(async () => {
    if (!projectPath || isDoltProject(projectPath)) {
      setEntries([]);
      setStats(EMPTY_STATS);
      setIsLoading(false);
      return;
    }

    // Only show loading on initial load
    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }

    try {
      const response = await api.memory.list(projectPath);
      setEntries(response.entries);
      setStats(response.stats);
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      console.error("Failed to load memory:", error);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  /**
   * Public refresh function
   */
  const refresh = useCallback(async () => {
    await loadMemory();
  }, [loadMemory]);

  // Initial load when project path changes
  useEffect(() => {
    hasLoadedRef.current = false;
    loadMemory();
  }, [loadMemory]);

  /**
   * Filter entries by the search query (key or content)
   */
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;

    return entries.filter(
      (e) =>
        e.content.toLowerCase().includes(query) ||
        e.key.toLowerCase().includes(query)
    );
  }, [entries, search]);

  /**
   * Create a new memory
   */
  const createEntry = useCallback(
    async (key: string, content: string) => {
      if (!projectPath) return;
      try {
        await api.memory.create(projectPath, key, content);
        await loadMemory();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("Failed to create memory entry:", error);
        throw error;
      }
    },
    [projectPath, loadMemory]
  );

  /**
   * Replace an existing memory's content
   */
  const editEntry = useCallback(
    async (key: string, content: string) => {
      if (!projectPath) return;
      try {
        await api.memory.update(projectPath, key, content);
        await loadMemory();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("Failed to edit memory entry:", error);
        throw error;
      }
    },
    [projectPath, loadMemory]
  );

  /**
   * Permanently delete a memory
   */
  const deleteEntry = useCallback(
    async (key: string) => {
      if (!projectPath) return;
      try {
        await api.memory.remove(projectPath, key);
        await loadMemory();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("Failed to delete memory entry:", error);
        throw error;
      }
    },
    [projectPath, loadMemory]
  );

  return {
    entries,
    stats,
    isLoading,
    error,
    search,
    setSearch,
    filteredEntries,
    createEntry,
    editEntry,
    deleteEntry,
    refresh,
  };
}
