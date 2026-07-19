import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Bead } from '@/types';

import { BeadCard } from '../bead-card';

const writeText = vi.fn();

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  writable: true,
  configurable: true,
});

const BEAD: Bead = {
  id: 'bweb-0wk',
  title: 'fnm-шимы bd затеняют winget-установку',
  description: 'Найдено при починке лаунчера',
  status: 'open',
  priority: 2,
  issue_type: 'bug',
  owner: 'badigit',
  created_at: '2026-07-18T00:00:00Z',
  updated_at: '2026-07-18T00:00:00Z',
  comments: [],
};

/**
 * Displayed id — must be the real bead id, byte for byte. The card no
 * longer substitutes a hardcoded "BD-" prefix (bweb-276): screen and
 * clipboard must agree on the same string.
 */
const DISPLAYED_ID = BEAD.id;

/**
 * Render a BeadCard under the theme that selects `layout`.
 * Theme is read from localStorage by useTheme, so no provider is needed.
 */
function renderCard(themeId: string, bead: Bead = BEAD) {
  const onSelect = vi.fn();
  localStorage.setItem('beads-theme', themeId);
  render(
    <BeadCard bead={bead} allBeads={[bead]} ticketNumber={35} onSelect={onSelect} />
  );
  return { onSelect, id: screen.getByText(bead.id) };
}

/**
 * Fire an event and let the copy promise settle — CopyableText awaits
 * navigator.clipboard before setting state, which React flags outside act().
 */
async function fireAndSettle(fire: () => void) {
  await act(async () => {
    fire();
  });
}

// Themes per src/lib/themes.ts: linear-minimal → compact-row,
// notion-warm → property-tags, default → standard.
const LAYOUTS: Array<[string, string]> = [
  ['compact-row', 'linear-minimal'],
  ['property-tags', 'notion-warm'],
  ['standard', 'default'],
];

describe('clicking the bead ID on a kanban card', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    localStorage.clear();
  });

  it.each(LAYOUTS)('copies the full key in %s layout', async (_layout, themeId) => {
    const { id } = renderCard(themeId);

    await fireAndSettle(() => fireEvent.click(id));

    expect(writeText).toHaveBeenCalledWith('bweb-0wk');
  });

  it.each(LAYOUTS)('does not open the detail panel in %s layout', async (_layout, themeId) => {
    const { onSelect, id } = renderCard(themeId);

    await fireAndSettle(() => fireEvent.click(id));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(LAYOUTS)('copies via keyboard in %s layout', async (_layout, themeId) => {
    const { onSelect, id } = renderCard(themeId);

    await fireAndSettle(() => fireEvent.keyDown(id, { key: 'Enter' }));

    expect(writeText).toHaveBeenCalledWith('bweb-0wk');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('still selects the bead when clicking elsewhere on the card', async () => {
    const { onSelect } = renderCard('notion-warm');

    await fireAndSettle(() => fireEvent.click(screen.getByText(BEAD.title)));

    expect(onSelect).toHaveBeenCalledWith(BEAD);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies the ticket number separately from the key', async () => {
    localStorage.setItem('beads-theme', 'notion-warm');
    render(
      <BeadCard bead={BEAD} allBeads={[BEAD]} ticketNumber={35} onSelect={vi.fn()} />
    );

    await fireAndSettle(() => fireEvent.click(screen.getByText('#35')));

    expect(writeText).toHaveBeenCalledWith('#35');
  });
});

describe('displayed bead id matches the real id (no "BD-" substitution)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(LAYOUTS)('shows the full real id in %s layout', (_layout, themeId) => {
    renderCard(themeId);

    expect(screen.getByText(DISPLAYED_ID)).toBeInTheDocument();
    expect(screen.queryByText(/^BD-/)).not.toBeInTheDocument();
  });

  it.each(LAYOUTS)('shows the full id for other project prefixes in %s layout, not a hardcoded "BD-"', (_layout, themeId) => {
    const otherProjectBead: Bead = { ...BEAD, id: 'config_parser-9' };

    renderCard(themeId, otherProjectBead);

    expect(screen.getByText('config_parser-9')).toBeInTheDocument();
    expect(screen.queryByText(/^BD-/)).not.toBeInTheDocument();
  });

  it.each(LAYOUTS)('shows the full id for a dotted subtask id in %s layout', (_layout, themeId) => {
    const subtaskBead: Bead = { ...BEAD, id: 'bweb-1ey.2' };

    renderCard(themeId, subtaskBead);

    expect(screen.getByText('bweb-1ey.2')).toBeInTheDocument();
  });
});
