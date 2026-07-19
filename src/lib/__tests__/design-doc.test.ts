import { describe, it, expect } from 'vitest';

import {
  DESIGN_DOC_PREFIXES,
  isDesignDocDir,
  isDesignDocPath,
  joinDesignDocPath,
} from '@/lib/design-doc';

describe('isDesignDocPath', () => {
  it('returns true for a .designs/ path ending in .md', () => {
    expect(isDesignDocPath('.designs/bweb-489.md')).toBe(true);
  });

  it('returns false for a .designs/ path with a non-.md extension', () => {
    expect(isDesignDocPath('.designs/x.txt')).toBe(false);
  });

  it('returns false for free-text design content', () => {
    expect(isDesignDocPath('Подход: сначала узкие helpers, потом гварды')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isDesignDocPath(undefined)).toBe(false);
    expect(isDesignDocPath('')).toBe(false);
  });

  it('returns true for a path with leading whitespace', () => {
    expect(isDesignDocPath('   .designs/bweb-489.md')).toBe(true);
  });

  // --- multi-prefix support (bweb-489.9) ---

  it('accepts docs/designs/ as a prefix', () => {
    expect(isDesignDocPath('docs/designs/epic-support.md')).toBe(true);
  });

  it('accepts the superpowers non-beads spec location', () => {
    expect(isDesignDocPath('docs/superpowers/specs/2026-07-19-topic-design.md')).toBe(true);
  });

  it('rejects a .md file outside every allowed prefix', () => {
    expect(isDesignDocPath('src/lib/design-doc.md')).toBe(false);
    expect(isDesignDocPath('../.designs/escape.md')).toBe(false);
  });

  // --- directory support (superpowers writes .designs/bd-{id}/spec.md + plan.md) ---

  it('accepts a superpowers bead directory with trailing slash', () => {
    expect(isDesignDocPath('.designs/bd-bweb-489.9/')).toBe(true);
  });

  it('accepts a superpowers bead directory without trailing slash', () => {
    expect(isDesignDocPath('.designs/bd-bweb-489.9')).toBe(true);
  });

  it('still rejects free text that happens to contain a slash', () => {
    expect(isDesignDocPath('сначала helpers/гварды, потом UI')).toBe(false);
  });
});

describe('isDesignDocDir', () => {
  it('is true for a directory path under an allowed prefix', () => {
    expect(isDesignDocDir('.designs/bd-bweb-489.9/')).toBe(true);
    expect(isDesignDocDir('.designs/bd-bweb-489.9')).toBe(true);
  });

  it('is false for a concrete .md file', () => {
    expect(isDesignDocDir('.designs/bweb-489.md')).toBe(false);
    expect(isDesignDocDir('docs/designs/epic-support.md')).toBe(false);
  });

  it('is false for free text and empty values', () => {
    expect(isDesignDocDir('Подход: сначала helpers')).toBe(false);
    expect(isDesignDocDir(undefined)).toBe(false);
    expect(isDesignDocDir('')).toBe(false);
  });
});

describe('joinDesignDocPath', () => {
  it('joins a directory without a trailing slash', () => {
    expect(joinDesignDocPath('.designs/bd-bweb-489.9', 'spec.md')).toBe(
      '.designs/bd-bweb-489.9/spec.md'
    );
  });

  it('does not double the separator when one is already there', () => {
    expect(joinDesignDocPath('.designs/bd-bweb-489.9/', 'plan.md')).toBe(
      '.designs/bd-bweb-489.9/plan.md'
    );
  });

  it('produces a path the guard still accepts', () => {
    const joined = joinDesignDocPath('.designs/bd-bweb-489.9/', 'spec.md');
    expect(isDesignDocPath(joined)).toBe(true);
    expect(isDesignDocDir(joined)).toBe(false);
  });
});

describe('DESIGN_DOC_PREFIXES', () => {
  it('matches the allow-list hardcoded in the Rust backend (server/src/routes/fs.rs)', () => {
    // Keep in sync with DESIGN_DOC_PREFIXES in server/src/routes/fs.rs.
    // A mismatch means the UI renders a preview the backend then 403s on —
    // exactly the failure mode fixed in bweb-489.11.
    expect([...DESIGN_DOC_PREFIXES].sort()).toEqual(
      ['.designs/', 'docs/designs/', 'docs/superpowers/specs/'].sort()
    );
  });
});
