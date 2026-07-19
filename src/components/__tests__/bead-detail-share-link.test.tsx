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
  id: 'bweb-6pv',
  title: 'Deep link на карточку бида',
  description: 'Copy link affordance',
  status: 'open',
  priority: 2,
  issue_type: 'feature',
  owner: 'badigit',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
  comments: [],
};

/** Fire an event and let the copy promise settle (CopyableText awaits clipboard). */
async function fireAndSettle(fire: () => void) {
  await act(async () => {
    fire();
  });
}

describe('bead detail — copy link', () => {
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  it('renders a "copy link" affordance next to the id when a projectId is given', () => {
    render(
      <BeadDetail
        bead={BEAD}
        open={true}
        onOpenChange={vi.fn()}
        projectId="p1"
      />
    );

    expect(screen.getByRole('button', { name: 'Copy link to this bead' })).toBeInTheDocument();
  });

  it('copies the full shareable URL, not just the bead id', async () => {
    render(
      <BeadDetail
        bead={BEAD}
        open={true}
        onOpenChange={vi.fn()}
        projectId="p1"
      />
    );

    const button = screen.getByRole('button', { name: 'Copy link to this bead' });
    await fireAndSettle(() => fireEvent.click(button));

    const expectedUrl = `${window.location.origin}/project?id=p1&bead=bweb-6pv`;
    expect(writeText).toHaveBeenCalledWith(expectedUrl);
  });

  it('does not render the affordance when there is no projectId (nothing to link to)', () => {
    render(
      <BeadDetail
        bead={BEAD}
        open={true}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Copy link to this bead' })).toBeNull();
  });
});
