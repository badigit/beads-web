/**
 * Shaping the raw event log into a feed a person can scan.
 *
 * Two transformations, both pure so they can be tested without a DOM:
 * grouping into calendar days (in the reader's timezone, not the server's) and
 * collapsing runs of identical work into one line — an agent that files eight
 * beads in a row should cost the feed one row, not eight.
 */

import type { ActivityEvent } from "@/types";

/** A run of consecutive same-kind events by the same actor, folded into one row. */
export interface ActivityRun extends ActivityEvent {
  /** How many events this row stands for. 1 for an ordinary event. */
  count: number;
  /** Ids of the beads involved, in feed order. Used for the "+N" tooltip. */
  beadIds: string[];
  /** Specifics gathered from the folded events, in feed order. */
  details: string[];
}

/** One calendar day of the feed. */
export interface ActivityDay {
  /** Stable key, `YYYY-MM-DD` in local time. */
  key: string;
  /** Heading shown to the reader ("Today", "Yesterday", "Fri, Aug 14"). */
  label: string;
  events: ActivityRun[];
}

/** Local-time `YYYY-MM-DD` for an event timestamp. */
function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Heading for a day, relative to `now`.
 *
 * "Today"/"Yesterday" carry more than a date does when the question is "what
 * did I do just now"; anything older gets a weekday, which is how people
 * actually remember the recent past.
 */
export function dayLabel(key: string, now: Date): string {
  const today = dayKey(now);
  if (key === today) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday)) return "Yesterday";

  // Parse as local midnight — `new Date("2026-08-14")` would be UTC and can
  // land on the previous day west of Greenwich.
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Strips the prefix `bd` puts in front of label event comments.
 *
 * The verb of the row already says "labeled", so repeating "Added label:" on
 * every one of three labels is pure noise.
 */
function cleanDetail(event: ActivityEvent): string | null {
  const detail = event.detail?.trim();
  if (!detail) return null;
  if (event.event_type === "label_added" || event.event_type === "label_removed") {
    return detail.replace(/^(Added|Removed) label:\s*/i, "");
  }
  return detail;
}

/**
 * Folds consecutive events that say the same thing into single rows.
 *
 * Two shapes get folded, both same actor and same event type:
 * - events with no specifics of their own — several beads created in a row
 *   become "created 3 beads";
 * - events on the SAME bead that do carry specifics — three labels put on one
 *   bead become one row listing them, instead of three near-identical lines.
 *
 * Events with specifics on DIFFERENT beads stay apart: a close reason is the
 * whole point of its line, and merging two of them would hide both.
 */
export function collapseRuns(events: ActivityEvent[]): ActivityRun[] {
  const runs: ActivityRun[] = [];

  for (const event of events) {
    const previous = runs[runs.length - 1];
    const detail = cleanDetail(event);
    const sameKind =
      previous !== undefined &&
      previous.actor === event.actor &&
      previous.event_type === event.event_type;
    const mergeable =
      sameKind &&
      (detail === null
        ? previous.details.length === 0
        : previous.issue_id === event.issue_id);

    if (mergeable && previous) {
      previous.count += 1;
      previous.beadIds.push(event.issue_id);
      if (detail) previous.details.push(detail);
      continue;
    }

    runs.push({
      ...event,
      count: 1,
      beadIds: [event.issue_id],
      details: detail ? [detail] : [],
    });
  }

  return runs;
}

/**
 * Groups events into days, newest day first, collapsing runs inside each day.
 *
 * Input is expected newest-first (that is what the API returns); order is
 * preserved rather than re-sorted, so a caller paging through the feed keeps
 * whatever ordering the server established.
 */
export function groupByDay(events: ActivityEvent[], now: Date = new Date()): ActivityDay[] {
  const days: ActivityDay[] = [];
  const byKey = new Map<string, ActivityDay>();

  for (const event of events) {
    const date = new Date(event.created_at);
    if (Number.isNaN(date.getTime())) continue;

    const key = dayKey(date);
    let day = byKey.get(key);
    if (!day) {
      day = { key, label: dayLabel(key, now), events: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.events.push({ ...event, count: 1, beadIds: [event.issue_id], details: [] });
  }

  for (const day of days) {
    day.events = collapseRuns(day.events);
  }

  return days;
}

/** Verb shown for an event type; unknown types fall back to their raw name. */
const EVENT_VERBS: Record<string, string> = {
  created: "created",
  closed: "closed",
  reopened: "reopened",
  claimed: "claimed",
  updated: "updated",
  status_changed: "moved",
  label_added: "labeled",
  label_removed: "unlabeled",
  comment_added: "commented on",
  assigned: "assigned",
};

/** True when the row folds several events that all happened to one bead. */
export function isSingleBeadRun(run: ActivityRun): boolean {
  return run.beadIds.every((id) => id === run.issue_id);
}

/** Human phrasing for one row, e.g. `closed` or `created 3 beads`. */
export function describeRun(run: ActivityRun): string {
  const verb = EVENT_VERBS[run.event_type] ?? run.event_type.replace(/_/g, " ");
  // A run over one bead names it separately, so the count would be wrong here:
  // three labels on one bead is not "labeled 3 beads".
  if (run.count > 1 && !isSingleBeadRun(run)) {
    return `${verb} ${run.count} beads`;
  }
  return verb;
}
