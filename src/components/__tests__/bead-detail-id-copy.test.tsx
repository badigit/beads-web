import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Bead } from '@/types';

import { BeadDetail } from '../bead-detail';

const writeText = vi.fn();

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  writable: true,
  configurable: true,
});

const BEAD: Bead = {
  id: 'bweb-cod',
  title: 'Новый проект не появляется в UI до перезапуска лаунчера',
  description: 'detail header copy target',
  status: 'open',
  priority: 2,
  issue_type: 'bug',
  owner: 'badigit',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
  comments: [],
};

function renderDetail(bead: Bead = BEAD) {
  render(
    <BeadDetail
      bead={bead}
      ticketNumber={62}
      open={true}
      onOpenChange={vi.fn()}
      projectId="p1"
    />
  );
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

describe('bead detail header — id copy target', () => {
  beforeEach(() => {
    writeText.mockClear();
  });

  it('copies the bead id, not "#62", when the header badge is clicked', async () => {
    renderDetail();
    // Click the visible ticket number: it must copy the id, not "#62".
    const ticket = screen.getByText('#62');
    await fireAndSettle(() => fireEvent.click(ticket));
    expect(writeText).toHaveBeenCalledWith('bweb-cod');
    expect(writeText).not.toHaveBeenCalledWith('#62');
  });

  it('exposes a single copy control naming the bead id', () => {
    renderDetail();
    const copyButtons = screen.getAllByRole('button', { name: /^Copy bead id / });
    expect(copyButtons).toHaveLength(1);
    expect(copyButtons[0]).toHaveAccessibleName('Copy bead id bweb-cod');
    // The old per-ticket copy control must be gone.
    expect(screen.queryByRole('button', { name: 'Copy #62' })).toBeNull();
  });

  it('copies the bead id via Enter on the badge', async () => {
    renderDetail();
    const badge = screen.getByRole('button', { name: 'Copy bead id bweb-cod' });
    await fireAndSettle(() => fireEvent.keyDown(badge, { key: 'Enter' }));
    expect(writeText).toHaveBeenCalledWith('bweb-cod');
  });
});
