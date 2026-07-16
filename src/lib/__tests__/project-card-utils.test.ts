import { describe, it, expect } from "vitest";

import { formatProjectName, getFsPath } from "../project-card-utils";

describe("formatProjectName", () => {
  it("converts kebab-case to Title Case", () => {
    expect(formatProjectName("my-cool-project")).toBe("My Cool Project");
  });

  it("converts snake_case to Title Case", () => {
    expect(formatProjectName("my_cool_project")).toBe("My Cool Project");
  });

  it("splits camelCase into words", () => {
    expect(formatProjectName("myCoolProject")).toBe("My Cool Project");
  });

  it("capitalizes a single lowercase word", () => {
    expect(formatProjectName("beads")).toBe("Beads");
  });

  it("handles mixed separators", () => {
    expect(formatProjectName("beads-web_uiKit")).toBe("Beads Web Ui Kit");
  });
});

describe("getFsPath", () => {
  it("returns the plain path for non-dolt projects", () => {
    expect(getFsPath("/home/user/proj")).toBe("/home/user/proj");
  });

  it("returns localPath for dolt:// projects", () => {
    expect(getFsPath("dolt://myproj", "/home/user/proj")).toBe("/home/user/proj");
  });

  it("returns undefined for dolt:// projects without a localPath", () => {
    expect(getFsPath("dolt://myproj")).toBeUndefined();
  });

  it("returns the path even when it looks like a windows drive", () => {
    expect(getFsPath("C:\\Users\\Dee\\proj")).toBe("C:\\Users\\Dee\\proj");
  });
});
