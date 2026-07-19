import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { SearchResult } from '@/lib/api';

import { HomeBeadSearch } from '../home-bead-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/',
}));

const searchQuery = vi.fn();
vi.mock('@/lib/api', () => ({
  search: { query: (...args: unknown[]) => searchQuery(...args) },
}));

const HITS: SearchResult[] = [
  {
    project_id: 'p1',
    project_name: 'beads-web',
    database: 'beads_web',
    bead_id: 'bweb-489.12.2',
    title: 'Command palette',
    status: 'open',
  },
  {
    project_id: null,
    project_name: 'orphan_db',
    database: 'orphan_db',
    bead_id: 'orph-1',
    title: 'Unregistered project hit',
    status: 'closed',
  },
];

/** Focuses the always-visible field and types a query past the debounce. */
async function typeQuery(text: string) {
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return input;
}

Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  push.mockReset();
  searchQuery.mockReset();
  searchQuery.mockResolvedValue(HITS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HomeBeadSearch', () => {
  it('is visible without any shortcut or click', () => {
    render(<HomeBeadSearch />);

    const input = screen.getByRole('combobox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/all projects/i));
    // Collapsed until there is something to show.
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('queries the API and renders hits inline, not in a dialog', async () => {
    render(<HomeBeadSearch />);
    const input = await typeQuery('palette');

    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(searchQuery.mock.calls[0][0]).toBe('palette');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('bweb-489.12.2');
    expect(options[1]).toHaveTextContent('orph-1');
  });

  it('does not call the API below the minimum query length', async () => {
    render(<HomeBeadSearch />);
    await typeQuery('b');

    expect(searchQuery).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument();
  });

  it('opens the specific bead on Enter', async () => {
    render(<HomeBeadSearch />);
    const input = await typeQuery('palette');

    expect(input).toHaveAttribute('aria-activedescendant', 'home-search-option-0');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(push).toHaveBeenCalledWith('/project?id=p1&bead=bweb-489.12.2');
  });

  it('opens the bead on click', async () => {
    render(<HomeBeadSearch />);
    await typeQuery('palette');

    fireEvent.click(screen.getAllByRole('option')[0]);

    expect(push).toHaveBeenCalledWith('/project?id=p1&bead=bweb-489.12.2');
  });

  it('wraps arrow navigation and refuses hits without a local project', async () => {
    render(<HomeBeadSearch />);
    const input = await typeQuery('palette');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'home-search-option-1');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'home-search-option-0');
  });

  it('aborts the superseded request when the query changes', async () => {
    render(<HomeBeadSearch />);
    const input = await typeQuery('pal');

    const firstSignal = searchQuery.mock.calls[0][1] as AbortSignal;
    fireEvent.change(input, { target: { value: 'palet' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(firstSignal.aborted).toBe(true);
    expect(searchQuery).toHaveBeenCalledTimes(2);
  });

  it('collapses the dropdown and clears the query on Escape', async () => {
    render(<HomeBeadSearch />);
    const input = await typeQuery('palette');
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('collapses when clicking outside the field', async () => {
    render(<HomeBeadSearch />);
    await typeQuery('palette');
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
  });

  it('focuses the field on Ctrl+K instead of opening a palette', async () => {
    render(<HomeBeadSearch />);
    const input = screen.getByRole('combobox');
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('surfaces a backend failure in place', async () => {
    searchQuery.mockRejectedValue(new Error('search backend down'));
    render(<HomeBeadSearch />);
    await typeQuery('palette');

    expect(await screen.findByText(/search backend down/i)).toBeInTheDocument();
  });
});
