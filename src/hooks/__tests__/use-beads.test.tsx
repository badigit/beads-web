import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Bead } from '@/types';

// --- Mocks ------------------------------------------------------------------
//
// `useBeads` composes:
//   - `loadProjectBeads` (src/lib/beads-parser) — the network fetch.
//   - `useFileWatcher` (src/hooks/use-file-watcher) — SSE watcher, stubbed out
//     so nothing tries to open an EventSource in jsdom.
// Grouping/ticket helpers are the real implementations.

const loadProjectBeadsMock = vi.fn();

vi.mock('@/lib/beads-parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/beads-parser')>(
    '@/lib/beads-parser'
  );
  return {
    ...actual,
    loadProjectBeads: (...args: unknown[]) => loadProjectBeadsMock(...args),
  };
});

vi.mock('@/hooks/use-file-watcher', () => ({
  useFileWatcher: () => ({ isWatching: false, error: null }),
}));

// Import AFTER the mocks so the hook picks them up.
/* eslint-disable import/first, import/order */
import { useBeads } from '../use-beads';
import { invalidateBeadsCache, getCachedBeads, RECONCILE_INTERVAL_MS } from '@/lib/beads-cache';
/* eslint-enable import/first, import/order */

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

/** Last `updatedAfter` value the hook passed to the fetcher. */
function updatedAfterOfCall(index: number): string | undefined {
  const call = loadProjectBeadsMock.mock.calls[index];
  return (call?.[1] as { updatedAfter?: string } | undefined)?.updatedAfter;
}

beforeEach(() => {
  invalidateBeadsCache();
  loadProjectBeadsMock.mockReset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBeads — cold start (cache miss)', () => {
  it('shows the loading state and does a full fetch', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1')]);

    const { result } = renderHook(() => useBeads('/proj'));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.beads.map((b) => b.id)).toEqual(['a-1']);
    // First call must not be incremental — there is no cursor yet.
    expect(updatedAfterOfCall(0)).toBeUndefined();
  });

  it('populates the module-level cache so it survives unmount', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1'), bead('a-2')]);

    const { result, unmount } = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(result.current.beads).toHaveLength(2));

    unmount();

    const entry = getCachedBeads('/proj');
    expect(entry?.beads.map((b) => b.id)).toEqual(['a-1', 'a-2']);
  });
});

describe('useBeads — warm start (cache hit, stale-while-revalidate)', () => {
  it('renders cached beads immediately without a loading state', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1')]);

    const first = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(first.result.current.beads).toHaveLength(1));
    first.unmount();

    // Second mount — the fetch never resolves, so anything rendered can only
    // have come from the cache.
    loadProjectBeadsMock.mockImplementation(() => new Promise(() => {}));
    const second = renderHook(() => useBeads('/proj'));

    // Synchronously on the very first render, before any effect resolves.
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.beads.map((b) => b.id)).toEqual(['a-1']);
  });

  it('still revalidates in the background and flags it', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1')]);
    const first = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(first.result.current.beads).toHaveLength(1));
    first.unmount();

    let resolveFetch: (beads: Bead[]) => void = () => {};
    loadProjectBeadsMock.mockImplementation(
      () => new Promise<Bead[]>((resolve) => { resolveFetch = resolve; })
    );

    const second = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(second.result.current.isRevalidating).toBe(true));
    expect(second.result.current.isLoading).toBe(false);

    await act(async () => {
      resolveFetch([bead('a-1', { title: 'fresh' }), bead('a-2')]);
    });

    await waitFor(() => expect(second.result.current.isRevalidating).toBe(false));
    expect(second.result.current.beads).toHaveLength(2);
  });

  it('serves cached beads for a project path swapped in mid-mount', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1')]);
    const { result, unmount } = renderHook(
      ({ path }) => useBeads(path),
      { initialProps: { path: '/proj-a' } }
    );
    await waitFor(() => expect(result.current.beads).toHaveLength(1));
    unmount();

    loadProjectBeadsMock.mockResolvedValue([bead('b-1'), bead('b-2')]);
    const second = renderHook(({ path }) => useBeads(path), {
      initialProps: { path: '/proj-b' },
    });
    await waitFor(() => expect(second.result.current.beads).toHaveLength(2));

    // Swapping back to a cached path must not blank the board or spin.
    loadProjectBeadsMock.mockImplementation(() => new Promise(() => {}));
    second.rerender({ path: '/proj-a' });

    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.beads.map((b) => b.id)).toEqual(['a-1']);
  });
});

