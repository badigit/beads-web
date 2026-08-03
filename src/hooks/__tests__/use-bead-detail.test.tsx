import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useBeadDetail } from '@/hooks/use-bead-detail';
import type { Bead } from '@/types';

const EPIC: Bead = {
  id: 'bweb-epic', title: 'Parent epic', description: '', status: 'open', priority: 2,
  issue_type: 'epic', owner: 'badigit', created_at: '2026-08-03T00:00:00Z',
  updated_at: '2026-08-03T00:00:00Z', comments: [], children: ['bweb-child'],
};

const CHILD: Bead = {
  ...EPIC, id: 'bweb-child', title: 'Child task', issue_type: 'task', parent_id: EPIC.id,
};

describe('useBeadDetail — nested navigation', () => {
  it('returns from a nested task to its epic before closing the panel', () => {
    const { result } = renderHook(() => useBeadDetail([EPIC, CHILD]));

    act(() => result.current.openBead(EPIC));
    act(() => result.current.openNestedBead(CHILD));
    expect(result.current.detailBead).toEqual(CHILD);

    act(() => result.current.openNestedBead(EPIC));
    expect(result.current.detailBead).toEqual(EPIC);
    expect(result.current.isDetailOpen).toBe(true);

    act(() => result.current.openNestedBead(CHILD));

    act(() => result.current.handleDetailOpenChange(false));
    expect(result.current.isDetailOpen).toBe(true);
    expect(result.current.detailBead).toEqual(EPIC);

    act(() => result.current.handleDetailOpenChange(false));
    expect(result.current.isDetailOpen).toBe(false);
    expect(result.current.detailBead).toBeNull();
  });
});
