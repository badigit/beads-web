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
  it('does not open a connection without a project', () => {
    renderHook(() => useDoltWatcher(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('does not open a connection for an empty path', () => {
    renderHook(() => useDoltWatcher('', vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('subscribes by project path, leaving the database to the server', () => {
    renderHook(() => useDoltWatcher('dolt://beads_web', vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toContain(
      `project_path=${encodeURIComponent('dolt://beads_web')}`
    );
  });

  it('subscribes for a filesystem project too', () => {
    // The bug this covers (bweb-wh2): every real project is registered by
    // filesystem path while its beads live in central Dolt, and gating the
    // subscription on a `dolt://` path meant no project ever subscribed.
    renderHook(() => useDoltWatcher('C:/Users/Dee/GitHub/config_parser', vi.fn()));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toContain(
      `project_path=${encodeURIComponent('C:/Users/Dee/GitHub/config_parser')}`
    );
  });

  it('calls onChange when a revision event arrives', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of revisions into a single refresh', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

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
    renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();
    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('survives a malformed frame without tearing down the stream', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

    act(() => FakeEventSource.latest().emitRaw('not json'));
    flushDebounce();
    expect(onChange).not.toHaveBeenCalled();

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    flushDebounce();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports connection state across open and error', () => {
    const { result } = renderHook(() => useDoltWatcher('dolt://beads_web', vi.fn()));
    expect(result.current.isConnected).toBe(false);

    act(() => FakeEventSource.latest().emitOpen());
    expect(result.current.isConnected).toBe(true);

    act(() => FakeEventSource.latest().emitError());
    expect(result.current.isConnected).toBe(false);
  });

  it('leaves the stream open on error so EventSource can reconnect itself', () => {
    renderHook(() => useDoltWatcher('dolt://beads_web', vi.fn()));

    act(() => FakeEventSource.latest().emitError());

    expect(FakeEventSource.latest().closed).toBe(false);
  });

  it('still delivers changes after a reconnect', () => {
    const onChange = vi.fn();
    renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

    act(() => {
      FakeEventSource.latest().emitError();
      FakeEventSource.latest().emitOpen();
      FakeEventSource.latest().emitRevision('rev-after-reconnect');
    });
    flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('closes the connection on unmount', () => {
    const { unmount } = renderHook(() => useDoltWatcher('dolt://beads_web', vi.fn()));
    const source = FakeEventSource.latest();

    unmount();

    expect(source.closed).toBe(true);
  });

  it('reconnects to the new project when it changes', () => {
    const { rerender } = renderHook(
      ({ path }: { path: string }) => useDoltWatcher(path, vi.fn()),
      { initialProps: { path: 'dolt://beads_web' } }
    );
    const first = FakeEventSource.latest();

    rerender({ path: 'C:/repos/config_parser' });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.latest().url).toContain(
      `project_path=${encodeURIComponent('C:/repos/config_parser')}`
    );
  });

  it('does not fire a stale callback after unmount', () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useDoltWatcher('dolt://beads_web', onChange));

    act(() => FakeEventSource.latest().emitRevision('rev1'));
    unmount();
    flushDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });
});
