import { useCallback, useState } from 'react';

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useBeadUrlSync } from '@/hooks/use-bead-url-sync';
import type { Bead } from '@/types';

const replace = vi.fn();
const toast = vi.fn();

/**
 * Params the mocked `useSearchParams` currently returns.
 *
 * Under Next.js static export (`output: 'export'`) this is EMPTY on the first
 * client render and only fills in on a later render — the hydration race this
 * hook has to survive.
 */
let currentParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => currentParams,
  useRouter: () => ({ replace }),
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

const PROJECT_ID = 'p1';

const BEAD: Bead = {
  id: 'bweb-1vr',
  title: 'Deep linked bead',
  description: '',
  status: 'open',
  priority: 2,
  issue_type: 'task',
  owner: 'badigit',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
  comments: [],
};

interface HookProps {
  beads: Bead[];
  beadsReady: boolean;
}

/**
 * Renders the hook against real detail-panel state, the way the board does:
 * `openBead` actually opens the panel, so the URL-sync effect sees the same
 * render in which the deep link resolved.
 */
function setup(initial: HookProps) {
  return renderHook(
    (props: HookProps) => {
      const [detailBead, setDetailBead] = useState<Bead | null>(null);
      const openBead = useCallback((bead: Bead) => setDetailBead(bead), []);
      useBeadUrlSync({
        projectId: PROJECT_ID,
        beads: props.beads,
        beadsReady: props.beadsReady,
        detailBead,
        openBead,
      });
      return { detailBead, openBead, closeDetail: () => setDetailBead(null) };
    },
    { initialProps: initial }
  );
}

/** The address bar the browser actually landed on. */
function visit(url: string) {
  window.history.replaceState({}, '', url);
}

beforeEach(() => {
  replace.mockReset();
  toast.mockReset();
  currentParams = new URLSearchParams();
  visit('/project');
});

describe('useBeadUrlSync — deep link arriving after the first render', () => {
  /** Deep-link visit where searchParams only populate on the second render. */
  function deepLinkVisit(beadId: string) {
    visit(`/project?id=${PROJECT_ID}&bead=${beadId}`);
    const view = setup({ beads: [], beadsReady: false });
    act(() => {
      currentParams = new URLSearchParams(`id=${PROJECT_ID}&bead=${beadId}`);
    });
    view.rerender({ beads: [BEAD], beadsReady: true });
    return view;
  }

  it('opens the bead when searchParams are empty on the first render and fill in later', () => {
    const { result } = deepLinkVisit(BEAD.id);

    expect(result.current.detailBead).toEqual(BEAD);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not strip ?bead= from the address bar once the deep link resolves', () => {
    deepLinkVisit(BEAD.id);

    // The bare project URL would drop the bead the user deep-linked to.
    expect(replace).not.toHaveBeenCalledWith(`/project?id=${PROJECT_ID}`, expect.anything());
    expect(replace).not.toHaveBeenCalled();
  });

  it('toasts and strips the param when the deep-linked bead is not in this project', () => {
    const { result } = deepLinkVisit('nope-404');

    expect(result.current.detailBead).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive', title: 'Bead not found' })
    );
    expect(replace).toHaveBeenCalledWith(`/project?id=${PROJECT_ID}`, { scroll: false });
  });
});

describe('useBeadUrlSync — bead list not ready yet', () => {
  /**
   * `useBeads("")` reports "not loading" with an empty list while the project
   * (and therefore its path) is still being fetched. That empty list must not
   * be read as "the deep-linked bead does not exist".
   */
  it('waits for the real bead list instead of toasting on the empty pre-project one', () => {
    visit(`/project?id=${PROJECT_ID}&bead=${BEAD.id}`);
    currentParams = new URLSearchParams(`id=${PROJECT_ID}&bead=${BEAD.id}`);
    const { result, rerender } = setup({ beads: [], beadsReady: false });

    expect(toast).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    rerender({ beads: [BEAD], beadsReady: true });

    expect(result.current.detailBead).toEqual(BEAD);
    expect(toast).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('useBeadUrlSync — outbound sync', () => {
  it('writes ?bead= into the URL when a card is opened on a plain board visit', () => {
    visit(`/project?id=${PROJECT_ID}`);
    currentParams = new URLSearchParams(`id=${PROJECT_ID}`);
    const { result } = setup({ beads: [BEAD], beadsReady: true });

    act(() => result.current.openBead(BEAD));

    expect(replace).toHaveBeenCalledWith(
      `/project?id=${PROJECT_ID}&bead=${BEAD.id}`,
      { scroll: false }
    );
  });

  it('drops ?bead= when the detail panel is closed again', () => {
    visit(`/project?id=${PROJECT_ID}`);
    currentParams = new URLSearchParams(`id=${PROJECT_ID}`);
    const { result } = setup({ beads: [BEAD], beadsReady: true });

    act(() => result.current.openBead(BEAD));
    replace.mockReset();
    // router.replace is mocked, so mirror its effect on the address bar.
    visit(`/project?id=${PROJECT_ID}&bead=${BEAD.id}`);
    act(() => result.current.closeDetail());

    expect(replace).toHaveBeenCalledWith(`/project?id=${PROJECT_ID}`, { scroll: false });
  });
});
