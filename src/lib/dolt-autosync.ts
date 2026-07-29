/**
 * Auto-discovery of Dolt databases that are not yet listed as projects.
 *
 * The project list is a local SQLite registry inside beads-web — a database
 * created on the central Dolt server (e.g. by `bd init`) never reaches it on
 * its own. These helpers close that gap: they diff `SHOW DATABASES` against the
 * registry and register whatever is missing.
 *
 * Databases the user deliberately removed must not come back on the next sync,
 * so deletions are remembered in an ignore list. It lives in localStorage for
 * now; it moves to the SQLite side together with the sync itself (bweb-1i0.2).
 */

import type { DoltDatabase } from "@/lib/api";

const IGNORED_KEY = "beads-web:ignored-databases";

/**
 * Databases that have no matching project and were not ignored by the user.
 *
 * Matching mirrors the Add Project dialog: a database counts as "already
 * listed" when its `project_name` equals a project name (case-insensitive).
 * That name is filled in server-side from the registry, so a listed database
 * always carries the project's own name.
 */
export function findUnlistedDatabases(
  databases: DoltDatabase[],
  projectNames: string[],
  ignored: string[]
): DoltDatabase[] {
  const existing = new Set(projectNames.map((name) => name.toLowerCase()));
  const skipped = new Set(ignored.map((name) => name.toLowerCase()));

  return databases.filter((db) => {
    const projectName = db.project_name.toLowerCase();
    const dbName = db.name.toLowerCase();
    return !existing.has(projectName) && !skipped.has(projectName) && !skipped.has(dbName);
  });
}

/** Names a removed project should be remembered under: its own and its database. */
export function ignoredNamesForProject(name: string, path: string): string[] {
  const database = path.startsWith("dolt://") ? path.slice("dolt://".length) : null;
  return database ? [name, database] : [name];
}

export function loadIgnoredDatabases(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IGNORED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Corrupted or unavailable storage must not break the project list.
    return [];
  }
}

export function addIgnoredDatabases(names: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const merged = Array.from(new Set(loadIgnoredDatabases().concat(names)));
    window.localStorage.setItem(IGNORED_KEY, JSON.stringify(merged));
  } catch {
    // Ignoring is a convenience; failing to persist it is not worth an error.
  }
}
