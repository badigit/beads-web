import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the API layer — these tests cover the panel, not the Dolt query.
const readMock = vi.fn();

vi.mock("@/lib/api", () => ({
  activity: {
    read: (...args: unknown[]) => readMock(...args),
  },
}));

// Import AFTER the mock so the component picks it up.
// eslint-disable-next-line import/first, import/order
import { ActivityFeed } from "../activity-feed";

const PROJECT = "dolt://beads_web";

/** Local-time timestamp: a UTC string would land on another day in some zones. */
function at(year: number, month: number, day: number, hour: number): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

const NOW = new Date();
const TODAY = { y: NOW.getFullYear(), m: NOW.getMonth() + 1, d: NOW.getDate() };

function event(overrides: Record<string, unknown>) {
  return {
    id: "e1",
    issue_id: "bweb-1",
    issue_title: "Some bead",
    event_type: "created",
    actor: "badigit",
    detail: null,
    created_at: at(TODAY.y, TODAY.m, TODAY.d, 10),
    ...overrides,
  };
}

beforeEach(() => {
  readMock.mockReset();
  readMock.mockResolvedValue({ events: [], source: "dolt-direct" });
});

describe("ActivityFeed", () => {
  it("does not hit the API while the panel is closed", () => {
    render(<ActivityFeed open={false} onOpenChange={() => {}} projectPath={PROJECT} />);

    expect(readMock).not.toHaveBeenCalled();
  });

  it("groups events under a day heading", async () => {
    readMock.mockResolvedValue({
      events: [
        event({ id: "a", issue_title: "Свежая задача" }),
        event({
          id: "b",
          issue_id: "bweb-2",
          event_type: "closed",
          detail: "Смержено в badigit-main",
          created_at: at(TODAY.y, TODAY.m, TODAY.d, 9),
        }),
      ],
      source: "dolt-direct",
    });

    render(<ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() => expect(screen.getByText("Today")).toBeInTheDocument());
    expect(screen.getByText("Свежая задача")).toBeInTheDocument();
    // The close reason is the whole point of that line.
    expect(screen.getByText(/Смержено в badigit-main/)).toBeInTheDocument();
  });

  it("folds a run of identical events into one row", async () => {
    readMock.mockResolvedValue({
      events: [
        event({ id: "a", issue_id: "bweb-1", created_at: at(TODAY.y, TODAY.m, TODAY.d, 12) }),
        event({ id: "b", issue_id: "bweb-2", created_at: at(TODAY.y, TODAY.m, TODAY.d, 11) }),
        event({ id: "c", issue_id: "bweb-3", created_at: at(TODAY.y, TODAY.m, TODAY.d, 10) }),
      ],
      source: "dolt-direct",
    });

    render(<ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() => expect(screen.getByText("created 3 beads")).toBeInTheDocument());
    // One row, not three: the bead titles are gone, the ids stay as evidence.
    expect(screen.queryByText("Some bead")).not.toBeInTheDocument();
    expect(screen.getByText(/bweb-1, bweb-2, bweb-3/)).toBeInTheDocument();
  });

  it("opens the bead the row points at", async () => {
    const onBeadClick = vi.fn();
    readMock.mockResolvedValue({
      events: [event({ id: "a", issue_id: "bweb-42", issue_title: "Целевая задача" })],
      source: "dolt-direct",
    });

    render(
      <ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} onBeadClick={onBeadClick} />
    );

    const link = await screen.findByRole("button", { name: "Целевая задача" });
    fireEvent.click(link);

    expect(onBeadClick).toHaveBeenCalledWith("bweb-42");
  });

  it("says so when the project has no recorded history", async () => {
    render(<ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() =>
      expect(screen.getByText(/No recorded activity yet/)).toBeInTheDocument()
    );
  });

  it("surfaces a failed load instead of showing an empty feed", async () => {
    // An empty feed and a broken query look identical on screen — they must not.
    readMock.mockRejectedValue(new Error("Dolt server is not running"));

    render(<ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() =>
      expect(screen.getByText("Dolt server is not running")).toBeInTheDocument()
    );
  });

  it("offers older pages only while the server returns full ones", async () => {
    readMock.mockResolvedValue({
      events: [event({ id: "a" })],
      source: "dolt-direct",
    });

    render(<ActivityFeed open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() => expect(screen.getByText("Some bead")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });
});
