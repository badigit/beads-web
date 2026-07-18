import { describe, it, expect } from 'vitest';

import {
  isSearchResultNavigable,
  nextResultIndex,
  searchResultHref,
  shouldOpenSearchPalette,
} from '../search-nav';

import type { SearchResult } from '../api';

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    project_id: 'a1b2c3d4',
    project_name: 'beads-web',
    database: 'beads_web',
    bead_id: 'bweb-489.12.2',
    title: 'Command palette',
    status: 'open',
    ...overrides,
  };
}

describe('nextResultIndex', () => {
  it('returns -1 when there are no results', () => {
    expect(nextResultIndex(-1, 0, 1)).toBe(-1);
    expect(nextResultIndex(3, 0, -1)).toBe(-1);
  });

  it('selects the first entry when moving down from no selection', () => {
    expect(nextResultIndex(-1, 5, 1)).toBe(0);
  });

  it('selects the last entry when moving up from no selection', () => {
    expect(nextResultIndex(-1, 5, -1)).toBe(4);
  });

  it('moves forward and backward within bounds', () => {
    expect(nextResultIndex(0, 5, 1)).toBe(1);
    expect(nextResultIndex(3, 5, -1)).toBe(2);
  });

  it('wraps around at both ends', () => {
    expect(nextResultIndex(4, 5, 1)).toBe(0);
    expect(nextResultIndex(0, 5, -1)).toBe(4);
  });

  it('clamps an out-of-range index back into the list', () => {
    expect(nextResultIndex(99, 3, 1)).toBe(0);
    expect(nextResultIndex(99, 3, -1)).toBe(2);
  });
});

describe('searchResultHref', () => {
  it('builds a project link from project_id', () => {
    expect(searchResultHref(result())).toBe('/project?id=a1b2c3d4');
  });

  it('encodes ids that need escaping', () => {
    expect(searchResultHref(result({ project_id: 'a b&c' }))).toBe('/project?id=a%20b%26c');
  });

  it('returns null when the project is not registered locally', () => {
    expect(searchResultHref(result({ project_id: null }))).toBeNull();
  });

  it('returns null for an empty project_id', () => {
    expect(searchResultHref(result({ project_id: '' }))).toBeNull();
  });
});

describe('isSearchResultNavigable', () => {
  it('is true only when a link can be built', () => {
    expect(isSearchResultNavigable(result())).toBe(true);
    expect(isSearchResultNavigable(result({ project_id: null }))).toBe(false);
  });
});

describe('shouldOpenSearchPalette', () => {
  const base = { key: 'k', ctrlKey: true, metaKey: false, altKey: false };

  it('opens on Ctrl+K', () => {
    expect(shouldOpenSearchPalette(base, false, false)).toBe(true);
  });

  it('opens on Cmd+K', () => {
    expect(
      shouldOpenSearchPalette({ ...base, ctrlKey: false, metaKey: true }, false, false)
    ).toBe(true);
  });

  it('accepts an uppercase K (caps lock / shift)', () => {
    expect(shouldOpenSearchPalette({ ...base, key: 'K' }, false, false)).toBe(true);
  });

  it('ignores K without a modifier', () => {
    expect(shouldOpenSearchPalette({ ...base, ctrlKey: false }, false, false)).toBe(false);
  });

  it('ignores other keys', () => {
    expect(shouldOpenSearchPalette({ ...base, key: 'j' }, false, false)).toBe(false);
  });

  it('ignores Ctrl+Alt+K so it does not steal AltGr combinations', () => {
    expect(shouldOpenSearchPalette({ ...base, altKey: true }, false, false)).toBe(false);
  });

  it('does nothing when the palette is already open', () => {
    expect(shouldOpenSearchPalette(base, true, false)).toBe(false);
  });

  it('leaves native Ctrl+K alone when focus is in another editable field', () => {
    expect(shouldOpenSearchPalette(base, false, true)).toBe(false);
  });
});
