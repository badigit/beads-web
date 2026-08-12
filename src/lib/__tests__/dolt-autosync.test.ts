import { describe, it, expect, beforeEach } from "vitest";

import type { DoltDatabase } from "@/lib/api";
import {
  findUnlistedDatabases,
  ignoredNamesForProject,
  loadIgnoredDatabases,
  addIgnoredDatabases,
  projectRegistrationFor,
} from "@/lib/dolt-autosync";

const db = (name: string, projectName = name): DoltDatabase => ({
  name,
  project_name: projectName,
});

describe("findUnlistedDatabases", () => {
  it("returns a database that has no project yet", () => {
    const result = findUnlistedDatabases([db("fmv")], ["beads-web"], []);
    expect(result.map((d) => d.name)).toEqual(["fmv"]);
  });

  it("skips a database already listed as a project", () => {
    // The server fills project_name from the registry, so a listed database
    // carries the project's name rather than the raw database name.
    const result = findUnlistedDatabases([db("tvp", "trade-vp1")], ["trade-vp1"], []);
    expect(result).toEqual([]);
  });

  it("matches project names case-insensitively", () => {
    const result = findUnlistedDatabases([db("fmv", "FMV")], ["fmv"], []);
    expect(result).toEqual([]);
  });

  it("skips a database the user removed, by database name", () => {
    const result = findUnlistedDatabases([db("mcpproxy")], [], ["mcpproxy"]);
    expect(result).toEqual([]);
  });

  it("skips a database the user removed, by project name", () => {
    const result = findUnlistedDatabases([db("tvp", "trade-vp1")], [], ["trade-vp1"]);
    expect(result).toEqual([]);
  });

  it("keeps unrelated databases when some are ignored", () => {
    const result = findUnlistedDatabases([db("fmv"), db("sbc")], [], ["sbc"]);
    expect(result.map((d) => d.name)).toEqual(["fmv"]);
  });
});

describe("projectRegistrationFor", () => {
  it("registers a database with a known folder as a filesystem project", () => {
    // Only filesystem projects get Memory, Agents and the bd CLI.
    expect(
      projectRegistrationFor({
        name: "skyrem",
        project_name: "skyrem",
        local_path: "C:/Users/Dee/GitHub/skycomm-reminders",
      })
    ).toEqual({
      name: "skycomm-reminders",
      path: "C:/Users/Dee/GitHub/skycomm-reminders",
    });
  });

  it("falls back to dolt:// when no folder was found on this machine", () => {
    expect(projectRegistrationFor({ name: "fmv", project_name: "fmv" })).toEqual({
      name: "fmv",
      path: "dolt://fmv",
    });
  });

  it("treats a blank local path as no folder at all", () => {
    expect(
      projectRegistrationFor({ name: "fmv", project_name: "fmv", local_path: "   " })
    ).toEqual({ name: "fmv", path: "dolt://fmv" });
  });

  it("handles backslash paths and trailing separators", () => {
    expect(
      projectRegistrationFor({
        name: "sbc",
        project_name: "sbc",
        local_path: "C:\\Users\\Dee\\GitHub\\sberbusiness_client\\",
      })
    ).toEqual({
      name: "sberbusiness_client",
      path: "C:\\Users\\Dee\\GitHub\\sberbusiness_client\\",
    });
  });
});

describe("ignoredNamesForProject", () => {
  it("remembers both the project name and its database for dolt:// projects", () => {
    expect(ignoredNamesForProject("fmv", "dolt://fmv")).toEqual(["fmv", "fmv"]);
    expect(ignoredNamesForProject("trade-vp1", "dolt://tvp")).toEqual(["trade-vp1", "tvp"]);
  });

  it("remembers only the name for filesystem projects", () => {
    expect(ignoredNamesForProject("polygon", "C:/Users/Dee/GitHub/polygon")).toEqual(["polygon"]);
  });
});

describe("ignore list persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts empty and accumulates names without duplicates", () => {
    expect(loadIgnoredDatabases()).toEqual([]);

    addIgnoredDatabases(["sbc", "mcpproxy"]);
    addIgnoredDatabases(["sbc", "ayugram"]);

    expect(loadIgnoredDatabases().sort()).toEqual(["ayugram", "mcpproxy", "sbc"]);
  });

  it("survives corrupted storage", () => {
    window.localStorage.setItem("beads-web:ignored-databases", "{not json");
    expect(loadIgnoredDatabases()).toEqual([]);
  });
});
