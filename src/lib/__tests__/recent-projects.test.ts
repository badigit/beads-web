import { describe, it, expect } from 'vitest';

import type { Project } from '@/types';

import { RECENT_PROJECTS_LIMIT, selectRecentProjects } from '../recent-projects';

function project(id: string): Project {
  return {
    id,
    name: `name-${id}`,
    path: `/repos/${id}`,
    tags: [],
    lastOpened: '2026-09-19T00:00:00Z',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

describe('selectRecentProjects', () => {
  it('keeps the backend order when no project is open', () => {
    const list = [project('a'), project('b'), project('c')];
    expect(selectRecentProjects(list, null).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('hoists the current project to the front without dropping the rest', () => {
    const list = [project('a'), project('b'), project('c')];
    expect(selectRecentProjects(list, 'c').map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('marks only the current project', () => {
    const list = [project('a'), project('b')];
    const picked = selectRecentProjects(list, 'b');
    expect(picked.map((p) => p.isCurrent)).toEqual([true, false]);
  });

  it('marks nothing when the open project is not in the list', () => {
    const picked = selectRecentProjects([project('a')], 'missing');
    expect(picked.map((p) => p.id)).toEqual(['a']);
    expect(picked.every((p) => !p.isCurrent)).toBe(true);
  });

  it('caps the strip at ten entries', () => {
    const list = Array.from({ length: 25 }, (_, i) => project(`p${i}`));
    const picked = selectRecentProjects(list, null);
    expect(RECENT_PROJECTS_LIMIT).toBe(10);
    expect(picked).toHaveLength(10);
    expect(picked[9].id).toBe('p9');
  });

  it('keeps the current project inside the cap even if it ranked last', () => {
    const list = Array.from({ length: 25 }, (_, i) => project(`p${i}`));
    const picked = selectRecentProjects(list, 'p24');
    expect(picked).toHaveLength(10);
    expect(picked[0].id).toBe('p24');
    expect(picked.map((p) => p.id)).not.toContain('p9');
  });

  it('tolerates an empty list', () => {
    expect(selectRecentProjects([], 'a')).toEqual([]);
  });
});
