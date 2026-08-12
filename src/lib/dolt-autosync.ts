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

/** Last segment of a path, the way Add Project derives a name from a folder. */
function folderName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * How a discovered database should be registered.
 *
 * When the server managed to locate the project folder, the database is
 * registered as an ordinary filesystem project: only those get Memory, Agents
 * and the bd CLI. Beads still come from the central Dolt server — the source is
 * resolved from the folder's own `.beads/metadata.json`. Without a folder the
 * previous read-only `dolt://` mode is all that is available.
 */
export function projectRegistrationFor(database: DoltDatabase): {
  name: string;
  path: string;
} {
  const localPath = database.local_path?.trim();
  if (!localPath) {
    return { name: database.project_name, path: `dolt://${database.name}` };
  }
  return { name: folderName(localPath) || database.project_name, path: localPath };
}

/**
 * The Dolt database a project reads from, as far as discovery can tell.
 *
 * For a `dolt://` project the database is spelled out in the path. A filesystem
 * project keeps that link inside its own `.beads/`, which the browser cannot
 * read — but the server already resolved it while listing databases, so the
 * answer is in that response: the entry whose folder or project name matches.
 */
export function databaseNameForProject(
  project: { name: string; path: string },
  databases: DoltDatabase[]
): string | null {
  if (project.path.startsWith("dolt://")) {
    return project.path.slice("dolt://".length) || null;
  }

  const samePath = (a: string, b: string) =>
    a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase();

  const byPath = databases.find(
    (database) => database.local_path && samePath(database.local_path, project.path)
  );
  if (byPath) return byPath.name;

  const byName = databases.find(
    (database) => database.project_name.toLowerCase() === project.name.toLowerCase()
  );
  return byName?.name ?? null;
}

/**
 * Names a removed project should be remembered under: its own and its database.
 *
 * Both are needed because the two sides of the comparison differ: the ignore
 * list is checked against the project name AND the raw database name, and which
 * one the next sync sees depends on whether the database still resolves to a
 * folder. Remembering only the folder name let a removed project come straight
 * back under the same name (bweb-1i0.4).
 */
export function ignoredNamesForProject(
  name: string,
  path: string,
  databaseName?: string | null
): string[] {
  const fromPath = path.startsWith("dolt://") ? path.slice("dolt://".length) : null;
  const database = databaseName ?? fromPath;
  return database && database !== name ? [name, database] : [name];
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
