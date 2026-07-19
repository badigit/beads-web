import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useDoltWatcher } from '@/hooks/use-dolt-watcher';

/**
 * Minimal EventSource stand-in. jsdom has no implementation, and the behaviour
 * under test is precisely how the hook reacts to open/message/error — so the
 * fake exposes those as callable triggers.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitRevision(revision: string) {
    this.onmessage?.({
      data: JSON.stringify({ database: 'beads_web', revision }),
    });
  }

  emitRaw(data: string) {
    this.onmessage?.({ data });
  }

  emitError() {
    this.onerror?.();
  }

  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error('no EventSource was created');
    return last;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Advances past the hook's debounce window. */
function flushDebounce(ms = 200) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useDoltWatcher', () => {
  it('does not open a connection without a database', () => {
    renderHook(() => useDoltWatcher(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('subscribes to the given database', () => {
    renderHook(() => useDoltWatcher('beads_web', vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toContain('database=beads_web');
  });

  it('calls onChange when a revision event arrives', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of revisions into a single refresh', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => {
      const source = FakeEventSource.latest();
      source.emitRevision('rev1');
      source.emitRevision('rev2');
      source.emitRevision('rev3');
    });
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a repeated revision so the same state is not refetched', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();
    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('survives a malformed frame without tearing down the stream', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => FakeEventSource.latest().emitRaw('not json'));
    flushDebounce();
    expect(onChange).not.toHaveBeenCalled();

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports connection state across open and error', () => {
    const { result } = renderHook(() => useDoltWatcher('beads_web', vi.fn()));
    expect(result.current.isConnected).toBe(false);

    act(() => FakeEventSource.latest().emitOpen());
    expect(result.current.isConnected).toBe(true);

    act(() => FakeEventSource.latest().emitError());
    expect(result.current.isConnected).toBe(false);
  });

  it('leaves the stream open on error so EventSource can reconnect itself', () => {
    renderHook(() => useDoltWatcher('beads_web', vi.fn()));

    act(() => FakeEventSource.latest().emitError());

    expect(FakeEventSource.latest().closed).toBe(false);
  });

  it('still delivers changes after a reconnect', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => {
      FakeEventSource.latest().emitError();
      FakeEventSource.latest().emitOpen();
      FakeEventSource.latest().emitRevision('rev-after-reconnect');
    });
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('closes the connection on unmount', () => {
    const { unmount } = renderHook(() => useDoltWatcher('beads_web', vi.fn()));
    const source = FakeEventSource.latest();

    unmount();

    expect(source.closed).toBe(true);
  });

  it('reconnects to the new database when it changes', () => {
    const { rerender } = renderHook(
      ({ db }: { db: string }) => useDoltWatcher(db, vi.fn()),
      { initialProps: { db: 'beads_web' } }
    );
    const first = FakeEventSource.latest();

    rerender({ db: 'config_parser' });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.latest().url).toContain('database=config_parser');
  });

  it('does not fire a stale callback after unmount', () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useDoltWatcher('beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    unmount();
    flushDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });
});
