import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the API layer — these tests cover the hook's behaviour, not the bd
// subprocess behind /api/memory.
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

// Import AFTER the mock so the hook picks it up.
// eslint-disable-next-line import/first, import/order
import { useMemory } from "../use-memory";

const PROJECT = "C:/Users/Dee/GitHub/beads-web";

const ENTRIES = [
  { key: "bd-cli-winget-path", content: "bd lives in the winget folder." },
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
  updateMock.mockResolvedValue({ success: true, created: false });
  removeMock.mockResolvedValue({ success: true, key: "k" });
});

/** Render the hook and wait for the initial load to settle. */
async function renderLoaded(path: string = PROJECT) {
  const view = renderHook(() => useMemory(path));
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe("useMemory — loading", () => {
  it("loads entries and stats for a filesystem project", async () => {
    const { result } = await renderLoaded();

    expect(listMock).toHaveBeenCalledWith(PROJECT);
    expect(result.current.entries).toEqual(ENTRIES);
    expect(result.current.stats).toEqual({ total: 2 });
    expect(result.current.error).toBeNull();
  });

  it("skips dolt:// projects, which have no path for bd to run in", async () => {
    const { result } = await renderLoaded("dolt://beads_web");

    expect(listMock).not.toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
    expect(result.current.stats).toEqual({ total: 0 });
  });

  it("surfaces a load failure as an error", async () => {
    listMock.mockRejectedValue(new Error("bd CLI not found"));

    const { result } = await renderLoaded();

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("bd CLI not found");
  });
});

describe("useMemory — search", () => {
  it("returns every entry when the search box is empty", async () => {
    const { result } = await renderLoaded();
    expect(result.current.filteredEntries).toHaveLength(2);
  });

  it("filters by content", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.setSearch("GNU"));

    expect(result.current.filteredEntries).toEqual([ENTRIES[1]]);
  });

  it("filters by key", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.setSearch("winget"));

    expect(result.current.filteredEntries).toEqual([ENTRIES[0]]);
  });

  it("matches case-insensitively", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.setSearch("gnu TOOLCHAIN".toLowerCase()));

    expect(result.current.filteredEntries).toEqual([ENTRIES[1]]);
  });

  it("returns nothing when no entry matches", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.setSearch("nonexistent-term"));

    expect(result.current.filteredEntries).toEqual([]);
  });
});

describe("useMemory — mutations", () => {
  it("creates a memory and reloads the list", async () => {
    const { result } = await renderLoaded();
    listMock.mockClear();

    await act(async () => {
      await result.current.createEntry("new-key", "new content");
    });

    expect(createMock).toHaveBeenCalledWith(PROJECT, "new-key", "new content");
    expect(listMock).toHaveBeenCalled();
  });

  it("edits a memory and reloads the list", async () => {
    const { result } = await renderLoaded();
    listMock.mockClear();

    await act(async () => {
      await result.current.editEntry("bd-cli-winget-path", "updated");
    });

    expect(updateMock).toHaveBeenCalledWith(
      PROJECT,
      "bd-cli-winget-path",
      "updated"
    );
    expect(listMock).toHaveBeenCalled();
  });

  it("deletes a memory and reloads the list", async () => {
    const { result } = await renderLoaded();
    listMock.mockClear();

    await act(async () => {
      await result.current.deleteEntry("bd-cli-winget-path");
    });

    expect(removeMock).toHaveBeenCalledWith(PROJECT, "bd-cli-winget-path");
    expect(listMock).toHaveBeenCalled();
  });

  it("rethrows a create failure so the dialog can show it", async () => {
    createMock.mockRejectedValue(new Error("Memory key must not be empty"));
    const { result } = await renderLoaded();

    await expect(
      act(async () => {
        await result.current.createEntry("", "content");
      })
    ).rejects.toThrow("Memory key must not be empty");
  });

  it("rethrows a delete failure", async () => {
    removeMock.mockRejectedValue(new Error("not found"));
    const { result } = await renderLoaded();

    await expect(
      act(async () => {
        await result.current.deleteEntry("ghost");
      })
    ).rejects.toThrow("not found");
  });
});
