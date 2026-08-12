import { describe, it, expect, beforeEach } from "vitest";

import type { DoltDatabase } from "@/lib/api";
import {
  findUnlistedDatabases,
  ignoredNamesForProject,
  loadIgnoredDatabases,
  addIgnoredDatabases,
  projectRegistrationFor,
  databaseNameForProject,
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

describe("databaseNameForProject", () => {
  const databases = [
    { name: "skyrem", project_name: "skycomm-reminders", local_path: "C:/Users/Dee/GitHub/skycomm-reminders" },
    { name: "tvp", project_name: "trade-vp1", local_path: "C:/Users/Dee/GitHub/trade-vp1" },
    { name: "BeadsBox_workspace", project_name: "BeadsBox_workspace" },
  ];

  it("reads the database straight off a dolt:// path", () => {
    expect(
      databaseNameForProject({ name: "whatever", path: "dolt://fmv" }, [])
    ).toBe("fmv");
  });

  it("finds the database of a filesystem project by its folder", () => {
    expect(
      databaseNameForProject(
        { name: "skycomm-reminders", path: "C:/Users/Dee/GitHub/skycomm-reminders" },
        databases
      )
    ).toBe("skyrem");
  });

  it("ignores case and a trailing separator in the folder", () => {
    expect(
      databaseNameForProject(
        { name: "trade-vp1", path: "c:/users/dee/github/trade-vp1/" },
        databases
      )
    ).toBe("tvp");
  });

  it("falls back to the project name when no folder matches", () => {
    expect(
      databaseNameForProject(
        { name: "BeadsBox_workspace", path: "C:/somewhere/else" },
        databases
      )
    ).toBe("BeadsBox_workspace");
  });

  it("returns null when discovery knows nothing about the project", () => {
    expect(
      databaseNameForProject({ name: "unknown", path: "C:/nope" }, databases)
    ).toBeNull();
  });
});

describe("ignoredNamesForProject", () => {
  it("remembers both the project name and its database for dolt:// projects", () => {
    expect(ignoredNamesForProject("trade-vp1", "dolt://tvp")).toEqual(["trade-vp1", "tvp"]);
  });

  it("does not repeat a name that equals its database", () => {
    expect(ignoredNamesForProject("fmv", "dolt://fmv")).toEqual(["fmv"]);
  });

  it("remembers the resolved database of a filesystem project", () => {
    // Ровно регресс bweb-1i0.4: автоподхваченный проект зовётся по папке,
    // а следующий синк сверяется с именем базы.
    expect(
      ignoredNamesForProject("skycomm-reminders", "C:/Users/Dee/GitHub/skycomm-reminders", "skyrem")
    ).toEqual(["skycomm-reminders", "skyrem"]);
  });

  it("remembers only the name when the database is unknown", () => {
    expect(ignoredNamesForProject("polygon", "C:/Users/Dee/GitHub/polygon")).toEqual(["polygon"]);
    expect(ignoredNamesForProject("polygon", "C:/Users/Dee/GitHub/polygon", null)).toEqual([
      "polygon",
    ]);
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
