import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Bead, Epic } from '@/types';

import { EpicCard } from '../epic-card';

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

const epic: Epic = {
  id: 'bweb-en5',
  title: 'Spawn sessions from a bead',
  status: 'open',
  priority: 2,
  issue_type: 'epic',
  children: [child.id],
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
} as Epic;

const defaultProps = {
  epic,
  allBeads: [epic as Bead, child],
  onSelect: vi.fn(),
  onChildClick: vi.fn(),
  projectPath: 'C:/Users/Dee/GitHub/beads-web',
};

beforeEach(() => {
  vi.clearAllMocks();
  layoutMock.mockReturnValue('standard');
});

describe('EpicCard — Claude session button', () => {
  it.each(['standard', 'compact-row', 'property-tags'])(
    'renders the session button in the %s layout',
    (layout) => {
      layoutMock.mockReturnValue(layout);
      render(<EpicCard {...defaultProps} />);
      expect(
        screen.getByRole('button', { name: /start claude session for bweb-en5/i })
      ).toBeEnabled();
    }
  );

  it('hides the session button for dolt-only projects', () => {
    render(<EpicCard {...defaultProps} projectPath="dolt://beads-web" />);
    expect(
      screen.queryByRole('button', { name: /start claude session/i })
    ).not.toBeInTheDocument();
  });
});
