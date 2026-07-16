import { describe, it, expect } from "vitest";

import { parseStoredView, DEFAULT_PROJECTS_VIEW } from "../use-projects-view";

describe("parseStoredView", () => {
  it("defaults to cards when nothing is stored", () => {
    expect(parseStoredView(null)).toBe("cards");
    expect(DEFAULT_PROJECTS_VIEW).toBe("cards");
  });

  it("returns list when 'list' is stored", () => {
    expect(parseStoredView("list")).toBe("list");
  });

  it("returns cards when 'cards' is stored", () => {
    expect(parseStoredView("cards")).toBe("cards");
  });

  it("falls back to cards on an unknown value", () => {
    expect(parseStoredView("grid")).toBe("cards");
    expect(parseStoredView("")).toBe("cards");
  });
});
