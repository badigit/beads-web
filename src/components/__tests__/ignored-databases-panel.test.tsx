import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { IgnoredDatabasesPanel } from '../ignored-databases-panel';

const ignored = vi.fn();
const unignore = vi.fn();
vi.mock('@/lib/api', () => ({
  dolt: {
    ignored: () => ignored(),
    unignore: (name: string) => unignore(name),
  },
}));

describe('IgnoredDatabasesPanel', () => {
  beforeEach(() => {
    ignored.mockReset();
    unignore.mockReset();
  });

  it('показывает скрытые базы с датой', async () => {
    ignored.mockResolvedValue({
      ignored: [{ dbName: 'zzzprobe', ignoredAt: '2026-08-15T10:00:00Z' }],
    });

    render(<IgnoredDatabasesPanel />);

    expect(await screen.findByText('zzzprobe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /вернуть/i })).toBeInTheDocument();
  });

  it('пустой список говорит, что скрытых баз нет', async () => {
    ignored.mockResolvedValue({ ignored: [] });

    render(<IgnoredDatabasesPanel />);

    expect(await screen.findByText(/скрытых баз нет/i)).toBeInTheDocument();
  });

  it('возврат снимает игнор и перечитывает список с сервера', async () => {
    ignored
      .mockResolvedValueOnce({ ignored: [{ dbName: 'sbc', ignoredAt: '2026-08-15T10:00:00Z' }] })
      .mockResolvedValueOnce({ ignored: [] });
    unignore.mockResolvedValue(undefined);

    render(<IgnoredDatabasesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /вернуть/i }));

    expect(unignore).toHaveBeenCalledWith('sbc');
    // Снятие идёт по имени без учёта регистра — какая строка исчезла, знает
    // сервер, поэтому список перечитывается, а не правится локально.
    await waitFor(() => expect(ignored).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/скрытых баз нет/i)).toBeInTheDocument();
  });

  it('ошибка загрузки показывается, а не молчит', async () => {
    ignored.mockRejectedValue(new Error('Dolt server not running'));

    render(<IgnoredDatabasesPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Dolt server not running');
    // Список в этом случае неизвестен, и утверждать «скрытых баз нет» нельзя:
    // пользователь принял бы отказ сервера за факт.
    expect(screen.queryByText(/скрытых баз нет/i)).not.toBeInTheDocument();
  });

  it('провал возврата не оставляет кнопку заблокированной', async () => {
    ignored.mockResolvedValue({ ignored: [{ dbName: 'sbc', ignoredAt: 'не дата' }] });
    unignore.mockRejectedValue(new Error('disk is full'));

    render(<IgnoredDatabasesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /вернуть/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk is full');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /вернуть/i })).not.toBeDisabled()
    );
    // Неразобранная дата показывается как есть — это полезнее пустого места.
    expect(screen.getByText(/не дата/)).toBeInTheDocument();
  });
});
