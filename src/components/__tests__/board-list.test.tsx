import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Bead } from "@/types";

import { BoardList } from "../board-list";

/**
 * Two-level nesting fixture, same shape as board-beads tests:
 *   bweb-489 (epic, depth 0)
 *     └─ bweb-489.12 (epic, depth 1)
 *          └─ bweb-489.12.1 (task, depth 2)
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
    comments: [],
    ...overrides,
  } as Bead;
}

const BEADS: Bead[] = [
  bead("bweb-489", { issue_type: "epic", status: "in_progress" }),
  bead("bweb-489.12", { issue_type: "epic", parent_id: "bweb-489", status: "open" }),
  bead("bweb-489.12.1", { parent_id: "bweb-489.12", status: "closed" }),
];

beforeEach(() => {
  localStorage.clear();
});

describe("BoardList", () => {
  it("renders a row for beads at depth 0, 1 AND 2", () => {
    render(<BoardList beads={BEADS} allBeads={BEADS} onSelectBead={vi.fn()} />);

    expect(screen.getByText("bweb-489")).toBeInTheDocument();
    expect(screen.getByText("bweb-489.12")).toBeInTheDocument();
    expect(screen.getByText("bweb-489.12.1")).toBeInTheDocument();
  });

  it("shows the parent breadcrumb on child and grandchild rows", () => {
    render(<BoardList beads={BEADS} allBeads={BEADS} onSelectBead={vi.fn()} />);

    expect(screen.getByText("in bweb-489")).toBeInTheDocument();
    expect(screen.getByText("in bweb-489.12")).toBeInTheDocument();
  });

  it("does not show a breadcrumb on a top-level row", () => {
    render(
      <BoardList
        beads={[bead("bweb-489", { issue_type: "epic" })]}
        allBeads={BEADS}
        onSelectBead={vi.fn()}
      />
    );

    expect(screen.queryByText(/^in /)).not.toBeInTheDocument();
  });

  it("shows a text status label per row (status not conveyed by color alone)", () => {
    render(<BoardList beads={BEADS} allBeads={BEADS} onSelectBead={vi.fn()} />);

    expect(screen.getByText("In Progress")).toBeInTheDocument();
    // 'Open' appears on the status label; at least one visible.
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("calls onSelectBead when a row is clicked", () => {
    const onSelectBead = vi.fn();
    render(<BoardList beads={BEADS} allBeads={BEADS} onSelectBead={onSelectBead} />);

    fireEvent.click(screen.getByText("Title for bweb-489"));

    expect(onSelectBead).toHaveBeenCalledWith(BEADS[0]);
  });

  it("opens a row via keyboard (Enter)", () => {
    const onSelectBead = vi.fn();
    render(<BoardList beads={BEADS} allBeads={BEADS} onSelectBead={onSelectBead} />);

    const row = screen.getByRole("button", { name: /^Bead bweb-489\.12\.1:/ });
    fireEvent.keyDown(row, { key: "Enter" });

    expect(onSelectBead).toHaveBeenCalledWith(BEADS[2]);
  });

  it("renders an empty state when there are no beads", () => {
    render(<BoardList beads={[]} allBeads={[]} onSelectBead={vi.fn()} />);

    expect(screen.getByText(/no beads/i)).toBeInTheDocument();
  });
});
