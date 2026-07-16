import { describe, it, expect } from 'vitest';

import { isDesignDocPath } from '@/lib/design-doc';

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
});
