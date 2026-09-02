/**
 * Resolving a bare bead id to its project.
 *
 * A shareable link normally carries the project uuid (`/project?id=…&bead=…`),
 * but the uuid cannot be derived from a repository name — it has to be looked
 * up in `GET /api/projects` every single time. Links written by hand (or by an
 * agent in a chat message) therefore keep coming out as `/project?bead=<id>`,
 * which used to render nothing. The bead id already identifies the project
 * through its prefix, so the missing uuid is recovered here instead: the
 * global cross-project search knows which database each bead lives in.
 *
 * Kept free of React/Next/DOM so the decision table can be unit tested.
 */

import type { SearchResult } from '@/lib/api';
import { buildProjectUrl } from '@/lib/bead-link';

/** What to do with a `?bead=` link that carries no project uuid. */
export type BeadResolution =
  /** Exactly one project owns the bead — go straight to the canonical URL. */
  | { kind: 'redirect'; href: string; match: SearchResult }
  /** Two projects answer to the same id — let the human pick, never guess. */
  | { kind: 'choice'; options: SearchResult[] }
  /** The bead exists, but its database is not registered as a local project. */
  | { kind: 'unregistered'; databases: string[] }
  /** No project has a bead with this id. */
  | { kind: 'not-found' };

/**
 * Hits whose bead id equals the requested one.
 *
 * The search endpoint matches substrings over ids and titles, so a query for
 * `bweb-vch` also returns `bweb-vch.1` and anything merely mentioning it in a
 * title. Only an exact id is a resolution.
 */
export function exactBeadMatches(results: SearchResult[], beadId: string): SearchResult[] {
  const wanted = beadId.trim().toLowerCase();
  if (!wanted) return [];
  return results.filter((result) => result.bead_id.toLowerCase() === wanted);
}

/**
 * Turns search hits into the decision for a uuid-less bead link.
 *
 * Duplicate registry entries pointing at the same database collapse into one
 * option: the search already annotates each hit with a single project, and two
 * identical destinations are not a choice.
 */
export function resolveBead(results: SearchResult[], beadId: string): BeadResolution {
  const matches = exactBeadMatches(results, beadId);
  if (matches.length === 0) {
    return { kind: 'not-found' };
  }

  const navigable = dedupeByProject(matches.filter((match) => match.project_id));
  if (navigable.length === 1) {
    const match = navigable[0];
    return {
      kind: 'redirect',
      href: buildProjectUrl(match.project_id as string, match.bead_id),
      match,
    };
  }
  if (navigable.length > 1) {
    return { kind: 'choice', options: navigable };
  }

  return {
    kind: 'unregistered',
    databases: Array.from(new Set(matches.map((match) => match.database))).sort(),
  };
}

/** Keeps the first hit per project id, preserving the ranked order. */
function dedupeByProject(matches: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const match of matches) {
    const id = match.project_id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(match);
  }
  return unique;
}
