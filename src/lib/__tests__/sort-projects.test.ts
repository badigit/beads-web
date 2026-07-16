import { describe, it, expect } from "vitest";

import { sortProjects } from "../sort-projects";

/** Minimal project shape accepted by `sortProjects`. */
type NamedProject = { name: string };

const proj = (name: string): NamedProject => ({ name });

describe("sortProjects", () => {
  describe("alpha mode", () => {
    it("sorts by the formatted display name", () => {
      const input = [proj("zeta-one"), proj("alpha-two"), proj("mid-three")];
      const result = sortProjects(input, "alpha");
      expect(result.map((p) => p.name)).toEqual([
        "alpha-two", // "Alpha Two"
        "mid-three", // "Mid Three"
        "zeta-one", // "Zeta One"
      ]);
    });

    it("is case-insensitive (locale-aware)", () => {
      // Raw names differ in case; the comparison must not put all
      // capitals ahead of all lowercase (ASCII would sort "Zebra" < "apple").
      const input = [proj("Zebra"), proj("apple"), proj("Mango")];
      const result = sortProjects(input, "alpha");
      expect(result.map((p) => p.name)).toEqual(["apple", "Mango", "Zebra"]);
    });

    it("orders diacritics next to their base letter (locale-aware)", () => {
      const input = [proj("Zeta"), proj("apple"), proj("emile")];
      const result = sortProjects(input, "alpha");
      // "Apple", "Emile", "Zeta"
      expect(result.map((p) => p.name)).toEqual(["apple", "emile", "Zeta"]);
    });

    it("does not mutate the input array", () => {
      const input = [proj("b"), proj("a")];
      const snapshot = input.map((p) => p.name);
      sortProjects(input, "alpha");
      expect(input.map((p) => p.name)).toEqual(snapshot);
    });
  });

  describe("activity mode", () => {
    it("preserves the original order from the database", () => {
      const input = [proj("zeta"), proj("alpha"), proj("mid")];
      const result = sortProjects(input, "activity");
      expect(result.map((p) => p.name)).toEqual(["zeta", "alpha", "mid"]);
    });

    it("returns a new array (does not mutate input)", () => {
      const input = [proj("a"), proj("b")];
      const result = sortProjects(input, "activity");
      expect(result).not.toBe(input);
      expect(result.map((p) => p.name)).toEqual(["a", "b"]);
    });
  });

  it("handles an empty array in both modes", () => {
    expect(sortProjects([], "alpha")).toEqual([]);
    expect(sortProjects([], "activity")).toEqual([]);
  });
});
