import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Project } from '@/types';

import { RecentProjectsBar } from '../recent-projects-bar';

let currentId: string | null = null;
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentId ? `id=${currentId}` : ''),
}));

const listProjects = vi.fn();
vi.mock('@/lib/api', () => ({
  projects: { list: () => listProjects() },
}));

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

describe('RecentProjectsBar', () => {
  beforeEach(() => {
    currentId = null;
    listProjects.mockReset();
  });

  it('renders the backend order as links to each board', async () => {
    listProjects.mockResolvedValue([project('a'), project('b')]);
    render(<RecentProjectsBar />);

    const links = await screen.findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['name-a', 'name-b']);
    expect(links[0]).toHaveAttribute('href', '/project?id=a');
  });

  it('caps the strip at ten entries', async () => {
    listProjects.mockResolvedValue(Array.from({ length: 14 }, (_, i) => project(`p${i}`)));
    render(<RecentProjectsBar />);

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(10));
  });

  it('marks the open project and does not link it', async () => {
    currentId = 'b';
    listProjects.mockResolvedValue([project('a'), project('b')]);
    render(<RecentProjectsBar />);

    const current = await screen.findByText('name-b');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.tagName).toBe('SPAN');
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['name-a']);
  });

  it('reserves its height before the list arrives', () => {
    listProjects.mockReturnValue(new Promise(() => {}));
    render(<RecentProjectsBar />);

    const bar = screen.getByRole('navigation', { name: 'Recent projects' });
    expect(bar.className).toContain('h-[var(--recent-bar-h)]');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('stays empty and silent when the list fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listProjects.mockRejectedValue(new Error('boom'));
    render(<RecentProjectsBar />);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    warn.mockRestore();
  });
});
