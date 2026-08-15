import { describe, it, expect, beforeEach } from "vitest";

import { takeIgnoredDatabases } from "@/lib/dolt-autosync";

const IGNORED_KEY = "beads-web:ignored-databases";

// Сама сверка баз против реестра живёт на сервере и покрыта тестами
// `project_sync` в Rust. Здесь остаётся только перенос старого списка.
describe("takeIgnoredDatabases", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns nothing when there is nothing to migrate", () => {
    expect(takeIgnoredDatabases()).toEqual([]);
  });

  it("returns the stored names and clears them, so the migration runs once", () => {
    window.localStorage.setItem(IGNORED_KEY, JSON.stringify(["sbc", "mcpproxy"]));

    expect(takeIgnoredDatabases()).toEqual(["sbc", "mcpproxy"]);
    expect(takeIgnoredDatabases()).toEqual([]);
    expect(window.localStorage.getItem(IGNORED_KEY)).toBeNull();
  });

  it("drops non-string entries", () => {
    window.localStorage.setItem(IGNORED_KEY, JSON.stringify(["sbc", 42, null]));

    expect(takeIgnoredDatabases()).toEqual(["sbc"]);
  });

  it("survives corrupted storage", () => {
    window.localStorage.setItem(IGNORED_KEY, "{not json");

    expect(takeIgnoredDatabases()).toEqual([]);
  });
});
