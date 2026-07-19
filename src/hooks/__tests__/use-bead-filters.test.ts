import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Bead } from "@/types";

import { useBeadFilters } from "../use-bead-filters";

function bead(id: string, overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Bead ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "someone",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    comments: [],
    ...overrides,
  };
}

const ticketNumbers = new Map<string, number>();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBeadFilters search trimming", () => {
  const beads = [bead("bweb-30u"), bead("bweb-other")];

  it.each([["30u "], [" 30u"], ["  30u  "]])(
    'finds bead containing "30u" when search is %j (whitespace padded)',
    (searchTerm) => {
      const { result } = renderHook(() => useBeadFilters(beads, ticketNumbers));

      act(() => {
        result.current.setFilters({ search: searchTerm });
      });

      // Flush the 300ms debounce.
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(result.current.filteredBeads.map((b) => b.id)).toEqual([
        "bweb-30u",
      ]);
    }
  );

  it("does not treat a whitespace-only search as an active filter", () => {
    const { result } = renderHook(() => useBeadFilters(beads, ticketNumbers));

    act(() => {
      result.current.setFilters({ search: "   " });
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.hasActiveFilters).toBe(false);
    expect(result.current.filteredBeads).toHaveLength(2);
  });
});
