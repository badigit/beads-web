import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ActivityDays } from "@/components/activity-days";
import type { ActivityEvent } from "@/types";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "e1",
    issue_id: "bweb-1",
    issue_title: "Целевая задача",
    event_type: "created",
    actor: "badigit",
    detail: null,
    created_at: new Date().toISOString(),
    project_name: "beads-web",
    project_id: "p-1",
    ...overrides,
  };
}

function renderDays(events: ActivityEvent[], props: Record<string, unknown> = {}) {
  return render(
    <ActivityDays
      events={events}
      isLoading={false}
      isLoadingMore={false}
      error={null}
      hasMore={false}
      onLoadMore={() => {}}
      {...props}
    />
  );
}

describe("ActivityDays", () => {
  it("shows the action as a mark, not as a word in the line", () => {
    renderDays([event()]);

    // The verb stays available to assistive tech and on hover…
    expect(screen.getByTitle("created")).toBeInTheDocument();
    // …but the visible line is the bead, not "badigit created …".
    expect(screen.queryByText(/badigit/)).not.toBeInTheDocument();
  });

  it("puts the project on its own line under the title", () => {
    renderDays([event()], { showProject: true });

    const project = screen.getByText("beads-web");
    // Under the title, not glued to it: the title keeps the full line width.
    expect(project.tagName).toBe("DIV");
    expect(project).not.toContainElement(screen.getByRole("button", { name: "Целевая задача" }));
  });

  it("hands the row's project to the click handler so the feed can open it", () => {
    const onBeadClick = vi.fn();
    renderDays([event()], { onBeadClick });

    fireEvent.click(screen.getByRole("button", { name: "Целевая задача" }));

    expect(onBeadClick).toHaveBeenCalledWith("bweb-1", "p-1");
  });

  it("marks a folded run with a count instead of repeating the verb", () => {
    renderDays([
      event({ id: "a", issue_id: "bweb-1" }),
      event({ id: "b", issue_id: "bweb-2" }),
      event({ id: "c", issue_id: "bweb-3" }),
    ]);

    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.getByText(/bweb-1, bweb-2, bweb-3/)).toBeInTheDocument();
  });
});
