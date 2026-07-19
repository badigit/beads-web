/**
 * Module-level bead cache, keyed by project path.
 *
 * Lives outside React so it survives component unmounts: navigating from a
 * project back to the project list and into the same project again serves the
 * previously loaded beads immediately (stale) while a fresh fetch runs in the
 * background.
 *
 * ## Why a periodic full reconcile is mandatory
 *
 * Incremental fetches (`updated_after`) only ever return beads that changed;
 * {@link mergeBeads} therefore adds and replaces, but can never remove. On top
 * of that, `updated_after` is only honoured by the bd CLI tier of the backend —
 * the Dolt SQL tier ignores it and returns the full set. Without a periodic
 * full reconcile, beads deleted at the source would stay in the UI forever, and
 * the cache would keep that stale state alive across mounts. Callers must use
 * {@link shouldReconcile} to upgrade an incremental fetch to a full one.
 */

import type { Bead } from "@/types";

/** How long the hook may keep serving incremental updates before a full reconcile. */
export const RECONCILE_INTERVAL_MS = 60_000;

/** Maximum number of projects kept in the cache (oldest write evicted first). */
export const MAX_CACHED_PROJECTS = 12;

/** Everything the hook needs to resume a project without a cold load. */
export interface BeadsCacheEntry {
  /** Full bead set as last known for this project. */
  beads: Bead[];
  /** Newest `updated_at` seen so far — the cursor for incremental fetches. */
  lastUpdatedAt: string | null;
  /** `Date.now()` of the last full (non-incremental) fetch. */
  lastFullFetchAt: number;
}

const cache = new Map<string, BeadsCacheEntry>();

/**
 * Read the cached entry for a project path.
 *
 * @returns The entry, or `undefined` on a cache miss.
 */
export function getCachedBeads(projectPath: string): BeadsCacheEntry | undefined {
  const entry = cache.get(projectPath);
  if (!entry) return undefined;
  // Hand out a copy of the array so callers cannot mutate cached state.
  return { ...entry, beads: [...entry.beads] };
}

/**
 * Store (or replace) the cached entry for a project path.
 */
export function setCachedBeads(projectPath: string, entry: BeadsCacheEntry): void {
  if (!projectPath) return;

  // Re-insert to refresh insertion order for the LRU-ish eviction below.
  cache.delete(projectPath);
  cache.set(projectPath, { ...entry, beads: [...entry.beads] });

  while (cache.size > MAX_CACHED_PROJECTS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Drop one project from the cache, or the whole cache when called without a path.
 */
export function invalidateBeadsCache(projectPath?: string): void {
  if (projectPath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(projectPath);
}

/**
 * Whether the next fetch for this project must be a full one.
 *
 * True when nothing is cached, or when the last full fetch is older than
 * `intervalMs`. See the module docblock for why this cannot be skipped.
 */
export function shouldReconcile(
  projectPath: string,
  now: number = Date.now(),
  intervalMs: number = RECONCILE_INTERVAL_MS
): boolean {
  const entry = cache.get(projectPath);
  if (!entry) return true;
  return now - entry.lastFullFetchAt >= intervalMs;
}

/**
 * Merge an incremental fetch into the known set.
 *
 * Existing beads keep their position and are replaced in place; unseen beads
 * are appended. Beads absent from `incoming` are kept — incremental responses
 * carry no deletion signal, so removals only happen on a full reconcile.
 */
export function mergeBeads(prev: Bead[], incoming: Bead[]): Bead[] {
  if (incoming.length === 0) return prev;

  const byId = new Map(incoming.map((b) => [b.id, b]));
  const merged: Bead[] = prev.map((existing) => {
    const updated = byId.get(existing.id);
    if (!updated) return existing;
    byId.delete(existing.id);
    return updated;
  });

  byId.forEach((added) => merged.push(added));

  return merged;
}

/**
 * Newest `updated_at` (falling back to `created_at`) across `beads`, never
 * going backwards from `seed`.
 *
 * Returning the seed unchanged for an empty response is what keeps the
 * incremental cursor stable when nothing has changed.
 */
export function maxUpdatedAt(beads: Bead[], seed: string | null = null): string | null {
  let max = seed ?? '';
  for (const bead of beads) {
    const timestamp = bead.updated_at || bead.created_at || '';
    if (timestamp > max) max = timestamp;
  }
  return max === '' ? null : max;
}
