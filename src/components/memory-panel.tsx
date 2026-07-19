"use client";

import { useState, useCallback, useEffect } from "react";

import {
  BrainCircuit,
  Pencil,
  Trash2,
  Search,
  MoreVertical,
  X,
  Plus,
  Loader2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogClose,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { useMemory } from "@/hooks/use-memory";
import type { MemoryEntry } from "@/types";

export interface MemoryPanelProps {
  /** Whether the panel is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Absolute path to the project root */
  projectPath: string;
}

/** Mirrors the server-side key validation in `server/src/routes/memory.rs`. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a memory key client-side so the error appears next to the field
 * rather than arriving as a failed request.
 */
function validateKey(key: string): string | null {
  if (!key.trim()) return "Key is required";
  if (!KEY_PATTERN.test(key.trim())) {
    return "Use letters, digits, '-', '_' and '.' only";
  }
  return null;
}

/**
 * Single memory entry card
 */
function MemoryEntryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: MemoryEntry;
  onEdit: (entry: MemoryEntry) => void;
  onDelete: (key: string) => void;
}) {
  return (
    <div className="rounded-lg border border-b-default bg-surface-raised/50 p-3 space-y-2 overflow-hidden">
      {/* Top row: key, actions menu */}
      <div className="flex items-start justify-between gap-2">
        <code
          className="text-xs font-mono text-t-muted truncate min-w-0"
          title={entry.key}
        >
          {entry.key}
        </code>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="size-6 shrink-0 flex items-center justify-center rounded text-t-muted hover:text-t-secondary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Actions for memory ${entry.key}`}
            >
              <MoreVertical className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="bg-surface-raised border-b-default"
          >
            <DropdownMenuItem
              onClick={() => onEdit(entry)}
              className="text-t-secondary focus:bg-surface-overlay focus:text-t-primary gap-2"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Edit content
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-surface-overlay" />
            <DropdownMenuItem
              onClick={() => onDelete(entry.key)}
              className="text-danger focus:bg-surface-overlay focus:text-danger gap-2"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content preview */}
      <p className="text-sm text-t-secondary line-clamp-4 text-pretty whitespace-pre-wrap">
        {entry.content}
      </p>
    </div>
  );
}

/**
 * Memory Panel — slide-out Sheet for browsing and managing the project's
 * bd memories (`bd remember` / `bd memories`).
 */
