import { describe, it, expect } from "vitest";

import {
  clearLabelFilter,
  cycleLabelFilter,
  labelFilterState,
} from "../label-filter";

describe("labelFilterState", () => {
  it("reports which of the two lists a label sits in", () => {
    expect(labelFilterState("night-ok", ["night-ok"], [])).toBe("include");
    expect(labelFilterState("night-ok", [], ["night-ok"])).toBe("exclude");
    expect(labelFilterState("night-ok", ["tooling"], ["cases"])).toBe("off");
  });
});

describe("cycleLabelFilter", () => {
  it("walks off → include → exclude → off", () => {
    const first = cycleLabelFilter("night-ok", [], []);
    expect(first).toEqual({ labels: ["night-ok"], excludeLabels: [] });

    const second = cycleLabelFilter("night-ok", first.labels, first.excludeLabels);
    expect(second).toEqual({ labels: [], excludeLabels: ["night-ok"] });

    const third = cycleLabelFilter("night-ok", second.labels, second.excludeLabels);
    expect(third).toEqual({ labels: [], excludeLabels: [] });
  });

  it("never leaves a label in both lists at once", () => {
    const next = cycleLabelFilter("tooling", ["tooling"], ["tooling"]);
    expect(next.labels).not.toContain("tooling");
    expect(next.excludeLabels).toEqual(["tooling"]);
  });

  it("leaves the other labels untouched", () => {
    const next = cycleLabelFilter("cases", ["tooling"], ["agent-ux"]);
    expect(next).toEqual({
      labels: ["tooling", "cases"],
      excludeLabels: ["agent-ux"],
    });
  });
});

describe("clearLabelFilter", () => {
  it("drops the label from whichever list held it", () => {
    expect(clearLabelFilter("a", ["a", "b"], ["a"])).toEqual({
      labels: ["b"],
      excludeLabels: [],
    });
  });
});
