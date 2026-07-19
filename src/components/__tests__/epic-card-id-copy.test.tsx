import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Bead, Epic } from '@/types';

import { EpicCard } from '../epic-card';

const writeText = vi.fn();

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  writable: true,
  configurable: true,
});

const layoutMock = vi.fn(() => 'standard');

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: { layout: layoutMock() }, layout: layoutMock(), themeId: 'default' }),
}));

vi.mock('@/lib/api', () => ({
  git: { prStatus: vi.fn().mockResolvedValue(null) },
  session: { spawn: vi.fn() },
}));

const child: Bead = {
  id: 'bweb-en5.2',
  title: 'Child task',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
} as Bead;

const EPIC: Epic = {
  id: 'bweb-en5',
  title: 'Spawn sessions from a bead',
  status: 'open',
  priority: 2,
  issue_type: 'epic',
  children: [child.id],
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
} as Epic;

function renderEpic(layout: string) {
  layoutMock.mockReturnValue(layout);
  const onSelect = vi.fn();
  render(
    <EpicCard
      epic={EPIC}
      allBeads={[EPIC as Bead, child]}
      ticketNumber={42}
      onSelect={onSelect}
      onChildClick={vi.fn()}
      projectPath="C:/Users/Dee/GitHub/beads-web"
    />
  );
  return { onSelect };
}

/** CopyableText awaits navigator.clipboard before setState — settle inside act. */
async function fireAndSettle(fire: () => void) {
  await act(async () => {
    fire();
  });
}

// Layouts whose badge renders "#N <id>" as one visual unit. compact-row shows
// the bare epic id, so there is no ticket number to click there.
const TICKET_LAYOUTS = ['property-tags', 'standard'];

/**
 * bweb-deq: the whole "#42 bweb-en5" badge is a single copy target for the
 * epic id — clicking the "#42" characters must not copy the ticket number.
 */
describe('EpicCard — copying the id badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    layoutMock.mockReturnValue('standard');
  });

  it.each(TICKET_LAYOUTS)('clicking "#42" copies the epic id in %s layout', async (layout) => {
    renderEpic(layout);

    await fireAndSettle(() => fireEvent.click(screen.getByText('#42')));

    expect(writeText).toHaveBeenCalledWith('bweb-en5');
    expect(writeText).not.toHaveBeenCalledWith('#42');
  });

  it.each(TICKET_LAYOUTS)('clicking the badge does not open the epic in %s layout', async (layout) => {
    const { onSelect } = renderEpic(layout);

    await fireAndSettle(() => fireEvent.click(screen.getByText('#42')));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(TICKET_LAYOUTS)('exposes one copy button naming the epic id in %s layout', (layout) => {
    renderEpic(layout);

    const buttons = screen.getAllByRole('button', { name: /copy epic id bweb-en5/i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('#42');
    expect(buttons[0]).toHaveTextContent('bweb-en5');
    expect(screen.queryByRole('button', { name: /copy #42/i })).not.toBeInTheDocument();
  });

  it.each(TICKET_LAYOUTS)('copies the epic id via Enter in %s layout', async (layout) => {
    const { onSelect } = renderEpic(layout);

    const badge = screen.getByRole('button', { name: /copy epic id bweb-en5/i });
    await fireAndSettle(() => fireEvent.keyDown(badge, { key: 'Enter' }));

    expect(writeText).toHaveBeenCalledWith('bweb-en5');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('copies the epic id from the bare badge in compact-row layout', async () => {
    const { onSelect } = renderEpic('compact-row');

    const badge = screen.getByRole('button', { name: /copy epic id bweb-en5/i });
    await fireAndSettle(() => fireEvent.click(badge));

    expect(writeText).toHaveBeenCalledWith('bweb-en5');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
