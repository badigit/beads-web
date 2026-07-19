/**
 * Design Doc Utilities
 * Shared functions for fetching and processing design documents
 */

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? '';

/**
 * Directories a bd `design` value is allowed to point into.
 *
 * MUST stay in sync with DESIGN_DOC_PREFIXES in server/src/routes/fs.rs — a
 * mismatch makes the UI render a preview the backend then 403s on (the failure
 * mode fixed in bweb-489.11). A parity test in __tests__/design-doc.test.ts
 * guards the two lists.
 *
 * - `.designs/`              — superpowers writes specs/plans here in beads
 *                              projects (`.designs/bd-{id}/spec.md`, `plan.md`)
 * - `docs/designs/`          — this repo's own design docs
 * - `docs/superpowers/specs/` — superpowers' location in non-beads projects
 */
export const DESIGN_DOC_PREFIXES = [
  '.designs/',
  'docs/designs/',
  'docs/superpowers/specs/',
] as const;

/**
 * Extension of the last path segment, lowercased, or null when the segment
 * carries no file-extension-looking suffix.
 *
 * Only short alphabetic suffixes count as extensions, so a bead-id directory
 * like `.designs/bd-bweb-489.9/` is not mistaken for a `.9` file.
 */
function fileExtension(path: string): string | null {
  const segment = path.split('/').filter(Boolean).pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = segment.slice(dot + 1).toLowerCase();
  return /^[a-z]{1,5}$/.test(ext) ? ext : null;
}

/** Whether the value sits under one of the allowed design-doc prefixes. */
function hasAllowedPrefix(trimmed: string): boolean {
  if (trimmed.includes('..')) return false;
  return DESIGN_DOC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Determine whether a bd `design` field value is a design-doc path — either a
 * concrete `.md` file or a directory of them — rather than free-text content.
 *
 * This is the single source of truth for deciding whether the Design Preview
 * block should render / fetch. Free-text or empty values return false so the UI
 * never sends them to the filesystem API.
 */
export function isDesignDocPath(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!hasAllowedPrefix(trimmed)) return false;

  const ext = fileExtension(trimmed);
  // No file extension → treat as a directory of design docs.
  return ext === null || ext === 'md';
}

/**
 * Whether the value points at a *directory* of design docs (superpowers writes
 * `.designs/bd-{id}/spec.md` + `plan.md`) rather than a single file.
 */
export function isDesignDocDir(value?: string): boolean {
  if (!isDesignDocPath(value)) return false;
  return fileExtension(value!.trim()) === null;
}

/**
 * Fetch design doc content from the backend API
 */
export async function fetchDesignDoc(path: string, projectPath: string): Promise<string> {
  const encodedPath = encodeURIComponent(path);
  const encodedProjectPath = encodeURIComponent(projectPath);
  const response = await fetch(
    `${API_BASE}/api/fs/read?path=${encodedPath}&project_path=${encodedProjectPath}`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch design doc: ' + response.statusText);
  }
  const data = await response.json();
  return data.content || '';
}

/**
 * List the markdown files inside a design-doc directory.
 *
 * Used for the superpowers layout, where a bead's `design` points at
 * `.designs/bd-{id}/` holding `spec.md` and `plan.md`.
 */
export async function fetchDesignDocList(
  dirPath: string,
  projectPath: string
): Promise<string[]> {
  const encodedPath = encodeURIComponent(dirPath);
  const encodedProjectPath = encodeURIComponent(projectPath);
  const response = await fetch(
    `${API_BASE}/api/fs/list-design-docs?path=${encodedPath}&project_path=${encodedProjectPath}`
  );
  if (!response.ok) {
    throw new Error('Failed to list design docs: ' + response.statusText);
  }
  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * Join a design-doc directory path with a file name, tolerating a missing or
 * duplicated separator.
 */
export function joinDesignDocPath(dirPath: string, fileName: string): string {
  return `${dirPath.trim().replace(/\/+$/, '')}/${fileName}`;
}

/**
 * Strip markdown syntax and convert to plain text preview
 * Removes headers, links, code blocks, bold, italic, etc.
 */
export function truncateMarkdownToPlainText(markdown: string, maxChars: number = 180): string {
  let text = markdown;

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');

  // Remove inline code
  text = text.replace(/`[^`]+`/g, '');

  // Remove headers (# ## ###)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // Remove links but keep text: [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove bold/italic: **text** or *text* -> text
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');

  // Remove blockquotes
  text = text.replace(/^>\s+/gm, '');

  // Remove horizontal rules
  text = text.replace(/^-{3,}$/gm, '');

  // Remove list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, '');
  text = text.replace(/^[\s]*\d+\.\s+/gm, '');

  // Collapse multiple newlines
  text = text.replace(/\n{2,}/g, ' ');

  // Trim and truncate
  text = text.trim();

  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars).trim() + '…';
}

/**
 * Shared prose classes for markdown rendering
 * Ensures consistent styling across preview and full view
 */
export const designDocProseClasses = "prose prose-sm dark:prose-invert max-w-none prose-headings:scroll-mt-20 prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:text-sm prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded";
