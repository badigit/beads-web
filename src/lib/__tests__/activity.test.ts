import { describe, it, expect } from "vitest";

import { collapseRuns, dayLabel, describeRun, groupByDay } from "@/lib/activity";
import type { ActivityEvent } from "@/types";

function event(overrides: Partial<ActivityEvent> & { created_at: string }): ActivityEvent {
  return {
    id: overrides.id ?? `e-${overrides.created_at}`,
    issue_id: overrides.issue_id ?? "bweb-1",
    issue_title: overrides.issue_title ?? "Some bead",
    event_type: overrides.event_type ?? "created",
    actor: overrides.actor ?? "badigit",
    detail: overrides.detail,
    created_at: overrides.created_at,
  };
}

// Local-time midday timestamps: a UTC-anchored string would land on the
// previous day west of Greenwich and make these tests timezone-dependent.
function localTime(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("groupByDay", () => {
  it("splits events into calendar days, newest day first", () => {
    const days = groupByDay(
      [
        event({ created_at: localTime(2026, 8, 29, 10), issue_id: "a" }),
        event({ created_at: localTime(2026, 8, 28, 22), issue_id: "b" }),
        event({ created_at: localTime(2026, 8, 28, 9), issue_id: "c" }),
      ],
      new Date(2026, 7, 29, 12)
    );

    expect(days.map((d) => d.key)).toEqual(["2026-08-29", "2026-08-28"]);
    expect(days[0].label).toBe("Today");
    expect(days[1].label).toBe("Yesterday");
  });

  it("never merges a run across a day boundary", () => {
    const days = groupByDay(
      [
        event({ created_at: localTime(2026, 8, 29, 0, ), issue_id: "a" }),
        event({ created_at: localTime(2026, 8, 28, 23), issue_id: "b" }),
      ],
      new Date(2026, 7, 29, 12)
    );

    expect(days).toHaveLength(2);
    expect(days[0].events[0].count).toBe(1);
    expect(days[1].events[0].count).toBe(1);
  });

  it("skips events with an unparseable timestamp instead of dropping the feed", () => {
    const days = groupByDay(
      [event({ created_at: "not a date" }), event({ created_at: localTime(2026, 8, 29) })],
      new Date(2026, 7, 29, 12)
    );

    expect(days).toHaveLength(1);
    expect(days[0].events).toHaveLength(1);
  });
});

describe("collapseRuns", () => {
  it("folds consecutive same-actor same-type events into one row", () => {
    const runs = collapseRuns([
      event({ created_at: localTime(2026, 8, 29, 12), issue_id: "a" }),
      event({ created_at: localTime(2026, 8, 29, 11), issue_id: "b" }),
      event({ created_at: localTime(2026, 8, 29, 10), issue_id: "c" }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(3);
    expect(runs[0].beadIds).toEqual(["a", "b", "c"]);
  });

  it("keeps specifics on different beads apart", () => {
    // The close reason IS the line, and these are two different beads —
    // folding them would attribute one bead's reason to the other.
    const runs = collapseRuns([
      event({
        created_at: localTime(2026, 8, 29, 12),
        issue_id: "bweb-1",
        event_type: "closed",
        detail: "Смержено",
      }),
      event({
        created_at: localTime(2026, 8, 29, 11),
        issue_id: "bweb-2",
        event_type: "closed",
        detail: "Дубликат",
      }),
    ]);

    expect(runs).toHaveLength(2);
  });

  it("folds repeated specifics on ONE bead into a single row", () => {
    // Three labels on one bead were three near-identical lines in the live
    // feed — the noise the feed exists to remove.
    const runs = collapseRuns([
      event({
        created_at: localTime(2026, 8, 29, 12),
        event_type: "label_added",
        detail: "Added label: research",
      }),
      event({
        created_at: localTime(2026, 8, 29, 12),
        id: "e2",
        event_type: "label_added",
        detail: "Added label: idea",
      }),
    ]);

    expect(runs).toHaveLength(1);
    // The row already says "labeled", so bd's prefix is stripped.
    expect(runs[0].details).toEqual(["research", "idea"]);
    // Still one bead, so the phrasing must not claim two.
    expect(describeRun(runs[0])).toBe("labeled");
  });

  it("does not merge across actors or event types", () => {
    const runs = collapseRuns([
      event({ created_at: localTime(2026, 8, 29, 12), actor: "badigit" }),
      event({ created_at: localTime(2026, 8, 29, 11), actor: "agent" }),
      event({ created_at: localTime(2026, 8, 29, 10), actor: "agent", event_type: "closed" }),
    ]);

    expect(runs.map((r) => r.count)).toEqual([1, 1, 1]);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 7, 29, 12);

  it("names today and yesterday", () => {
    expect(dayLabel("2026-08-29", now)).toBe("Today");
    expect(dayLabel("2026-08-28", now)).toBe("Yesterday");
  });

  it("gives older days a weekday and drops the year only within it", () => {
    expect(dayLabel("2026-08-14", now)).toBe("Fri, Aug 14");
    expect(dayLabel("2025-12-31", now)).toContain("2025");
  });
});

describe("describeRun", () => {
  it("phrases a single event and a folded run", () => {
    const single = collapseRuns([event({ created_at: localTime(2026, 8, 29) })])[0];
    expect(describeRun(single)).toBe("created");

    const folded = collapseRuns([
      event({ created_at: localTime(2026, 8, 29, 12), issue_id: "a" }),
      event({ created_at: localTime(2026, 8, 29, 11), issue_id: "b" }),
      event({ created_at: localTime(2026, 8, 29, 10), issue_id: "c" }),
    ])[0];
    expect(describeRun(folded)).toBe("created 3 beads");
  });

  it("falls back to a readable form of an unknown event type", () => {
    const run = collapseRuns([
      event({ created_at: localTime(2026, 8, 29), event_type: "priority_changed" }),
    ])[0];

    expect(describeRun(run)).toBe("priority changed");
  });
});
