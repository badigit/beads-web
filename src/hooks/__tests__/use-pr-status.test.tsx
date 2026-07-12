import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the API layer — the network git/gh call must never fire when the
// PR integration flag is disabled.
const prStatusMock = vi.fn();

vi.mock("@/lib/api", () => ({
  git: {
    prStatus: (...args: unknown[]) => prStatusMock(...args),
  },
}));

// Import AFTER the mock so the hook picks it up.
// eslint-disable-next-line import/first, import/order
import { usePRStatus } from "../use-pr-status";

const STORAGE_KEY = "beads-pr-settings";

beforeEach(() => {
  prStatusMock.mockReset();
  prStatusMock.mockResolvedValue({
    has_remote: true,
    branch_pushed: true,
    pr: null,
  });
  localStorage.clear();
});

describe("usePRStatus — respects the enabled flag", () => {
  it("does not fetch PR status when integration is disabled (default)", async () => {
    const { result } = renderHook(() =>
      usePRStatus("/repo/project", "bd-1")
    );

    // Give effects a chance to run.
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(prStatusMock).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it("fetches PR status when integration is enabled", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: true }));

    renderHook(() => usePRStatus("/repo/project", "bd-1"));

    await waitFor(() => {
      expect(prStatusMock).toHaveBeenCalledWith("/repo/project", "bd-1");
    });
  });
});
