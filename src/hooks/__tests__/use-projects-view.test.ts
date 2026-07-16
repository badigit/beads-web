import { describe, it, expect } from "vitest";

import { parseStoredView, DEFAULT_PROJECTS_VIEW } from "../use-projects-view";

describe("parseStoredView", () => {
  it("defaults to list when nothing is stored", () => {
    expect(parseStoredView(null)).toBe("list");
    expect(DEFAULT_PROJECTS_VIEW).toBe("list");
  });

  it("returns cards when 'cards' is stored (honours prior choice)", () => {
    expect(parseStoredView("cards")).toBe("cards");
  });

  it("returns list when 'list' is stored", () => {
    expect(parseStoredView("list")).toBe("list");
  });

  it("falls back to the default (list) on an unknown value", () => {
    expect(parseStoredView("grid")).toBe("list");
    expect(parseStoredView("")).toBe("list");
  });
});
