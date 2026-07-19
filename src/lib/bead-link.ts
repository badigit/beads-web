/**
 * Pure helpers for the shareable bead detail link.
 *
 * The project board already has a URL (`/project?id=<project>`); this layers
 * a `bead=<id>` param on top so a single bead's detail card has its own
 * address (`/project?id=<project>&bead=<bead>`) that can be copied, pasted
 * in a new tab, or linked from a comment/chat message.
 *
 * Kept free of React/Next/DOM so it can be unit tested without rendering.
 */

/**
 * Minimal shape of a search-params-like object needed to read `?bead=`.
 * Both `URLSearchParams` and Next's `ReadonlyURLSearchParams` satisfy this.
 */
export interface BeadIdParamSource {
  get(name: string): string | null;
}

/**
 * Builds the project route, optionally pointing at a specific bead's detail.
 *
 * `beadId === null` produces the bare project URL — used when the detail
 * panel is closed, so the bead param is dropped from the address bar.
 */
export function buildProjectUrl(projectId: string, beadId: string | null): string {
  let url = `/project?id=${encodeURIComponent(projectId)}`;
  if (beadId) {
    url += `&bead=${encodeURIComponent(beadId)}`;
  }
  return url;
}

/**
 * Builds an absolute, shareable link to a bead's detail card.
 *
 * `origin` is passed in (rather than read from `window.location`) so this
 * stays a pure function callers can unit test without a DOM.
 */
export function buildBeadShareUrl(origin: string, projectId: string, beadId: string): string {
  return `${origin}${buildProjectUrl(projectId, beadId)}`;
}

/**
 * Reads the `?bead=` param, treating a missing or blank value as "none".
 */
export function parseBeadIdParam(searchParams: BeadIdParamSource): string | null {
  const value = searchParams.get('bead');
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
