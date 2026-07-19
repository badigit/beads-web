import { describe, it, expect } from 'vitest';

import {
  buildBeadShareUrl,
  buildProjectUrl,
  parseBeadIdParam,
} from '../bead-link';

describe('buildProjectUrl', () => {
  it('builds a bare project link when no bead is given', () => {
    expect(buildProjectUrl('p1', null)).toBe('/project?id=p1');
  });

  it('appends the bead id when given', () => {
    expect(buildProjectUrl('p1', 'bweb-6pv')).toBe('/project?id=p1&bead=bweb-6pv');
  });

  it('encodes ids that need escaping', () => {
    expect(buildProjectUrl('a b&c', 'x y')).toBe('/project?id=a%20b%26c&bead=x%20y');
  });
});

describe('buildBeadShareUrl', () => {
  it('prefixes the project url with the given origin', () => {
    expect(buildBeadShareUrl('http://localhost:3056', 'p1', 'bweb-6pv')).toBe(
      'http://localhost:3056/project?id=p1&bead=bweb-6pv'
    );
  });
});

describe('parseBeadIdParam', () => {
  it('reads the bead id from search params', () => {
    const params = new URLSearchParams('id=p1&bead=bweb-6pv');
    expect(parseBeadIdParam(params)).toBe('bweb-6pv');
  });

  it('returns null when absent', () => {
    const params = new URLSearchParams('id=p1');
    expect(parseBeadIdParam(params)).toBeNull();
  });

  it('returns null for a blank value', () => {
    const params = new URLSearchParams('id=p1&bead=   ');
    expect(parseBeadIdParam(params)).toBeNull();
  });

  it('returns null for an empty value', () => {
    const params = new URLSearchParams('id=p1&bead=');
    expect(parseBeadIdParam(params)).toBeNull();
  });
});
