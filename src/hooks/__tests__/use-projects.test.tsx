import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Project } from '@/types';

// --- Mocks ------------------------------------------------------------------
//
// `useProjects` composes two dependencies:
//   - `getProjectsWithTags` (src/lib/db) — returns the project list with
//     `cachedCounts` attached by the backend.
//   - `api.beads.counts` (src/lib/api) — the lightweight per-status counts
//     endpoint that refreshes the donut values. It must NOT download the full
//     bead list (`api.beads.read`) just to compute four numbers.
//
// We mock both. By default `counts` never resolves so the hook stays in the
// "cached seed only" state and we can assert the initial render uses the
// cached counts, not zeros.

const getProjectsWithTagsMock = vi.fn();
const beadsCountsMock = vi.fn();
const beadsReadMock = vi.fn();

vi.mock('@/lib/db', () => ({
  getProjectsWithTags: (...args: unknown[]) => getProjectsWithTagsMock(...args),
  createProject: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  projects: {
    archive: vi.fn(),
    unarchive: vi.fn(),
    delete: vi.fn(),
  },
  beads: {
    counts: (...args: unknown[]) => beadsCountsMock(...args),
    read: (...args: unknown[]) => beadsReadMock(...args),
  },
}));

// Import AFTER mocks so the hook picks them up.
// eslint-disable-next-line import/first, import/order
import { useProjects } from '../use-projects';

beforeEach(() => {
  getProjectsWithTagsMock.mockReset();
  beadsCountsMock.mockReset();
  beadsReadMock.mockReset();
  // Never resolve — lets us observe the cached-seed state in isolation.
  beadsCountsMock.mockImplementation(() => new Promise(() => {}));
});

describe('useProjects — cached counts seeding', () => {
  it('seeds beadCounts from server cachedCounts on initial render', async () => {
    const project: Project = {
      id: 'p1',
      name: 'cached-project',
      path: '/tmp/cached-project',
      tags: [],
      lastOpened: '2026-04-22T00:00:00Z',
      createdAt: '2026-04-22T00:00:00Z',
      cachedCounts: {
        open: 3,
        in_progress: 1,
        inreview: 0,
        closed: 5,
        dataSource: 'dolt-direct',
        updatedAt: '2026-04-22T00:00:00Z',
      },
    };

    getProjectsWithTagsMock.mockResolvedValueOnce([project]);

    const { result } = renderHook(() => useProjects());

    // Wait for the fetch to populate state. `isLoading` flips to false
    // right after the seed step, before counts fetching starts.
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.projects).toHaveLength(1);
    const seeded = result.current.projects[0];
    expect(seeded.beadCounts).toEqual({
      open: 3,
      in_progress: 1,
      inreview: 0,
      closed: 5,
    });
    expect(seeded.countsLoaded).toBe(true);
    expect(seeded.dataSource).toBe('dolt-direct');
  });

  it('leaves countsLoaded false when no cache exists, so donut renders as dashed', async () => {
    const project: Project = {
      id: 'p2',
      name: 'fresh-project',
      path: '/tmp/fresh-project',
      tags: [],
      lastOpened: '2026-04-22T00:00:00Z',
      createdAt: '2026-04-22T00:00:00Z',
      cachedCounts: null,
    };

    getProjectsWithTagsMock.mockResolvedValueOnce([project]);

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const seeded = result.current.projects[0];
    expect(seeded.countsLoaded).toBe(false);
    // Zero counts are a fallback — NOT a real "0 tasks" signal. The
    // dashed donut rendering in project-card distinguishes these.
    expect(seeded.beadCounts).toEqual({
      open: 0,
      in_progress: 0,
      inreview: 0,
      closed: 0,
    });
  });
});

describe('useProjects — counts endpoint', () => {
  const project: Project = {
    id: 'p3',
    name: 'counted-project',
    path: '/tmp/counted-project',
    tags: [],
    lastOpened: '2026-04-22T00:00:00Z',
    createdAt: '2026-04-22T00:00:00Z',
    cachedCounts: null,
  };

  it('refreshes donut values from the counts endpoint, never from the full bead list', async () => {
    getProjectsWithTagsMock.mockResolvedValueOnce([project]);
    beadsCountsMock.mockResolvedValue({
      counts: { open: 1, in_progress: 2, inreview: 3, closed: 4 },
      source: 'dolt-central',
    });

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.projects[0]?.countsLoaded).toBe(true);
    });

    expect(beadsCountsMock).toHaveBeenCalledWith('/tmp/counted-project');
    // The whole point of the endpoint: no megabyte-sized bead download.
    expect(beadsReadMock).not.toHaveBeenCalled();

    const loaded = result.current.projects[0];
    expect(loaded.beadCounts).toEqual({
      open: 1,
      in_progress: 2,
      inreview: 3,
      closed: 4,
    });
    expect(loaded.dataSource).toBe('dolt-central');
    expect(loaded.beadError).toBeUndefined();
  });

  it('surfaces a counts failure on the project instead of throwing', async () => {
    getProjectsWithTagsMock.mockResolvedValueOnce([project]);
    beadsCountsMock.mockRejectedValue(
      new Error('API error: 503 Dolt server is not running')
    );

    const { result } = renderHook(() => useProjects());

    await waitFor(() => {
      expect(result.current.projects[0]?.beadError).toBe(
        'API error: 503 Dolt server is not running'
      );
    });
    expect(result.current.error).toBeNull();
  });
});
