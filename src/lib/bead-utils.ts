/**
 * Shared utility functions for bead display formatting.
 *
 * These pure functions are used across bead-card, bead-detail, epic-card,
 * and subtask-list components.
 */

import type { Bead, BeadStatus, StatusBadgeInfo } from "@/types";

/**
 * Subset of a bead that carries its deferral state.
 *
 * `deferred` is not a column of its own — the parser maps it onto `open` and
 * keeps the raw status in `_originalStatus` (see STATUS_MAP in `@/types`).
 */
type DeferrableBead = Pick<Bead, "_originalStatus" | "defer_until">;

/**
 * Format status for display (e.g., "in_progress" -> "In Progress")
 */
export function formatStatus(status: BeadStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In Progress";
    case "inreview":
      return "In Review";
    case "closed":
      return "Closed";
    default:
      return status;
  }
}

/**
 * Get Tailwind color class for status indicator dot
 */
export function getStatusDotColor(status: BeadStatus): string {
  switch (status) {
    case "open":
      return "text-status-open";
    case "in_progress":
      return "text-status-progress";
    case "inreview":
      return "text-status-review";
    case "closed":
      return "text-status-closed";
    default:
      return "text-t-tertiary";
  }
}

/**
 * Format date for short display (e.g., "Jan 23, 2025")
 */
export function formatShortDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateString;
  }
}

/**
 * True when the bead was put aside with `bd defer`.
 *
 * Deferred beads deliberately stay in the Open column (bweb-8md decided
 * against a fifth column), so the badge and the dimmed card are the only
 * thing telling them apart from live work.
 */
export function isDeferred(bead: DeferrableBead): boolean {
  return bead._originalStatus === "deferred";
}

/**
 * How a deferred card is dimmed — one source of truth for BeadCard and
 * EpicCard, both of which apply it in each of their three layouts.
 *
 * Grayscale on top of the opacity drop is what makes it read as parked at a
 * glance: it kills the accent colours (the epic's purple rail, priority bars,
 * PR state) that otherwise keep the card looking live.
 */
export const DEFERRED_CARD_CLASSES = "opacity-50 grayscale border-dashed";

/**
 * Format a `defer_until` date compactly for a card badge: "Aug 25", with the
 * year appended when it differs from the current one ("Aug 25, 2027").
 *
 * Returns null for a missing or unparseable date — the caller then shows the
 * bare "Deferred" label, which is the correct reading: no scheduled return.
 */
export function formatDeferUntil(dateString: string | null | undefined): string | null {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Text of the status badge on a card: the mapped label, plus the return date
 * for beads deferred with `--until` ("Deferred · Aug 25").
 *
 * Returns null when the bead has no badge (its raw status IS its column).
 */
export function getStatusBadgeText(bead: DeferrableBead & Pick<Bead, "_statusBadge">): string | null {
  if (!bead._statusBadge) return null;
  if (!isDeferred(bead)) return bead._statusBadge.label;
  const until = formatDeferUntil(bead.defer_until);
  return until ? `${bead._statusBadge.label} · ${until}` : bead._statusBadge.label;
}

/**
 * Tailwind classes for a status badge, by severity.
 * warning = orange (blocked, unknown), muted = gray (deferred), info = blue (hooked/waiting)
 */
export function getStatusBadgeClasses(variant: StatusBadgeInfo["variant"]): string {
  switch (variant) {
    case "warning":
      return "bg-blocked-accent/15 text-blocked-accent border-blocked-accent/30";
    case "muted":
      return "bg-t-muted/15 text-t-tertiary border-t-muted/30";
    case "info":
      return "bg-info/15 text-info border-info/30";
  }
}

/**
 * Format worktree path for display.
 * Shows only the worktree folder name (e.g., "bd-beads-kanban-ui-0io")
 */
export function formatWorktreePath(path: string): string {
  const match = path.match(/\.worktrees\/(.+)$/);
  if (match) {
    return match[1];
  }
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "\u2026";
}

/**
 * Detect if bead is blocked by checking for unresolved dependencies.
 *
 * A bead is blocked when at least one of its dependencies (resolved
 * via {@link allBeads}) has a status other than `closed`. Closed beads
 * are never considered blocked. Dependencies that cannot be found in
 * {@link allBeads} (e.g. references to deleted beads) do NOT block —
 * this matches the behaviour of `bd ready` and `getBlockedTasks` in
 * `epic-parser.ts`.
 *
 * @param bead - The bead to evaluate (only `status` and `deps` are used).
 * @param allBeads - All beads available for dep resolution. Pass the
 *   full board state — `deps` lookup is O(deps.length) over a Map.
 */
export function isBlocked(
  bead: { status: string; deps?: string[] | null },
  allBeads: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  if (bead.status === "closed") return false;
  const deps = bead.deps ?? [];
  if (deps.length === 0) return false;
  const statusById = new Map(allBeads.map((b) => [b.id, b.status]));
  return deps.some((depId) => {
    const status = statusById.get(depId);
    return status !== undefined && status !== "closed";
  });
}
