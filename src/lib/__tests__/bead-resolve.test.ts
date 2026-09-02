import { describe, it, expect } from 'vitest';

import type { SearchResult } from '@/lib/api';
import { exactBeadMatches, resolveBead } from '@/lib/bead-resolve';

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    project_id: 'p1',
    project_name: 'beads-web',
    database: 'beads_web',
    bead_id: 'bweb-vch',
    title: 'Short bead links',
    status: 'open',
    ...overrides,
  };
}

describe('exactBeadMatches', () => {
  it('keeps only exact id matches', () => {
    const results = [
      hit({ bead_id: 'bweb-vch.1' }),
      hit(),
      hit({ bead_id: 'bweb-1', title: 'mentions bweb-vch' }),
    ];
    expect(exactBeadMatches(results, 'bweb-vch').map((r) => r.bead_id)).toEqual(['bweb-vch']);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(exactBeadMatches([hit({ bead_id: 'BWEB-VCH' })], ' bweb-vch ')).toHaveLength(1);
  });

  it('returns nothing for a blank id', () => {
    expect(exactBeadMatches([hit()], '   ')).toEqual([]);
  });
});

describe('resolveBead', () => {
  it('redirects to the canonical URL for a single owner', () => {
    const resolution = resolveBead([hit()], 'bweb-vch');
    expect(resolution).toEqual({
      kind: 'redirect',
      href: '/project?id=p1&bead=bweb-vch',
      match: hit(),
    });
  });

  it('encodes ids in the redirect URL', () => {
    const resolution = resolveBead([hit({ project_id: 'p 1', bead_id: 'a b' })], 'a b');
    expect(resolution).toMatchObject({ href: '/project?id=p%201&bead=a%20b' });
  });

  it('offers a choice when two projects answer to the same id', () => {
    const results = [hit(), hit({ project_id: 'p2', project_name: 'fork', database: 'fork_db' })];
    const resolution = resolveBead(results, 'bweb-vch');
    expect(resolution.kind).toBe('choice');
    expect(resolution.kind === 'choice' && resolution.options.map((o) => o.project_id)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('collapses duplicate registry entries for one project', () => {
    const resolution = resolveBead([hit(), hit()], 'bweb-vch');
    expect(resolution.kind).toBe('redirect');
  });

  it('reports the database when the bead exists but the project is not registered', () => {
    const resolution = resolveBead([hit({ project_id: null, database: 'beads_orphan' })], 'bweb-vch');
    expect(resolution).toEqual({ kind: 'unregistered', databases: ['beads_orphan'] });
  });

  it('prefers a registered project over an unregistered duplicate', () => {
    const results = [hit({ project_id: null, database: 'beads_orphan' }), hit()];
    expect(resolveBead(results, 'bweb-vch')).toMatchObject({ kind: 'redirect' });
  });

  it('reports not-found for an unknown prefix', () => {
    expect(resolveBead([hit({ bead_id: 'other-1' })], 'nope-1')).toEqual({ kind: 'not-found' });
    expect(resolveBead([], 'nope-1')).toEqual({ kind: 'not-found' });
  });
});
