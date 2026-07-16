/**
 * Pure, React-free project ordering helper.
 *
 * Kept in `lib/` so it is trivially unit-testable and reusable by both the
 * card and list views on the home page.
 */

import { formatProjectName } from "./project-card-utils";

/** Available project sort modes. */
export type ProjectsSort = "alpha" | "activity";

/**
 * Return a new, ordered copy of `projects`.
 *
 * - `"alpha"`  — sort by the *displayed* project name (via
 *   {@link formatProjectName}) using a locale-aware, case-insensitive
 *   comparison so accents and casing group naturally.
 * - `"activity"` — preserve the incoming order from the database (which is
 *   already ordered by last activity), returning a shallow copy so callers
 *   never mutate the source array.
 *
 * The input array is never mutated in either mode.
 */
export function sortProjects<T extends { name: string }>(
  projects: T[],
  mode: ProjectsSort,
): T[] {
  if (mode === "activity") {
    return [...projects];
  }
  return [...projects].sort((a, b) =>
    formatProjectName(a.name).localeCompare(formatProjectName(b.name), undefined, {
      sensitivity: "base",
    }),
  );
}