describe('useBeads — incremental fetching', () => {
  it('passes updated_after on the refresh that follows a full load', async () => {
    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);

    const { result } = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    loadProjectBeadsMock.mockResolvedValue([]);
    await act(async () => { await result.current.refresh({ incremental: true }); });

    expect(updatedAfterOfCall(1)).toBe('2026-02-01T00:00:00Z');
  });

  it('merges incrementally fetched beads into the existing set', async () => {
    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
      bead('a-2', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);

    const { result } = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(result.current.beads).toHaveLength(2));

    loadProjectBeadsMock.mockResolvedValue([
      bead('a-2', { title: 'changed', updated_at: '2026-03-01T00:00:00Z' }),
      bead('a-3', { updated_at: '2026-03-01T00:00:00Z' }),
    ]);
    await act(async () => { await result.current.refresh({ incremental: true }); });

    expect(result.current.beads.map((b) => b.id).sort()).toEqual(['a-1', 'a-2', 'a-3']);
    expect(result.current.beads.find((b) => b.id === 'a-2')?.title).toBe('changed');
  });
});

describe('useBeads — reconcile removes deleted beads', () => {
  it('drops beads missing from a full reconcile response', async () => {
    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
      bead('a-2', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);

    const { result } = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(result.current.beads).toHaveLength(2));

    // a-2 was deleted at the source.
    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);
    await act(async () => { await result.current.refresh(); });

    // A plain refresh is a full reconcile — no updated_after, deletions applied.
    expect(updatedAfterOfCall(1)).toBeUndefined();
    expect(result.current.beads.map((b) => b.id)).toEqual(['a-1']);
    expect(getCachedBeads('/proj')?.beads.map((b) => b.id)).toEqual(['a-1']);
  });

  it('forces a full reconcile once the reconcile interval elapses', async () => {
    const start = Date.UTC(2026, 0, 1);
    // Only fake the clock — real setTimeout keeps waitFor/act working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);

    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
      bead('a-2', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);

    const { result } = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(result.current.beads).toHaveLength(2));

    // Within the interval an incremental refresh stays incremental and the
    // deleted bead survives (this is the trap the reconcile exists for).
    vi.setSystemTime(start + 1_000);
    loadProjectBeadsMock.mockResolvedValue([]);
    await act(async () => { await result.current.refresh({ incremental: true }); });
    expect(updatedAfterOfCall(1)).toBe('2026-02-01T00:00:00Z');
    expect(result.current.beads).toHaveLength(2);

    // Past the interval the same incremental refresh is upgraded to a full one.
    vi.setSystemTime(start + RECONCILE_INTERVAL_MS + 1);
    loadProjectBeadsMock.mockResolvedValue([
      bead('a-1', { updated_at: '2026-02-01T00:00:00Z' }),
    ]);
    await act(async () => { await result.current.refresh({ incremental: true }); });

    expect(updatedAfterOfCall(2)).toBeUndefined();
    expect(result.current.beads.map((b) => b.id)).toEqual(['a-1']);
  });
});

describe('useBeads — errors', () => {
  it('surfaces a cold-start failure', async () => {
    loadProjectBeadsMock.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useBeads('/proj'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
  });

  it('keeps showing stale cached beads when background revalidation fails', async () => {
    loadProjectBeadsMock.mockResolvedValue([bead('a-1')]);
    const first = renderHook(() => useBeads('/proj'));
    await waitFor(() => expect(first.result.current.beads).toHaveLength(1));
    first.unmount();

    loadProjectBeadsMock.mockRejectedValue(new Error('offline'));
    const second = renderHook(() => useBeads('/proj'));

    await waitFor(() => expect(second.result.current.isRevalidating).toBe(false));
    expect(second.result.current.error).toBeNull();
    expect(second.result.current.beads.map((b) => b.id)).toEqual(['a-1']);
  });
});
