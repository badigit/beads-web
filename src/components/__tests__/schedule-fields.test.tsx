import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Bead } from '@/types';

import { ScheduleFields, formatMinutes } from '../schedule-fields';

const update = vi.fn();
vi.mock('@/lib/api', () => ({
  beads: { update: (data: unknown) => update(data) },
}));

function bead(extra: Partial<Bead> = {}): Bead {
  return {
    id: 'bweb-1',
    title: 'T',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: 'badigit',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    comments: [],
    ...extra,
  } as Bead;
}

describe('ScheduleFields', () => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({ success: true });
  });

  it('заполненные поля показываются, пустые — только кнопками добавления', () => {
    render(<ScheduleFields bead={bead({ estimated_minutes: 90 })} projectPath="C:/repo" />);

    expect(screen.getByText('1 ч 30 мин')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ срок' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ отложено до' })).toBeInTheDocument();
  });

  it('в проекте только на чтение пустые поля не занимают места', () => {
    const { container } = render(
      <ScheduleFields bead={bead()} projectPath="dolt://beads_web" readOnly />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('нулевая оценка — это «оценки нет», а не «0 мин»', () => {
    // `bd update --estimate 0` пишет ноль, а не NULL (проверено на bd 1.1.0).
    render(<ScheduleFields bead={bead({ estimated_minutes: 0 })} projectPath="C:/repo" />);

    expect(screen.queryByText(/0 мин/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ оценка' })).toBeInTheDocument();
  });

  it('введённое значение уходит в bd как есть', async () => {
    render(<ScheduleFields bead={bead()} projectPath="C:/repo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ срок' }));
    fireEvent.change(screen.getByLabelText(/tomorrow/), { target: { value: '+1d' } });
    fireEvent.keyDown(screen.getByLabelText(/tomorrow/), { key: 'Enter' });

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ path: 'C:/repo', id: 'bweb-1', due: '+1d' })
    );
  });

  it('пустая строка снимает срок', async () => {
    render(
      <ScheduleFields bead={bead({ due_at: '2026-09-20T00:00:00Z' })} projectPath="C:/repo" />
    );

    fireEvent.click(screen.getByRole('button', { name: /2026|Sep|сен/i }));
    const input = screen.getByLabelText(/tomorrow/);
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ path: 'C:/repo', id: 'bweb-1', due: '' })
    );
  });

  it('отсрочка снимается тем же путём, а не только фильтруется', async () => {
    render(
      <ScheduleFields bead={bead({ defer_until: '2026-09-20T00:00:00Z' })} projectPath="C:/repo" />
    );

    fireEvent.click(screen.getByRole('button', { name: /2026|Sep|сен/i }));
    fireEvent.keyDown(screen.getByLabelText(/next monday/), { key: 'Enter' });

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ path: 'C:/repo', id: 'bweb-1', defer: '' })
    );
  });

  it('оценка уходит числом, пустое поле — нулём', async () => {
    render(<ScheduleFields bead={bead()} projectPath="C:/repo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ оценка' }));
    fireEvent.keyDown(screen.getByLabelText(/минуты/), { key: 'Enter' });

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ path: 'C:/repo', id: 'bweb-1', estimate: 0 })
    );
  });

  it('нечисловая оценка не уходит в bd и не стирает прежнюю', async () => {
    render(<ScheduleFields bead={bead({ estimated_minutes: 90 })} projectPath="C:/repo" />);

    fireEvent.click(screen.getByRole('button', { name: '1 ч 30 мин' }));
    fireEvent.change(screen.getByLabelText(/минуты/), { target: { value: '90m' } });
    fireEvent.keyDown(screen.getByLabelText(/минуты/), { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/целое число/);
    expect(update).not.toHaveBeenCalled();
  });

  it('уход фокусом с пустого поля отменяет правку, а не стирает дату', async () => {
    render(
      <ScheduleFields bead={bead({ due_at: '2026-09-20T00:00:00Z' })} projectPath="C:/repo" />
    );

    fireEvent.click(screen.getByRole('button', { name: /2026|Sep|сен/i }));
    fireEvent.blur(screen.getByLabelText(/tomorrow/));

    // Один клик мимо не должен снимать уже проставленный срок.
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /2026|Sep|сен/i })).toBeInTheDocument();
  });

  it('ошибка сохранения видна рядом с полем', async () => {
    update.mockRejectedValue(new Error('bd not found'));
    render(<ScheduleFields bead={bead()} projectPath="C:/repo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ оценка' }));
    fireEvent.change(screen.getByLabelText(/минуты/), { target: { value: '30' } });
    fireEvent.keyDown(screen.getByLabelText(/минуты/), { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent('bd not found');
  });
});

describe('formatMinutes', () => {
  it('переводит минуты в часы там, где это читается лучше', () => {
    expect(formatMinutes(45)).toBe('45 мин');
    expect(formatMinutes(60)).toBe('1 ч');
    expect(formatMinutes(150)).toBe('2 ч 30 мин');
  });
});
