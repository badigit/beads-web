import { describe, it, expect } from "vitest";

import { selectBoardBeads } from "@/lib/board-beads";
import type { Bead } from "@/types";

/**
 * Fixture mirrors the real two-level nesting verified on this project:
 *   bweb-489 (epic, no parent)
 *     └─ bweb-489.12 (epic, parent = bweb-489)
 *          ├─ bweb-489.12.1 (task, parent = bweb-489.12)
 *          └─ bweb-489.12.2 (task, parent = bweb-489.12)
 */
function bead(id: string, overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Title for ${id}`,
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    owner: "",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  } as Bead;
}

const BEADS: Bead[] = [
  bead("bweb-489", { issue_type: "epic" }),
  bead("bweb-489.12", { issue_type: "epic", parent_id: "bweb-489" }),
  bead("bweb-489.12.1", { parent_id: "bweb-489.12" }),
  bead("bweb-489.12.2", { parent_id: "bweb-489.12" }),
  bead("bweb-emj"),
];

/**
 * Same matching rule as use-bead-filters.ts (id / title / description,
 * case-insensitive, trimmed) — the board receives beads already filtered
 * this way, so the tests feed the helper the same input the board does.
 */
function applySearch(beads: Bead[], search: string): Bead[] {
  const q = search.trim().toLowerCase();
  if (!q) return beads;
  return beads.filter(
    (b) =>
      b.id.toLowerCase().includes(q) ||
      b.title.toLowerCase().includes(q) ||
      (b.description ?? "").toLowerCase().includes(q)
  );
}

const ids = (beads: Bead[]) => beads.map((b) => b.id);

describe("selectBoardBeads", () => {
  describe("with an active search (flat mode)", () => {
    it("surfaces a matching CHILD (depth 1) as a standalone card", () => {
      const search = "489.12";
      const result = selectBoardBeads(applySearch(BEADS, search), "all", search);

      expect(ids(result)).toContain("bweb-489.12");
    });

    it("surfaces a matching GRANDCHILD (depth 2) as a standalone card", () => {
      const search = "489.12.1";
      const result = selectBoardBeads(applySearch(BEADS, search), "all", search);

      expect(ids(result)).toEqual(["bweb-489.12.1"]);
    });

    it("returns every match at any depth for a broad query", () => {
      const search = "489.12";
      const result = selectBoardBeads(applySearch(BEADS, search), "all", search);

      expect(ids(result).sort()).toEqual([
        "bweb-489.12",
        "bweb-489.12.1",
        "bweb-489.12.2",
      ]);
    });

    it("still honours the epics type filter", () => {
      const search = "489.12";
      const result = selectBoardBeads(applySearch(BEADS, search), "epics", search);

      expect(ids(result)).toEqual(["bweb-489.12"]);
    });

    it("still honours the tasks type filter", () => {
      const search = "489.12";
      const result = selectBoardBeads(applySearch(BEADS, search), "tasks", search);

      expect(ids(result).sort()).toEqual(["bweb-489.12.1", "bweb-489.12.2"]);
    });

    it("treats a whitespace-only query as no search (hierarchy view)", () => {
      const result = selectBoardBeads(BEADS, "all", "   ");

      expect(ids(result)).toEqual(["bweb-489", "bweb-emj"]);
    });
  });

  describe("with an empty search (hierarchy view — must not regress)", () => {
    it("returns only top-level beads", () => {
      const result = selectBoardBeads(BEADS, "all", "");

      expect(ids(result)).toEqual(["bweb-489", "bweb-emj"]);
    });

    it("returns only top-level epics for the epics filter", () => {
      const result = selectBoardBeads(BEADS, "epics", "");

      expect(ids(result)).toEqual(["bweb-489"]);
    });

    it("returns only top-level non-epics for the tasks filter", () => {
      const result = selectBoardBeads(BEADS, "tasks", "");

      expect(ids(result)).toEqual(["bweb-emj"]);
    });

    it("preserves the incoming sort order", () => {
      const reversed = [...BEADS].toReversed();
      const result = selectBoardBeads(reversed, "all", "");

      expect(ids(result)).toEqual(["bweb-emj", "bweb-489"]);
    });
  });
});

describe("isFlatSearchMode", () => {
  it("is off for an empty or whitespace-only query", async () => {
    const { isFlatSearchMode } = await import("@/lib/board-beads");
    expect(isFlatSearchMode("")).toBe(false);
    expect(isFlatSearchMode("  ")).toBe(false);
  });

  it("is on for a non-empty query", async () => {
    const { isFlatSearchMode } = await import("@/lib/board-beads");
    expect(isFlatSearchMode("489.12")).toBe(true);
    expect(isFlatSearchMode("  489.12  ")).toBe(true);
  });
});
