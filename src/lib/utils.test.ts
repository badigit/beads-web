import { describe, expect, it } from 'vitest';

import { deriveBeadPrefix, doltDatabase, isDoltProject } from './utils';

describe('isDoltProject', () => {
  it('returns true for dolt:// paths', () => {
    expect(isDoltProject('dolt://foo')).toBe(true);
  });

  it('returns false for regular paths', () => {
    expect(isDoltProject('M:/repos/foo')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isDoltProject(null)).toBe(false);
    expect(isDoltProject(undefined)).toBe(false);
  });
});

describe('doltDatabase', () => {
  it('extracts the database name from a dolt:// path', () => {
    expect(doltDatabase('dolt://beads_web')).toBe('beads_web');
  });

  it('keeps hyphenated database names intact', () => {
    expect(doltDatabase('dolt://beads_ai-photo-factory')).toBe(
      'beads_ai-photo-factory'
    );
  });

  it('drops a trailing slash', () => {
    expect(doltDatabase('dolt://beads_web/')).toBe('beads_web');
  });

  it('returns null for filesystem projects', () => {
    expect(doltDatabase('M:/repos/foo')).toBeNull();
  });

  it('returns null for empty, null and prefix-only values', () => {
    expect(doltDatabase('')).toBeNull();
    expect(doltDatabase(null)).toBeNull();
    expect(doltDatabase(undefined)).toBeNull();
    expect(doltDatabase('dolt://')).toBeNull();
  });
});

describe('deriveBeadPrefix', () => {
  it('derives slug from Windows-style path basename', () => {
    expect(deriveBeadPrefix('M:/repos/foo-bar', 'ignored')).toBe('foo-bar');
  });

  it('derives slug from POSIX path basename and lowercases it', () => {
    expect(deriveBeadPrefix('/home/user/MyProject', 'ignored')).toBe('myproject');
  });

  it('handles backslash-only paths (Windows native)', () => {
    expect(deriveBeadPrefix('M:\\repos\\Foo_Bar', 'ignored')).toBe('foo-bar');
  });

  it('replaces non-alphanumeric with dashes and trims them', () => {
    expect(deriveBeadPrefix('/tmp/--weird!!name--', 'ignored')).toBe('weird-name');
  });

  it('falls back to name when path is dolt://', () => {
    expect(deriveBeadPrefix('dolt://whatever', 'My Project')).toBe('my-project');
  });

  it('falls back to name when path is empty', () => {
    expect(deriveBeadPrefix('', 'FallbackName')).toBe('fallbackname');
  });

  it('returns empty string when nothing usable is provided', () => {
    expect(deriveBeadPrefix('', '')).toBe('');
  });

  it('collapses multiple separators into a single dash', () => {
    expect(deriveBeadPrefix('/path/to/foo   bar___baz', 'x')).toBe('foo-bar-baz');
  });
});
