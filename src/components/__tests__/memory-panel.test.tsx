import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the API layer — these tests cover the panel, not the bd subprocess.
const listMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();

vi.mock("@/lib/api", () => ({
  memory: {
    list: (...args: unknown[]) => listMock(...args),
    create: (...args: unknown[]) => createMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

// Import AFTER the mock so the component picks it up.
// eslint-disable-next-line import/first, import/order
import { MemoryPanel } from "../memory-panel";

const PROJECT = "C:/Users/Dee/GitHub/beads-web";

const ENTRIES = [
  { key: "beads-web-build-windows", content: "Use the GNU toolchain." },
];

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  removeMock.mockReset();

  listMock.mockResolvedValue({
    entries: ENTRIES,
    stats: { total: ENTRIES.length },
  });
  createMock.mockResolvedValue({ success: true, created: true });
});

/** Render the open panel and wait for the initial load. */
async function renderPanel() {
  const view = render(
    <MemoryPanel open onOpenChange={() => {}} projectPath={PROJECT} />
  );
  await waitFor(() => expect(listMock).toHaveBeenCalled());
  return view;
}

/** Open the create dialog and fill the given fields. */
async function fillCreateDialog(key: string, content?: string) {
  fireEvent.click(await screen.findByRole("button", { name: "New" }));

  const keyInput = await screen.findByLabelText("Key");
  fireEvent.change(keyInput, { target: { value: key } });

  if (content !== undefined) {
    fireEvent.change(screen.getByLabelText("Content"), {
      target: { value: content },
    });
  }

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

describe("MemoryPanel — rendering", () => {
  it("names bd memories as the source so the panel is not mistaken for a separate store", async () => {
    await renderPanel();

    expect(await screen.findByText(/1 entry · bd memories/)).toBeInTheDocument();
  });

  it("shows each memory's key and content", async () => {
    await renderPanel();

    expect(
      await screen.findByText("beads-web-build-windows")
    ).toBeInTheDocument();
    expect(screen.getByText("Use the GNU toolchain.")).toBeInTheDocument();
  });

  it("offers a clear next action when there are no memories", async () => {
    listMock.mockResolvedValue({ entries: [], stats: { total: 0 } });

    await renderPanel();

    expect(await screen.findByText("No memories yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add your first memory/i })
    ).toBeInTheDocument();
  });
});

describe("MemoryPanel — staying in sync with bd", () => {
  it("refetches when reopened, so a memory written by an agent shows up", async () => {
    const { rerender } = render(
      <MemoryPanel open={false} onOpenChange={() => {}} projectPath={PROJECT} />
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    // Opening the panel must ask bd again rather than reuse the mount snapshot.
    rerender(<MemoryPanel open onOpenChange={() => {}} projectPath={PROJECT} />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe("MemoryPanel — creating", () => {
  it("creates a memory from the key and content fields", async () => {
    await renderPanel();

    await fillCreateDialog("new-insight", "problem → solution");

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        PROJECT,
        "new-insight",
        "problem → solution"
      )
    );
  });

  it("rejects an invalid key next to the field instead of calling the API", async () => {
    await renderPanel();

    await fillCreateDialog("bad key!", "content");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /letters, digits/i
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("requires content", async () => {
    await renderPanel();

    await fillCreateDialog("valid-key");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Content is required"
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("surfaces a server-side rejection in the dialog", async () => {
    createMock.mockRejectedValue(new Error("bd CLI not found"));
    await renderPanel();

    await fillCreateDialog("valid-key", "content");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "bd CLI not found"
    );
  });
});
