import type { Project } from '@/types';

/** How many entries the recent-projects bar shows at most. */
export const RECENT_PROJECTS_LIMIT = 10;

export interface RecentProject {
  id: string;
  name: string;
  isCurrent: boolean;
}

/**
 * Pick the entries for the recent-projects bar.
 *
 * `GET /api/projects` already sorts by `last_opened DESC`, so the incoming
 * order is authoritative — with one exception: the project the user is looking
 * at right now. Its `last_opened` is bumped by `POST /api/projects/:id/touch`
 * asynchronously, so a list fetched before (or during) that round-trip still
 * ranks it where it used to be. Hoisting it locally is what makes the order
 * correct without a page reload, and it keeps the bar stable while navigating.
 */
export function selectRecentProjects(
  projects: Project[],
  currentId: string | null,
  limit: number = RECENT_PROJECTS_LIMIT
): RecentProject[] {
  const ordered = currentId
    ? [
        ...projects.filter((p) => p.id === currentId),
        ...projects.filter((p) => p.id !== currentId),
      ]
    : projects;

  return ordered.slice(0, Math.max(0, limit)).map((p) => ({
    id: p.id,
    name: p.name,
    isCurrent: p.id === currentId,
  }));
}
