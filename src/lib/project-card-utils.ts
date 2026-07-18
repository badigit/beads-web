/**
 * Shared, pure helpers for rendering a project (card or row view).
 *
 * Kept free of React so they are trivially unit-testable and reusable by
 * both `ProjectCard` and `ProjectRow`.
 */

/**
 * Converts kebab-case, snake_case, camelCase to Title Case with spaces.
 */
export function formatProjectName(name: string): string {
  return name
    .replace(/[-_]/g, " ") // Replace hyphens and underscores with spaces
    .replace(/([a-z])([A-Z])/g, "$1 $2") // Add space before capitals in camelCase
    .replace(/\b\w/g, (c) => c.toUpperCase()) // Capitalize first letter of each word
    .trim(); // Leading separators (e.g. "_my-project") must not skew sorting
}

/**
 * Returns the OS-appropriate file manager name.
 */
export function getFileManagerName(): string {
  if (typeof navigator === "undefined") return "File Manager";
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.startsWith("win")) return "Explorer";
  if (platform.startsWith("mac")) return "Finder";
  return "Files";
}

/**
 * Resolve the filesystem path to use for external "open" operations.
 *
 * Dolt-only projects (`dolt://` prefix) have no filesystem path of their
 * own, so we fall back to their explicit `localPath` when present.
 */
export function getFsPath(path: string, localPath?: string): string | undefined {
  return path.startsWith("dolt://") ? localPath : path;
}
