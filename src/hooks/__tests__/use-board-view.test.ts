import { describe, it, expect } from "vitest";

import { parseStoredBoardView, DEFAULT_BOARD_VIEW } from "../use-board-view";

describe("parseStoredBoardView", () => {
  it("defaults to kanban when nothing is stored", () => {
    expect(parseStoredBoardView(null)).toBe("kanban");
    expect(DEFAULT_BOARD_VIEW).toBe("kanban");
  });

  it("returns list when 'list' is stored (honours prior choice)", () => {
    expect(parseStoredBoardView("list")).toBe("list");
  });

  it("returns kanban when 'kanban' is stored", () => {
    expect(parseStoredBoardView("kanban")).toBe("kanban");
  });

  it("falls back to the default (kanban) on an unknown value", () => {
    expect(parseStoredBoardView("grid")).toBe("kanban");
    expect(parseStoredBoardView("")).toBe("kanban");
  });
});
