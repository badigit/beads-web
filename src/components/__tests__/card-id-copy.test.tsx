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

/** Displayed short form of BEAD.id — the element the user clicks. */
const SHORT_ID = 'BD-0wk';

/**
 * Render a BeadCard under the theme that selects `layout`.
 * Theme is read from localStorage by useTheme, so no provider is needed.
 */
function renderCard(themeId: string) {
  const onSelect = vi.fn();
  localStorage.setItem('beads-theme', themeId);
  render(
    <BeadCard bead={BEAD} allBeads={[BEAD]} ticketNumber={35} onSelect={onSelect} />
  );
  return { onSelect, id: screen.getByText(SHORT_ID) };
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
