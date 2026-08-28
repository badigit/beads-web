"use client";

/**
 * Hook for filtering beads with debounced search and multi-criteria filtering.
 *
 * Provides search (with 300ms debounce), status, priority, and owner filtering
 * with a clean API for the kanban board.
 */

import { useState, useMemo, useCallback, useEffect } from "react";

import { isDeferred } from "@/lib/bead-utils";
import type { Bead, BeadStatus, LabelCount } from "@/types";

/**
 * Sort field options
 */
export type SortField = "ticket_number" | "created_at";

/**
 * Sort direction options
 */
export type SortDirection = "asc" | "desc";

/**
 * Filter state for beads
 */
export interface BeadFilters {
  /** Search query for title and description (case-insensitive) */
  search: string;
  /** Status filter - empty array means all statuses */
  statuses: BeadStatus[];
  /** Priority filter - empty array means all priorities (0-4) */
  priorities: number[];
  /** Owner/agent filter - empty array means all owners */
  owners: string[];
  /**
   * Label filter, OR semantics: a bead passes when it carries at least one of
   * these labels. Empty array means every bead passes.
   */
  labels: string[];
  /**
   * Labels that hide a bead: it fails as soon as it carries any of them.
   * Applied after `labels`, so "everything tagged X except Y" is expressible.
   */
  excludeLabels: string[];
  /** Sort field */
  sortField: SortField;
  /** Sort direction */
  sortDirection: SortDirection;
  /** Filter to items updated (worked on) today */
  todayOnly: boolean;
  /**
   * Hide beads deferred with `bd defer`. They live in the Open column by
   * design, so among a few hundred open beads they are easy to lose — this
   * takes them off the board without closing them (bweb-8md).
   */
  hideDeferred: boolean;
}

/**
 * Result type for the useBeadFilters hook
 */
export interface UseBeadFiltersResult {
  /** Current filter state */
  filters: BeadFilters;
  /** Update filters (partial update supported) */
  setFilters: (filters: Partial<BeadFilters>) => void;
  /** Beads after applying all filters */
  filteredBeads: Bead[];
  /** Reset all filters to default */
  clearFilters: () => void;
  /** Whether any filters are active */
  hasActiveFilters: boolean;
  /** Count of active filter categories */
  activeFilterCount: number;
  /** Unique owners extracted from beads */
  availableOwners: string[];
  /**
   * Labels actually present on the loaded beads, with counts, most used first.
   * A local fallback for the vocabulary the backend aggregates from the whole
   * database — the menu still offers something when that request fails.
   */
  availableLabels: LabelCount[];
  /** Debounced search value (for display) */
  debouncedSearch: string;
}

/**
 * Default/empty filter state
 */
const DEFAULT_FILTERS: BeadFilters = {
  search: "",
  statuses: [],
  priorities: [],
  owners: [],
  labels: [],
  excludeLabels: [],
  sortField: "created_at",
  sortDirection: "desc",
  todayOnly: false,
  hideDeferred: false,
};

/**
 * Hook to filter beads with debounced search and multi-criteria filtering.
 *
 * @param beads - Array of beads to filter
 * @param debounceMs - Debounce delay for search input (default 300ms)
 * @returns Filter state, setters, and filtered beads
 *
 * @example
 * ```tsx
 * function KanbanBoard({ beads }: { beads: Bead[] }) {
 *   const {
 *     filters,
 *     setFilters,
 *     filteredBeads,
 *     clearFilters,
 *     hasActiveFilters,
 *     activeFilterCount,
 *   } = useBeadFilters(beads);
 *
 *   return (
 *     <>
 *       <input
 *         value={filters.search}
 *         onChange={(e) => setFilters({ search: e.target.value })}
 *       />
 *       {hasActiveFilters && (
 *         <button onClick={clearFilters}>
 *           Clear ({activeFilterCount})
 *         </button>
 *       )}
 *       <BeadList beads={filteredBeads} />
 *     </>
 *   );
 * }
 * ```
 */
