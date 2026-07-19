"use client";

import { useCallback, useEffect, useState } from "react";

import { usePathname } from "next/navigation";

import { Loader2, Search } from "lucide-react";

import { BeadSearchResults, optionId } from "@/components/bead-search-results";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBeadSearch } from "@/hooks/use-bead-search";
import type { SearchResult } from "@/lib/api";
import { isHomePath, shouldOpenSearchPalette } from "@/lib/search-nav";

const LISTBOX_ID = "global-search-results";
const ID_PREFIX = "global-search";

/**
 * True when the event target is a field that owns its own keyboard handling,
 * so the palette shortcut leaves native Ctrl+K behaviour intact.
 */
function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Global command palette — Ctrl+K / Cmd+K from any page except the home page.
 *
 * Queries `GET /api/search` across every Direct Dolt database and renders the
 * hits in the order the backend ranked them. On the home page this component
 * stands down entirely: `HomeBeadSearch` provides an always-visible field
 * there and owns the shortcut, so there is no second, redundant surface.
 */
export function GlobalSearch() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const search = useBeadSearch({ enabled: open });
  const { reset, openResult, setActiveIndex, activeIndex } = search;

  // The home page has its own inline field; the palette is inert there.
  const enabled = !isHomePath(pathname);

  // Global shortcut. preventDefault only fires when the palette actually opens.
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldOpenSearchPalette(event, open, isEditableElement(event.target))) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, enabled]);

  // A route change to the home page must not leave the palette hanging open.
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) reset();
    },
    [reset]
  );

  const onSelect = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      openResult(result);
    },
    [openResult]
  );

  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label="Search all projects (Ctrl+K)"
        className="fixed right-14 top-4 z-40 rounded-md p-2 text-t-tertiary transition-colors duration-150 hover:text-t-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-t-tertiary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
      >
        <Search className="h-5 w-5" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          aria-label="Global search"
          className="top-[15%] w-[calc(100vw-2rem)] max-w-2xl translate-y-0 gap-0 border-b-default bg-surface-overlay p-0"
        >
          <DialogTitle className="sr-only">Global search</DialogTitle>
          <DialogDescription className="sr-only">
            Search beads by id or title across all projects.
          </DialogDescription>

          <div className="flex items-center gap-2 border-b border-b-default px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-t-tertiary" aria-hidden="true" />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 ? optionId(ID_PREFIX, activeIndex) : undefined
              }
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={search.onInputKeyDown}
              placeholder="Search all projects by id or title…"
              className="w-full flex-1 border-0 bg-transparent pr-8 text-sm text-t-primary placeholder:text-t-faint focus:outline-none"
            />
            {search.loading && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-t-tertiary" aria-hidden="true" />
            )}
          </div>

          <div className="h-72 overflow-y-auto p-2">
            <BeadSearchResults
              listboxId={LISTBOX_ID}
              idPrefix={ID_PREFIX}
              query={search.query}
              results={search.results}
              loading={search.loading}
              error={search.error}
              activeIndex={activeIndex}
              onSelect={onSelect}
              onHover={setActiveIndex}
              registerRow={search.registerRow}
            />
          </div>

          <div className="border-t border-b-default px-4 py-2 text-[11px] text-t-faint">
            ↑↓ to navigate · Enter to open · Esc to close
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
