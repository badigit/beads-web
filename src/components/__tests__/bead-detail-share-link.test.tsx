import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import type { Bead } from '@/types';

import { BeadDetail } from '../bead-detail';

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

describe('bead detail — compact header', () => {
  it('does not render a separate copy-link control', () => {
    render(
      <BeadDetail
        bead={BEAD}
        open={true}
        onOpenChange={vi.fn()}
        projectId="p1"
      />
    );

    expect(screen.queryByRole('button', { name: 'Copy link to this bead' })).toBeNull();
  });

  it('renders the ticket and bead ids before the title', () => {
    render(
      <BeadDetail
        bead={BEAD}
        open={true}
        onOpenChange={vi.fn()}
        projectId="p1"
      />
    );

    expect(screen.getByText('bweb-6pv')).toBeInTheDocument();
    expect(screen.getByText(BEAD.title)).toBeInTheDocument();
  });

  it('links a child task back to its parent epic', () => {
    const epic = { ...BEAD, id: 'bweb-epic', title: 'Parent epic', issue_type: 'epic' as const };
    const child = { ...BEAD, id: 'bweb-child', parent_id: epic.id };
    const onChildClick = vi.fn();

    render(
      <BeadDetail
        bead={child}
        open={true}
        onOpenChange={vi.fn()}
        allBeads={[epic, child]}
        onChildClick={onChildClick}
      />
    );

    const parentLink = screen.getByRole('button', { name: /epic: bweb-epic\s*parent epic/i });
    expect(parentLink).toBeInTheDocument();
    fireEvent.click(parentLink);
    expect(onChildClick).toHaveBeenCalledWith(epic);
  });
});
