import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const activityAllMock = vi.fn();
const projectsListMock = vi.fn();
const beadsReadMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  activity: {
    all: (...args: unknown[]) => activityAllMock(...args),
    read: (...args: unknown[]) => activityAllMock(...args),
  },
  projects: {
    list: (...args: unknown[]) => projectsListMock(...args),
  },
  beads: {
    read: (...args: unknown[]) => beadsReadMock(...args),
  },
  // useBeads subscribes to live updates; the feed test does not exercise them.
  watch: {
    beads: () => () => {},
    doltRevision: () => () => {},
  },
  git: { prStatus: vi.fn() },
}));

// eslint-disable-next-line import/first, import/order
import ActivityPage from "../page";

const PROJECT = {
  id: "p-1",
  name: "beads-web",
  path: "C:/Users/Dee/GitHub/beads-web",
  tags: [],
  lastOpened: "2026-08-29T10:00:00Z",
  createdAt: "2026-08-01T10:00:00Z",
};

const BEAD = {
  id: "bweb-1",
  title: "Целевая задача",
  description: "Описание",
  status: "open",
  priority: 1,
  issue_type: "task",
  owner: "badigit",
  created_at: "2026-08-29T09:00:00Z",
  updated_at: "2026-08-29T09:00:00Z",
  comments: [],
};

beforeEach(() => {
  activityAllMock.mockReset();
  projectsListMock.mockReset();
  beadsReadMock.mockReset();

  activityAllMock.mockResolvedValue({
    events: [
      {
        id: "e1",
        issue_id: "bweb-1",
        issue_title: "Целевая задача",
        event_type: "created",
        actor: "badigit",
        detail: null,
        created_at: new Date().toISOString(),
        project_id: "p-1",
        project_name: "beads-web",
      },
    ],
    source: "dolt-central",
  });
  projectsListMock.mockResolvedValue([PROJECT]);
  beadsReadMock.mockResolvedValue({ beads: [BEAD], source: "dolt-central" });
});

describe("ActivityPage", () => {
  it("lists cross-project events", async () => {
    render(<ActivityPage />);

    expect(await screen.findByRole("button", { name: "Целевая задача" })).toBeInTheDocument();
  });

  it("opens the bead in a panel on the same page, without navigating away", async () => {
    render(<ActivityPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Целевая задача" }));

    // The panel opens in place; being thrown onto another page instead is the
    // exact complaint this covers. BeadDetail is a hand-rolled overlay, not a
    // Radix dialog, so the heading is what identifies it.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Целевая задача" })).toBeInTheDocument()
    );
    expect(beadsReadMock).toHaveBeenCalledWith(PROJECT.path, undefined);
  });
});
