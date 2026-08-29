import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const allBeadsMock = vi.fn();
const projectsListMock = vi.fn();
const beadsReadMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  beads: {
    all: (...args: unknown[]) => allBeadsMock(...args),
    read: (...args: unknown[]) => beadsReadMock(...args),
  },
  projects: {
    list: (...args: unknown[]) => projectsListMock(...args),
  },
  watch: {
    beads: () => () => {},
    doltRevision: () => () => {},
  },
  git: { prStatus: vi.fn() },
}));

// eslint-disable-next-line import/first, import/order
import BeadsPage from "../page";

const PROJECT = {
  id: "p-1",
  name: "beads-web",
  path: "C:/Users/Dee/GitHub/beads-web",
  tags: [],
  lastOpened: "2026-08-29T10:00:00Z",
  createdAt: "2026-08-01T10:00:00Z",
};

const ROWS = [
  {
    id: "bweb-1",
    title: "Свежая задача",
    status: "open",
    priority: 1,
    issue_type: "task",
    labels: ["visibility"],
    updated_at: "2026-08-29T10:00:00Z",
    project_id: "p-1",
    project_name: "beads-web",
  },
  {
    id: "tvp-9",
    title: "Чужая задача",
    status: "in_progress",
    priority: 0,
    issue_type: "bug",
    labels: [],
    updated_at: "2026-08-28T10:00:00Z",
    project_id: "p-2",
    project_name: "trade-vp1",
  },
];

beforeEach(() => {
  allBeadsMock.mockReset();
  projectsListMock.mockReset();
  beadsReadMock.mockReset();

  allBeadsMock.mockResolvedValue({ beads: ROWS, source: "dolt-central" });
  projectsListMock.mockResolvedValue([PROJECT]);
  beadsReadMock.mockResolvedValue({
    beads: [
      {
        id: "bweb-1",
        title: "Свежая задача",
        description: "Описание",
        status: "open",
        priority: 1,
        issue_type: "task",
        owner: "badigit",
        created_at: "2026-08-29T09:00:00Z",
        updated_at: "2026-08-29T10:00:00Z",
        comments: [],
      },
    ],
    source: "dolt-central",
  });
});

describe("BeadsPage", () => {
  it("shows beads of several projects in one table", async () => {
    render(<BeadsPage />);

    expect(await screen.findByText("Свежая задача")).toBeInTheDocument();
    expect(screen.getByText("Чужая задача")).toBeInTheDocument();
    expect(screen.getByText("trade-vp1")).toBeInTheDocument();
  });

  it("opens on work in flight, not on the archive", async () => {
    render(<BeadsPage />);

    await waitFor(() => expect(allBeadsMock).toHaveBeenCalled());
    expect(allBeadsMock.mock.calls[0][0]).toMatchObject({
      statuses: ["open", "in_progress"],
    });
  });

  it("asks the server again when a filter changes", async () => {
    render(<BeadsPage />);
    await waitFor(() => expect(allBeadsMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Closed" }));

    // Filtering happens on the server: a status toggle is a new request, not a
    // client-side hide of rows already paid for.
    await waitFor(() => expect(allBeadsMock).toHaveBeenCalledTimes(2));
    expect(allBeadsMock.mock.calls[1][0].statuses).toContain("closed");
  });

  it("narrows the loaded page by the text search", async () => {
    render(<BeadsPage />);
    await screen.findByText("Свежая задача");

    fireEvent.change(screen.getByLabelText("Search beads"), { target: { value: "trade" } });

    expect(screen.queryByText("Свежая задача")).not.toBeInTheDocument();
    expect(screen.getByText("Чужая задача")).toBeInTheDocument();
  });

  it("sorts by a column when its header is clicked", async () => {
    render(<BeadsPage />);
    await screen.findByText("Свежая задача");

    fireEvent.click(screen.getByRole("button", { name: /Title/i }));

    const titles = screen.getAllByRole("row").slice(1).map((row) => row.textContent ?? "");
    expect(titles[0]).toContain("Свежая задача");
  });

  it("opens the bead in a panel on the same page", async () => {
    render(<BeadsPage />);

    fireEvent.click(await screen.findByText("Свежая задача"));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Свежая задача" })).toBeInTheDocument()
    );
  });
});
