import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import type { Bead } from '@/types';

import { BeadDetail } from '../bead-detail';

const BEAD: Bead = {
  id: 'bweb-afx',
  title: 'Панель деталей',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  owner: 'badigit',
  created_at: '2026-08-29T00:00:00Z',
  updated_at: '2026-08-29T00:00:00Z',
  comments: [],
};

describe('bead detail — панель как диалог', () => {
  it('открытая панель находится по role=dialog и помечена модальной', () => {
    // Браузерная проба искала панель ровно так и не находила: панель была
    // рукописным div (bweb-afx).
    render(<BeadDetail bead={BEAD} open onOpenChange={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Панель деталей');
  });

  it('закрытая панель не висит в дереве', () => {
    render(<BeadDetail bead={BEAD} open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape закрывает панель', async () => {
    const onOpenChange = vi.fn();
    render(<BeadDetail bead={BEAD} open onOpenChange={onOpenChange} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('у диалога есть доступное имя — заголовок бида', () => {
    render(<BeadDetail bead={BEAD} open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Панель деталей');
  });
});
