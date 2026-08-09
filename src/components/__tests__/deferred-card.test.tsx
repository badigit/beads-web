import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DEFERRED_CARD_CLASSES } from '@/lib/bead-utils';
import { loadProjectBeads } from '@/lib/beads-parser';
import type { Bead, Epic } from '@/types';

import { BeadCard } from '../bead-card';
import { EpicCard } from '../epic-card';

/** Split once: toHaveClass takes classes one per argument. */
const DIMMED = DEFERRED_CARD_CLASSES.split(' ');

/**
 * Asserts a card carries none of the dimming classes.
 *
 * Checked one by one on purpose: `not.toHaveClass(a, b)` passes as soon as a
 * SINGLE class is missing, so an active card that somehow kept `opacity-50`
 * would still slip through.
 */
function expectNotDimmed(el: Element | null) {
  for (const cls of DIMMED) {
    expect(el).not.toHaveClass(cls);
  }
}

/**
 * bweb-8md: a bead put aside with `bd defer` stays in the Open column by
 * design, so the badge and the dimmed card are the ONLY thing separating it
 * from live work. Both went missing once already (the badge was rendered in
 * one of three layouts, and never on epics at all) — these tests fail loudly
 * if a card refactor drops the marker again.
 */

const layoutMock = vi.fn(() => 'standard');

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: { layout: layoutMock() }, layout: layoutMock(), themeId: 'default' }),
}));

vi.mock('@/lib/api', () => ({
  beads: { read: vi.fn() },
  git: { prStatus: vi.fn().mockResolvedValue(null) },
  session: { spawn: vi.fn() },
}));

/** Every card layout the themes can pick — the marker must survive all of them. */
const LAYOUTS = ['standard', 'compact-row', 'property-tags'];

function deferredBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'tvp-0i3.1',
    title: 'Parked task',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    created_at: '2026-07-04T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    comments: [],
    _originalStatus: 'deferred',
    _statusBadge: { label: 'Deferred', variant: 'muted' },
    ...overrides,
  } as Bead;
}

function renderBeadCard(bead: Bead, layout: string) {
  layoutMock.mockReturnValue(layout);
  return render(<BeadCard bead={bead} allBeads={[bead]} onSelect={vi.fn()} />);
}

function renderEpicCard(epic: Epic, layout: string) {
  layoutMock.mockReturnValue(layout);
  return render(
    <EpicCard
      epic={epic}
      allBeads={[epic as Bead]}
      onSelect={vi.fn()}
      onChildClick={vi.fn()}
      projectPath="C:/Users/Dee/GitHub/trade-vp1"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutMock.mockReturnValue('standard');
});

describe('BeadCard — deferred marker', () => {
  it.each(LAYOUTS)('shows the Deferred badge in %s layout', (layout) => {
    renderBeadCard(deferredBead(), layout);

    expect(screen.getByText(/Deferred/)).toBeInTheDocument();
  });

  it.each(LAYOUTS)('dims the card in %s layout', (layout) => {
    const { container } = renderBeadCard(deferredBead(), layout);

    expect(container.querySelector('[data-bead-id="tvp-0i3.1"]')).toHaveClass(...DIMMED);
  });

  it.each(LAYOUTS)('leaves a plain open bead unmarked in %s layout', (layout) => {
    const open = deferredBead({ _originalStatus: undefined, _statusBadge: undefined });
    const { container } = renderBeadCard(open, layout);

    expect(screen.queryByText(/Deferred/)).not.toBeInTheDocument();
    expectNotDimmed(container.querySelector('[data-bead-id="tvp-0i3.1"]'));
  });

  it.each(LAYOUTS)('appends the defer_until date in %s layout', (layout) => {
    renderBeadCard(deferredBead({ defer_until: '2026-08-24T21:00:00Z' }), layout);

    // Stored as a UTC instant; the card shows it in the viewer's timezone.
    const expected = new Date('2026-08-24T21:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    expect(screen.getByText(`Deferred · ${expected}`)).toBeInTheDocument();
  });

  it('shows the bare label when deferred without a date', () => {
    renderBeadCard(deferredBead({ defer_until: null }), 'standard');

    expect(screen.getByText('Deferred')).toBeInTheDocument();
  });
});

describe('EpicCard — deferred marker', () => {
  const epic = {
    ...deferredBead({ id: 'tvp-0i3', title: 'Collaborative strategy dev', issue_type: 'epic' }),
    children: [],
  } as unknown as Epic;

  it.each(LAYOUTS)('shows the Deferred badge in %s layout', (layout) => {
    renderEpicCard(epic, layout);

    expect(screen.getByText(/Deferred/)).toBeInTheDocument();
  });

  it.each(LAYOUTS)('dims the card in %s layout', (layout) => {
    const { container } = renderEpicCard(epic, layout);

    expect(container.querySelector('[data-bead-id="tvp-0i3"]')).toHaveClass(...DIMMED);
  });

  it('leaves an active epic unmarked', () => {
    const active = { ...epic, _originalStatus: undefined, _statusBadge: undefined } as Epic;
    const { container } = renderEpicCard(active, 'standard');

    expect(screen.queryByText(/Deferred/)).not.toBeInTheDocument();
    expectNotDimmed(container.querySelector('[data-bead-id="tvp-0i3"]'));
  });
});

describe('deferred beads end to end, from API payload to card', () => {
  it('renders the marker for a bead the API reports as status="deferred"', async () => {
    const api = await import('@/lib/api');
    // Shaped like the raw API payload: `deferred` is a bd status, not one of
    // the four board columns, so it cannot be typed as a Bead before parsing.
    vi.mocked(api.beads.read).mockResolvedValue({
      beads: [
        {
          id: 'tvp-0i3',
          title: 'Collaborative strategy dev',
          status: 'deferred',
          defer_until: '2026-08-24T21:00:00Z',
          priority: 1,
          issue_type: 'task',
          owner: 'cryt0r@gmail.com',
          created_at: '2026-07-04T00:00:00Z',
          updated_at: '2026-08-09T00:00:00Z',
        },
      ],
      source: 'dolt-direct',
    } as unknown as Awaited<ReturnType<typeof api.beads.read>>);

    const [bead] = await loadProjectBeads('C:/Users/Dee/GitHub/trade-vp1');

    // The parser drops it into the open column but must keep the raw status…
    expect(bead.status).toBe('open');
    expect(bead._originalStatus).toBe('deferred');
    expect(bead.defer_until).toBe('2026-08-24T21:00:00Z');

    // …and the card must turn that into something visible.
    renderBeadCard(bead, 'standard');
    expect(screen.getByText(/^Deferred · /)).toBeInTheDocument();
  });
});
