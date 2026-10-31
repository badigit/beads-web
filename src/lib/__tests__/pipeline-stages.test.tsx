import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineStrip } from '@/components/pipeline-strip';
import * as api from '@/lib/api';
import { isBlocked, isDone, isWorkInProgress } from '@/lib/bead-utils';
import { groupBeadsByStatus, loadProjectBeads } from '@/lib/beads-parser';
import { computeEpicProgress } from '@/lib/epic-parser';
import { buildPipelineStages } from '@/lib/pipeline-stages';
import type { Bead } from '@/types';

const bead = (id: string, status: string, issue_type = 'task'): Bead => ({
  id, status, issue_type, title: id, priority: 2, owner: '',
  created_at: '', updated_at: '', comments: [],
});

describe('bd-owned pipeline stages', () => {
  it('retains configured empty stages and counts all issue types without folding custom statuses into open', () => {
    const stages = buildPipelineStages([
      bead('1', 'qa', 'bug'), bead('2', 'qa'), bead('3', 'open', 'epic'),
    ], [{ name: 'qa', category: 'wip' }, { name: 'queued', category: 'active' }]);
    expect(stages.find(stage => stage.status === 'qa')).toMatchObject({
      title: 'qa', category: 'wip', count: 2, types: [['bug', 1], ['task', 1]],
    });
    expect(stages.find(stage => stage.status === 'open')?.count).toBe(1);
    expect(stages.find(stage => stage.status === 'queued')?.count).toBe(0);
  });

  it('keeps an unregistered stage visible without guessing its category', () => {
    expect(buildPipelineStages([bead('1', 'awaiting_customer')], [])).toContainEqual({
      status: 'awaiting_customer', title: 'awaiting_customer', category: 'unspecified', count: 1, types: [['task', 1]],
    });
  });

  it('passes the exact stage name on click and exposes filter selection to accessibility tools', () => {
    const select = vi.fn();
    const stages = buildPipelineStages([bead('1', 'qa')], [{ name: 'qa', category: 'wip' }]);
    render(<PipelineStrip stages={stages} selected={['qa']} onSelect={select} />);
    const button = screen.getByRole('button', { name: 'qa, 1 issue' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(select).toHaveBeenCalledWith('qa');
  });

  it('carries API categories alongside raw custom names while preserving legacy aliases', async () => {
    const response = vi.spyOn(api.beads, 'read').mockResolvedValueOnce({
      beads: [bead('1', 'qa'), bead('2', 'done'), bead('3', 'tombstone')],
      custom_statuses: [{ name: 'qa', category: 'wip' }],
    });
    try {
      const result = await loadProjectBeads('dolt://test', { withSource: true });
      expect(result.beads.map(item => item.status)).toEqual(['qa', 'closed']);
      expect(result.customStatuses).toEqual([{ name: 'qa', category: 'wip' }]);
      const grouped = groupBeadsByStatus(result.beads);
      expect(grouped.qa.map(item => item.id)).toEqual(['1']);
      expect(grouped.open).toEqual([]);
    } finally {
      response.mockRestore();
    }
  });

  it('handles status names that match object properties', () => {
    const grouped = groupBeadsByStatus([bead('1', 'constructor'), bead('2', '__proto__')]);
    expect(grouped.constructor).toHaveLength(1);
    expect(grouped.__proto__).toHaveLength(1);
  });

  it('uses bd categories for completion, WIP and blocking without rewriting stage names', async () => {
    const response = vi.spyOn(api.beads, 'read').mockResolvedValueOnce({
      beads: [bead('shipped', 'shipped'), bead('testing', 'qa'), bead('queued', 'queued'), bead('paused', 'on_hold')],
      custom_statuses: [
        { name: 'shipped', category: 'done' }, { name: 'qa', category: 'wip' },
        { name: 'queued', category: 'active' }, { name: 'on_hold', category: 'frozen' },
      ],
    });
    try {
      const { beads: loaded } = await loadProjectBeads('dolt://test', { withSource: true });
      expect(loaded.map(item => item.status)).toEqual(['shipped', 'qa', 'queued', 'on_hold']);
      expect(loaded.map(isDone)).toEqual([true, false, false, false]);
      expect(loaded.map(isWorkInProgress)).toEqual([false, true, false, false]);
      expect(isBlocked({ status: 'open', deps: ['shipped'] }, loaded)).toBe(false);
      expect(isBlocked({ status: 'open', deps: ['queued'] }, loaded)).toBe(true);
      const epic = { ...bead('epic', 'open', 'epic'), issue_type: 'epic' as const, children: loaded.map(item => item.id) };
      expect(computeEpicProgress(epic, loaded)).toMatchObject({ completed: 1, inProgress: 1, total: 4 });
    } finally {
      response.mockRestore();
    }
  });
});
