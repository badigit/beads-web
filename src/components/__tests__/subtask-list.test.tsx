import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SubtaskList } from '../subtask-list';

const CHILD = {
  id: 'bweb-12.3', title: 'Compact child title', description: 'Child description',
  status: 'open' as const, priority: 2, issue_type: 'task', owner: 'badigit',
  created_at: '2026-08-03T00:00:00Z', updated_at: '2026-08-03T00:00:00Z', comments: [],
};

describe('SubtaskList variants', () => {
  it('keeps dashboard rows to a compact title and status', () => {
    render(<SubtaskList childTasks={[CHILD]} onChildClick={vi.fn()} />);

    expect(screen.getByText(CHILD.title)).toBeInTheDocument();
    expect(screen.queryByText(CHILD.id)).toBeNull();
    expect(screen.queryByText(CHILD.description)).toBeNull();
    expect(screen.queryByText('open')).toBeNull();
  });

  it('shows the complete id and description in an epic detail card', () => {
    render(<SubtaskList childTasks={[CHILD]} onChildClick={vi.fn()} variant="detail" />);

    expect(screen.getByText(CHILD.id)).toBeInTheDocument();
    expect(screen.getByText(CHILD.description)).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
  });
});
