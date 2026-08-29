import { describe, it, expect } from "vitest";

import { filterRows, labelsOf, sortRows } from "@/lib/bead-grid";
import type { BeadRow } from "@/types";

function row(overrides: Partial<BeadRow> & { id: string }): BeadRow {
  return {
    title: "Some bead",
    status: "open",
    priority: 2,
    issue_type: "task",
    labels: [],
    updated_at: "2026-08-20T10:00:00Z",
    project_name: "beads-web",
    project_id: "p-1",
    ...overrides,
  };
}

describe("sortRows", () => {
  it("orders statuses by the workflow, not the alphabet", () => {
    const sorted = sortRows(
      [
        row({ id: "c", status: "closed" }),
        row({ id: "a", status: "open" }),
        row({ id: "b", status: "in_progress" }),
      ],
      "status",
      "asc"
    );

    expect(sorted.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("puts a missing priority after every real one", () => {
    const sorted = sortRows(
      [
        row({ id: "none", priority: null }),
        row({ id: "p3", priority: 3 }),
        row({ id: "p0", priority: 0 }),
      ],
      "priority",
      "asc"
    );

    expect(sorted.map((r) => r.id)).toEqual(["p0", "p3", "none"]);
  });

  it("sorts dates newest first when descending", () => {
    const sorted = sortRows(
      [
        row({ id: "old", updated_at: "2026-08-01T10:00:00Z" }),
        row({ id: "new", updated_at: "2026-08-29T10:00:00Z" }),
      ],
      "updated_at",
      "desc"
    );

    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("breaks ties on id so the order never wobbles", () => {
    const sorted = sortRows(
      [row({ id: "b" }), row({ id: "a" }), row({ id: "c" })],
      "status",
      "asc"
    );

    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the input array untouched", () => {
    const input = [row({ id: "b" }), row({ id: "a" })];
    sortRows(input, "id", "asc");

    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("filterRows", () => {
  const rows = [
    row({ id: "bweb-1", title: "Лента событий", project_name: "beads-web" }),
    row({ id: "tvp-9", title: "Другая задача", project_name: "trade-vp1" }),
  ];

  it("matches id, title and project", () => {
    expect(filterRows(rows, "bweb").map((r) => r.id)).toEqual(["bweb-1"]);
    expect(filterRows(rows, "лента").map((r) => r.id)).toEqual(["bweb-1"]);
    expect(filterRows(rows, "trade").map((r) => r.id)).toEqual(["tvp-9"]);
  });

  it("ignores surrounding whitespace instead of emptying the grid", () => {
    expect(filterRows(rows, "  bweb  ")).toHaveLength(1);
    expect(filterRows(rows, "   ")).toHaveLength(2);
  });
});

describe("labelsOf", () => {
  it("counts labels across rows, most used first", () => {
    const labels = labelsOf([
      row({ id: "a", labels: ["idea", "ui"] }),
      row({ id: "b", labels: ["idea"] }),
      row({ id: "c", labels: [] }),
    ]);

    expect(labels).toEqual([
      { label: "idea", count: 2 },
      { label: "ui", count: 1 },
    ]);
  });
});