export function useBeadFilters(
  beads: Bead[],
  ticketNumbers: Map<string, number>,
  debounceMs: number = 300
): UseBeadFiltersResult {
  // Filter state
  const [filters, setFiltersState] = useState<BeadFilters>(DEFAULT_FILTERS);

  // "today" string computed client-side only to avoid SSR/client hydration mismatch.
  // Starts as null (same on server and client), set after mount.
  const [todayStr, setTodayStr] = useState<string | null>(null);

  useEffect(() => {
    setTodayStr(new Date().toISOString().split("T")[0]);
  }, []);

  // Debounced search value
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(filters.search);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [filters.search, debounceMs]);

  /**
   * Update filters with partial state
   */
  const setFilters = useCallback((partialFilters: Partial<BeadFilters>) => {
    setFiltersState((prev) => ({
      ...prev,
      ...partialFilters,
    }));
  }, []);

  /**
   * Reset all filters to defaults
   */
  const clearFilters = useCallback(() => {
    setFiltersState(DEFAULT_FILTERS);
    setDebouncedSearch("");
  }, []);

  /**
   * Extract unique owners from all beads
   */
  const availableOwners = useMemo(() => {
    const owners = new Set<string>();
    beads.forEach((bead) => {
      if (bead.owner) {
        owners.add(bead.owner);
      }
    });
    return Array.from(owners).sort();
  }, [beads]);

  /**
   * Extract the labels present on the loaded beads, with per-label counts.
   * Ordered like the backend's vocabulary: most used first, ties by name.
   */
  const availableLabels = useMemo(() => {
    const counts = new Map<string, number>();
    beads.forEach((bead) => {
      (bead.labels ?? []).forEach((raw) => {
        const label = raw.trim();
        if (!label) return;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      });
    });
    return Array.from(counts, ([label, count]) => ({ label, count })).sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    );
  }, [beads]);

  /**
   * Apply all filters to beads and sort
   */
  const filteredBeads = useMemo(() => {
    const { sortField, sortDirection } = filters;

    // Filter beads
    const trimmedSearch = debouncedSearch.trim();
    const filtered = beads.filter((bead) => {
      // Search filter (uses debounced value for performance).
      // Trimmed so a stray leading/trailing space (e.g. pasted from chat
      // or `bd` CLI output) doesn't silently break an otherwise exact match.
      if (trimmedSearch) {
        const searchLower = trimmedSearch.toLowerCase();
        const matchesSearch =
          bead.id.toLowerCase().includes(searchLower) ||
          bead.title.toLowerCase().includes(searchLower) ||
          (bead.description &&
            bead.description.toLowerCase().includes(searchLower));
        if (!matchesSearch) return false;
      }

      // Status filter
      if (filters.statuses.length > 0) {
        if (!filters.statuses.includes(bead.status)) return false;
      }

      // Priority filter
      if (filters.priorities.length > 0) {
        if (!filters.priorities.includes(bead.priority)) return false;
      }

      // Owner filter
      if (filters.owners.length > 0) {
        if (!filters.owners.includes(bead.owner)) return false;
      }

      // Label filters: include is OR (any match passes), exclude wins over it.
      if (filters.labels.length > 0 || filters.excludeLabels.length > 0) {
        const beadLabels = bead.labels ?? [];
        if (
          filters.labels.length > 0 &&
          !filters.labels.some((label) => beadLabels.includes(label))
        ) {
          return false;
        }
        if (filters.excludeLabels.some((label) => beadLabels.includes(label))) {
          return false;
        }
      }

      // Deferred filter — `deferred` is mapped onto the open column, so the
      // raw status is the only thing left to match on.
      if (filters.hideDeferred && isDeferred(bead)) return false;

      // Today filter - items updated (worked on) today, regardless of status.
      // Uses client-computed todayStr to avoid SSR/client hydration mismatch.
      // Before mount (todayStr is null), skip filtering to match SSR output.
      if (filters.todayOnly && todayStr) {
        const updatedToday = bead.updated_at.startsWith(todayStr);
        if (!updatedToday) return false;
      }

      return true;
    });

    // Sort the filtered results (use toSorted for immutability)
    const sorted = filtered.toSorted((a, b) => {
      if (sortField === "ticket_number") {
        const aNum = ticketNumbers.get(a.id) ?? 0;
        const bNum = ticketNumbers.get(b.id) ?? 0;
        return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
      }
      // created_at sort
      const aDate = new Date(a.created_at).getTime();
      const bDate = new Date(b.created_at).getTime();
      return sortDirection === "asc" ? aDate - bDate : bDate - aDate;
    });

    return sorted;
  }, [beads, debouncedSearch, filters, ticketNumbers, todayStr]);

  /**
   * Check if any filters are active
   */
  const hasActiveFilters = useMemo(() => {
    return (
      filters.search.trim() !== "" ||
      filters.statuses.length > 0 ||
      filters.priorities.length > 0 ||
      filters.owners.length > 0 ||
      filters.labels.length > 0 ||
      filters.excludeLabels.length > 0 ||
      filters.todayOnly ||
      filters.hideDeferred ||
      filters.sortField !== DEFAULT_FILTERS.sortField ||
      filters.sortDirection !== DEFAULT_FILTERS.sortDirection
    );
  }, [filters]);

  /**
   * Count active filter categories (for badge)
   */
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.statuses.length > 0) count++;
    if (filters.priorities.length > 0) count++;
    if (filters.owners.length > 0) count++;
    if (filters.labels.length > 0 || filters.excludeLabels.length > 0) count++;
    if (filters.todayOnly) count++;
    if (filters.hideDeferred) count++;
    return count;
  }, [filters]);

  return {
    filters,
    setFilters,
    filteredBeads,
    clearFilters,
    hasActiveFilters,
    activeFilterCount,
    availableOwners,
    availableLabels,
    debouncedSearch,
  };
}