export function MemoryPanel({
  open,
  onOpenChange,
  projectPath,
}: MemoryPanelProps) {
  const {
    stats,
    isLoading,
    error,
    search,
    setSearch,
    filteredEntries,
    createEntry,
    editEntry,
    deleteEntry,
    refresh,
  } = useMemory(projectPath);

  // The panel stays mounted while hidden, so without this it would keep showing
  // whatever bd returned on first mount. Memories change outside the UI — an
  // agent session running `bd remember` is the normal case — so reopening the
  // panel must show the current state rather than a stale snapshot.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Create dialog state
  const [isCreating, setIsCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newContent, setNewContent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog state
  const [editingEntry, setEditingEntry] = useState<MemoryEntry | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);

  // Delete confirmation state
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  /**
   * Open the create dialog with empty fields
   */
  const handleCreateOpen = useCallback(() => {
    setNewKey("");
    setNewContent("");
    setCreateError(null);
    setIsCreating(true);
  }, []);

  /**
   * Save a new memory
   */
  const handleCreateSave = useCallback(async () => {
    const keyError = validateKey(newKey);
    if (keyError) {
      setCreateError(keyError);
      return;
    }
    if (!newContent.trim()) {
      setCreateError("Content is required");
      return;
    }

    setIsSaving(true);
    setCreateError(null);
    try {
      await createEntry(newKey.trim(), newContent);
      setIsCreating(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [newKey, newContent, createEntry]);

  /**
   * Open edit dialog for an entry
   */
  const handleEditOpen = useCallback((entry: MemoryEntry) => {
    setEditingEntry(entry);
    setEditContent(entry.content);
    setEditError(null);
  }, []);

  /**
   * Save edited entry
   */
  const handleEditSave = useCallback(async () => {
    if (!editingEntry) return;
    if (!editContent.trim()) {
      setEditError("Content is required");
      return;
    }

    setIsSaving(true);
    setEditError(null);
    try {
      await editEntry(editingEntry.key, editContent);
      setEditingEntry(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [editingEntry, editContent, editEntry]);

  /**
   * Handle delete confirmation
   */
  const handleDeleteConfirm = useCallback(async () => {
    if (!deletingKey) return;
    setIsDeleting(true);
    try {
      await deleteEntry(deletingKey);
      setDeletingKey(null);
    } catch {
      // Error is logged in hook
    } finally {
      setIsDeleting(false);
    }
  }, [deletingKey, deleteEntry]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-lg md:max-w-xl bg-surface-base border-b-default flex flex-col"
        >
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2 text-t-primary">
              <BrainCircuit className="size-5" aria-hidden="true" />
              Memory
            </SheetTitle>
            <SheetDescription className="text-t-muted">
              {stats
                ? `${stats.total} ${stats.total === 1 ? "entry" : "entries"} · bd memories`
                : "Loading…"}
            </SheetDescription>
          </SheetHeader>

          {/* Search + new */}
          <div className="flex items-center gap-2 mt-4">
            <div className="relative flex-1">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-t-muted"
                aria-hidden="true"
              />
              <Input
                type="text"
                aria-label="Search memories"
                placeholder="Search memories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 pr-8 h-8 bg-surface-overlay/50 border-b-strong text-t-primary placeholder:text-t-muted"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-0 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center text-t-muted hover:text-t-secondary"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5"
              onClick={handleCreateOpen}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              New
            </Button>
          </div>

          {/* Entries list */}
          <ScrollArea className="flex-1 mt-3 -mx-6 px-6">
            <div className="space-y-2 pb-4">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2
                    className="size-5 text-t-muted animate-spin"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Loading memory entries</span>
                </div>
              ) : error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-center"
                >
                  <p className="text-sm text-danger">
                    Failed to load memory entries
                  </p>
                  <p className="text-xs text-danger/60 mt-1">{error.message}</p>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <BrainCircuit
                    className="size-8 text-t-faint mb-3"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-t-muted">
                    {search
                      ? "No entries match your search"
                      : "No memories yet"}
                  </p>
                  {search ? (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="mt-2 text-xs text-t-muted hover:text-t-secondary underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      Clear search
                    </button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-3 gap-1.5"
                      onClick={handleCreateOpen}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      Add your first memory
                    </Button>
                  )}
                </div>
              ) : (
                filteredEntries.map((entry) => (
                  <MemoryEntryCard
                    key={entry.key}
                    entry={entry}
                    onEdit={handleEditOpen}
                    onDelete={setDeletingKey}
                  />
                ))
              )}
            </div>
          </ScrollArea>

          {/* Footer */}
          {stats && stats.total > 0 && (
            <SheetFooter className="border-t border-b-default pt-3 -mx-6 px-6">
              <p className="text-xs text-t-faint w-full text-center text-balance">
                Shared with <code className="font-mono">bd memories</code> —
                injected into agent sessions at <code className="font-mono">bd prime</code>
              </p>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      {/* Create Dialog */}
      <AlertDialog
        open={isCreating}
        onOpenChange={(isOpen) => !isOpen && setIsCreating(false)}
      >
        <AlertDialogContent className="bg-surface-raised border-b-default">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-t-primary">
              New Memory
            </AlertDialogTitle>
            <AlertDialogDescription className="text-t-muted">
              Stored via <code className="font-mono">bd remember</code> and
              available to every agent session in this project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="new-key"
                className="text-sm font-medium text-t-secondary"
              >
                Key
              </label>
              <Input
                id="new-key"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="bg-surface-overlay/50 border-b-strong text-t-primary placeholder:text-t-muted font-mono"
                placeholder="pg-pool-exhaustion"
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="new-content"
                className="text-sm font-medium text-t-secondary"
              >
                Content
              </label>
              <textarea
                id="new-content"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                className="w-full h-32 rounded-md border border-b-strong bg-surface-overlay/50 px-3 py-2 text-sm text-t-primary placeholder:text-t-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                placeholder="[problem] → [solution]. [context why]"
              />
            </div>
            {createError && (
              <p role="alert" className="text-xs text-danger">
                {createError}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button onClick={handleCreateSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2
                  className="size-4 animate-spin mr-1.5"
                  aria-hidden="true"
                />
              ) : null}
              Create
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Dialog */}
      <AlertDialog
        open={!!editingEntry}
        onOpenChange={(isOpen) => !isOpen && setEditingEntry(null)}
      >
        <AlertDialogContent className="bg-surface-raised border-b-default">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-t-primary">
              Edit Memory
            </AlertDialogTitle>
            <AlertDialogDescription className="text-t-muted">
              Updating{" "}
              <code className="font-mono">{editingEntry?.key}</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="edit-content"
                className="text-sm font-medium text-t-secondary"
              >
                Content
              </label>
              <textarea
                id="edit-content"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-32 rounded-md border border-b-strong bg-surface-overlay/50 px-3 py-2 text-sm text-t-primary placeholder:text-t-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
              />
            </div>
            {editError && (
              <p role="alert" className="text-xs text-danger">
                {editError}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button onClick={handleEditSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2
                  className="size-4 animate-spin mr-1.5"
                  aria-hidden="true"
                />
              ) : null}
              Save
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deletingKey}
        onOpenChange={(isOpen) => !isOpen && setDeletingKey(null)}
      >
        <AlertDialogContent className="bg-surface-raised border-b-default">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-t-primary">
              Delete Memory
            </AlertDialogTitle>
            <AlertDialogDescription className="text-t-tertiary">
              This permanently removes{" "}
              <code className="font-mono">{deletingKey}</code> from the
              project&apos;s bd memories. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2
                  className="size-4 animate-spin mr-1.5"
                  aria-hidden="true"
                />
              ) : (
                <Trash2 className="size-4 mr-1.5" aria-hidden="true" />
              )}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
