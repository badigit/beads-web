import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SearchResult } from '@/lib/api';

import { BeadResolver } from '../bead-resolver';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const searchQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  search: { query: (...args: unknown[]) => searchQuery(...args) },
}));

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    project_id: 'p1',
    project_name: 'beads-web',
    database: 'beads_web',
    bead_id: 'bweb-vch',
    title: 'Short bead links',
    status: 'open',
    ...overrides,
  };
}

beforeEach(() => {
  replace.mockReset();
  searchQuery.mockReset();
  searchQuery.mockResolvedValue([hit()]);
});

describe('BeadResolver', () => {
  it('redirects to the canonical URL when one project owns the bead', async () => {
    render(<BeadResolver beadId="bweb-vch" />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/project?id=p1&bead=bweb-vch'));
    expect(searchQuery).toHaveBeenCalledWith('bweb-vch', expect.anything());
  });

  it('shows a choice instead of guessing when two projects match', async () => {
    searchQuery.mockResolvedValue([hit(), hit({ project_id: 'p2', project_name: 'fork' })]);
    render(<BeadResolver beadId="bweb-vch" />);

    expect(await screen.findByRole('link', { name: 'beads-web' })).toHaveAttribute(
      'href',
      '/project?id=p1&bead=bweb-vch'
    );
    expect(screen.getByRole('link', { name: 'fork' })).toHaveAttribute(
      'href',
      '/project?id=p2&bead=bweb-vch'
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('explains an unknown prefix rather than rendering an empty board', async () => {
    searchQuery.mockResolvedValue([]);
    render(<BeadResolver beadId="nope-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/No project has a bead called nope-1/);
    expect(replace).not.toHaveBeenCalled();
  });

  it('names the database when the bead exists outside the registry', async () => {
    searchQuery.mockResolvedValue([hit({ project_id: null, database: 'beads_orphan' })]);
    render(<BeadResolver beadId="bweb-vch" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/beads_orphan/);
  });

  it('surfaces a lookup failure', async () => {
    searchQuery.mockRejectedValue(new Error('Dolt unreachable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BeadResolver beadId="bweb-vch" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Dolt unreachable/);
  });
});
