import { describe, it, expect, beforeEach } from 'vitest';

import {
  RECONCILE_INTERVAL_MS,
  getCachedBeads,
  setCachedBeads,
  invalidateBeadsCache,
  shouldReconcile,
  mergeBeads,
  maxUpdatedAt,
} from '@/lib/beads-cache';
import type { Bead } from '@/types';

function bead(id: string, overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Bead ${id}`,
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: 'someone',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    comments: [],
    ...overrides,
  };
}

beforeEach(() => {
  invalidateBeadsCache();
});

describe('beads-cache — hit / miss', () => {
  it('returns undefined for a path that was never cached (miss)', () => {
    expect(getCachedBeads('/no/such/project')).toBeUndefined();
  });

  it('returns the stored entry for a cached path (hit)', () => {
    const beads = [bead('a-1')];
    setCachedBeads('/proj', {
      beads,
      lastUpdatedAt: '2026-01-01T00:00:00Z',
      lastFullFetchAt: 1000,
    });

    const entry = getCachedBeads('/proj');
    expect(entry).toBeDefined();
    expect(entry?.beads).toHaveLength(1);
    expect(entry?.beads[0].id).toBe('a-1');
    expect(entry?.lastUpdatedAt).toBe('2026-01-01T00:00:00Z');
    expect(entry?.lastFullFetchAt).toBe(1000);
  });

  it('keeps entries per project path independently', () => {
    setCachedBeads('/a', { beads: [bead('a-1')], lastUpdatedAt: null, lastFullFetchAt: 0 });
    setCachedBeads('/b', { beads: [bead('b-1'), bead('b-2')], lastUpdatedAt: null, lastFullFetchAt: 0 });

    expect(getCachedBeads('/a')?.beads).toHaveLength(1);
    expect(getCachedBeads('/b')?.beads).toHaveLength(2);
  });

  it('does not expose the stored array by reference (callers cannot mutate the cache)', () => {
    const beads = [bead('a-1')];
    setCachedBeads('/proj', { beads, lastUpdatedAt: null, lastFullFetchAt: 0 });

    beads.push(bead('a-2'));
    expect(getCachedBeads('/proj')?.beads).toHaveLength(1);
  });
});

describe('beads-cache — invalidation', () => {
  it('invalidates a single project path', () => {
    setCachedBeads('/a', { beads: [bead('a-1')], lastUpdatedAt: null, lastFullFetchAt: 0 });
    setCachedBeads('/b', { beads: [bead('b-1')], lastUpdatedAt: null, lastFullFetchAt: 0 });

    invalidateBeadsCache('/a');

    expect(getCachedBeads('/a')).toBeUndefined();
    expect(getCachedBeads('/b')).toBeDefined();
  });

  it('invalidates everything when called without a path', () => {
    setCachedBeads('/a', { beads: [bead('a-1')], lastUpdatedAt: null, lastFullFetchAt: 0 });
    setCachedBeads('/b', { beads: [bead('b-1')], lastUpdatedAt: null, lastFullFetchAt: 0 });

    invalidateBeadsCache();

    expect(getCachedBeads('/a')).toBeUndefined();
    expect(getCachedBeads('/b')).toBeUndefined();
  });
});

describe('beads-cache — shouldReconcile', () => {
  it('is true when nothing is cached for the path', () => {
    expect(shouldReconcile('/proj', 5_000)).toBe(true);
  });

  it('is false right after a full fetch', () => {
    setCachedBeads('/proj', { beads: [], lastUpdatedAt: null, lastFullFetchAt: 10_000 });
    expect(shouldReconcile('/proj', 10_000)).toBe(false);
    expect(shouldReconcile('/proj', 10_000 + RECONCILE_INTERVAL_MS - 1)).toBe(false);
  });

  it('is true once the reconcile interval has elapsed', () => {
    setCachedBeads('/proj', { beads: [], lastUpdatedAt: null, lastFullFetchAt: 10_000 });
    expect(shouldReconcile('/proj', 10_000 + RECONCILE_INTERVAL_MS)).toBe(true);
  });

  it('honours a custom interval', () => {
    setCachedBeads('/proj', { beads: [], lastUpdatedAt: null, lastFullFetchAt: 10_000 });
    expect(shouldReconcile('/proj', 11_000, 5_000)).toBe(false);
    expect(shouldReconcile('/proj', 16_000, 5_000)).toBe(true);
  });
});

describe('beads-cache — mergeBeads', () => {
  it('adds beads that are not in the previous set', () => {
    const merged = mergeBeads([bead('a-1')], [bead('a-2')]);
    expect(merged.map((b) => b.id).sort()).toEqual(['a-1', 'a-2']);
  });

  it('replaces beads that already exist', () => {
    const merged = mergeBeads(
      [bead('a-1', { title: 'old' })],
      [bead('a-1', { title: 'new' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('new');
  });

  it('preserves order of existing beads and appends new ones', () => {
    const merged = mergeBeads(
      [bead('a-1'), bead('a-2')],
      [bead('a-3'), bead('a-1', { title: 'updated' })]
    );
    expect(merged.map((b) => b.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(merged[0].title).toBe('updated');
  });

  it('cannot drop beads on its own — deletions require a full reconcile', () => {
    // This documents the trap that makes periodic reconcile mandatory:
    // an incremental merge never removes anything.
    const merged = mergeBeads([bead('a-1'), bead('a-2')], [bead('a-1')]);
    expect(merged.map((b) => b.id)).toEqual(['a-1', 'a-2']);
  });
});

describe('beads-cache — maxUpdatedAt', () => {
  it('returns the newest updated_at across beads', () => {
    const result = maxUpdatedAt([
      bead('a-1', { updated_at: '2026-01-01T00:00:00Z' }),
      bead('a-2', { updated_at: '2026-03-01T00:00:00Z' }),
      bead('a-3', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);
    expect(result).toBe('2026-03-01T00:00:00Z');
  });

  it('falls back to created_at when updated_at is missing', () => {
    const b = bead('a-1', { created_at: '2026-05-01T00:00:00Z' });
    // Simulate a payload without updated_at.
    delete (b as Partial<Bead>).updated_at;
    expect(maxUpdatedAt([b])).toBe('2026-05-01T00:00:00Z');
  });

  it('keeps the previous cursor when the incremental response is empty', () => {
    expect(maxUpdatedAt([], '2026-04-01T00:00:00Z')).toBe('2026-04-01T00:00:00Z');
  });

  it('returns the seed when it is newer than anything fetched', () => {
    expect(
      maxUpdatedAt([bead('a-1', { updated_at: '2026-01-01T00:00:00Z' })], '2026-04-01T00:00:00Z')
    ).toBe('2026-04-01T00:00:00Z');
  });

  it('returns null for an empty set with no seed', () => {
    expect(maxUpdatedAt([])).toBeNull();
  });
});
