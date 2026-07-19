"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Loader2, Search } from "lucide-react";

import { BeadSearchResults, optionId } from "@/components/bead-search-results";
import { useBeadSearch } from "@/hooks/use-bead-search";
import type { SearchResult } from "@/lib/api";
import { cn } from "@/lib/utils";

const LISTBOX_ID = "home-search-results";
const ID_PREFIX = "home-search";

export interface HomeBeadSearchProps {
  className?: string;
}

/**
 * The home page's primary search field — beads across every project.
 *
 * Always visible above the project list, so the global search is discoverable
 * without knowing a shortcut. Results drop down inline underneath rather than
 * in a modal, which would defeat the point of a visible field. Ctrl+K / Cmd+K
 * still works here, focusing this field instead of opening the dialog palette.
 */
export function HomeBeadSearch({ className }: HomeBeadSearchProps) {
  const search = useBeadSearch();
  const { activeIndex, setActiveIndex, openResult, reset } = search;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const expanded = focused && !dismissed && search.query.trim().length > 0;

  // Ctrl+K / Cmd+K focuses this field rather than opening the dialog palette.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || (!event.ctrlKey && !event.metaKey)) return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Clicking anywhere outside collapses the dropdown but keeps the query.
  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setFocused(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [expanded]);

  const onSelect = useCallback(
    (result: SearchResult) => {
      setDismissed(true);
      openResult(result);
    },
    [openResult]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (search.query) {
          reset();
        } else {
          inputRef.current?.blur();
        }
        return;
      }
      setDismissed(false);
      search.onInputKeyDown(event);
    },
    [search, reset]
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t-muted"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={
          expanded && activeIndex >= 0 ? optionId(ID_PREFIX, activeIndex) : undefined
        }
        aria-label="Search beads across all projects"
        value={search.query}
        onChange={(event) => {
          setDismissed(false);
          search.setQuery(event.target.value);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search beads across all projects by id or title…"
        className="h-11 w-full rounded-lg border border-b-strong bg-surface-raised/50 pl-10 pr-24 text-sm text-t-primary placeholder:text-t-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-t-tertiary"
      />
      <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
        {search.loading && (
          <Loader2 className="h-4 w-4 animate-spin text-t-tertiary" aria-hidden="true" />
        )}
        <kbd className="rounded border border-b-default px-1.5 py-0.5 font-mono text-[11px] text-t-faint">
          Ctrl K
        </kbd>
      </div>

      {expanded && (
        <div
          // Keeps focus in the input so a row click is not preceded by a blur
          // that would unmount the row mid-click.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-y-auto rounded-lg border border-b-default bg-surface-overlay p-2 shadow-lg"
        >
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
          {search.results.length > 0 && (
            <p className="border-t border-b-default px-3 pt-2 text-[11px] text-t-faint">
              ↑↓ to navigate · Enter to open · Esc to clear
            </p>
          )}
        </div>
      )}
    </div>
  );
}
