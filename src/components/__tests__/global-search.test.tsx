import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { SearchResult } from '@/lib/api';

import { GlobalSearch } from '../global-search';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
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

/** Opens the palette with the global shortcut and types a query. */
async function openAndType(text: string) {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const input = await screen.findByRole('combobox');
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return input;
}

// jsdom does not implement scrollIntoView, which the palette uses to keep the
// highlighted row visible.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  // shouldAdvanceTime keeps testing-library's waitFor polling alive while the
  // debounce timer stays under manual control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  push.mockReset();
  searchQuery.mockReset();
  searchQuery.mockResolvedValue(HITS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GlobalSearch', () => {
  it('opens on Ctrl+K and focuses the input', async () => {
    render(<GlobalSearch />);
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const input = await screen.findByRole('combobox');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('shows the minimum-length hint and does not call the API for 1 char', async () => {
    render(<GlobalSearch />);
    await openAndType('b');

    expect(searchQuery).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument();
  });

  it('debounces the query and renders hits in server order', async () => {
    render(<GlobalSearch />);
    await openAndType('palette');

    expect(searchQuery).toHaveBeenCalledTimes(1);
    expect(searchQuery.mock.calls[0][0]).toBe('palette');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('bweb-489.12.2');
    expect(options[1]).toHaveTextContent('orph-1');
  });

  it('distinguishes projects by badge and marks unregistered hits disabled', async () => {
    render(<GlobalSearch />);
    await openAndType('palette');

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('beads-web');
    expect(options[0]).toHaveAttribute('aria-disabled', 'false');
    // No project_id → falls back to the Dolt database name and is not navigable.
    expect(options[1]).toHaveTextContent('orphan_db');
    expect(options[1]).toHaveAttribute('aria-disabled', 'true');
  });

  it('navigates to the project on Enter and tracks the active row', async () => {
    render(<GlobalSearch />);
    const input = await openAndType('palette');

    expect(input).toHaveAttribute('aria-activedescendant', 'global-search-option-0');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(push).toHaveBeenCalledWith('/project?id=p1');
  });

  it('does not navigate when the hit has no local project', async () => {
    render(<GlobalSearch />);
    const input = await openAndType('palette');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'global-search-option-1');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).not.toHaveBeenCalled();
  });

  it('wraps the selection with ArrowDown past the last row', async () => {
    render(<GlobalSearch />);
    const input = await openAndType('palette');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(input).toHaveAttribute('aria-activedescendant', 'global-search-option-0');
  });

  it('reports an empty result set', async () => {
    searchQuery.mockResolvedValue([]);
    render(<GlobalSearch />);
    await openAndType('zzzz');

    expect(screen.getByText(/nothing found/i)).toBeInTheDocument();
  });

  it('aborts the previous request when the query changes', async () => {
    render(<GlobalSearch />);
    const input = await openAndType('pal');

    const firstSignal = searchQuery.mock.calls[0][1] as AbortSignal;
    fireEvent.change(input, { target: { value: 'palet' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(firstSignal.aborted).toBe(true);
    expect(searchQuery).toHaveBeenCalledTimes(2);
  });
});
