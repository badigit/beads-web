"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "next/navigation";

import { Database, Loader2, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/api";
import type { SearchResult } from "@/lib/api";
import { formatStatus, getStatusDotColor } from "@/lib/bead-utils";
import {
  isSearchResultNavigable,
  nextResultIndex,
  searchResultHref,
  shouldOpenSearchPalette,
} from "@/lib/search-nav";
import { cn } from "@/lib/utils";
import type { BeadStatus } from "@/types";

/** Matches the backend's MIN_QUERY_CHARS — below this the API returns []. */
const MIN_QUERY_LENGTH = 2;

/** Debounce before hitting the API, in milliseconds. */
const DEBOUNCE_MS = 250;

const LISTBOX_ID = "global-search-results";
const optionId = (index: number) => `global-search-option-${index}`;

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

interface SearchResultRowProps {
  result: SearchResult;
  index: number;
  active: boolean;
  onSelect: (result: SearchResult) => void;
  onHover: (index: number) => void;
  rowRef: (element: HTMLLIElement | null) => void;
}

function SearchResultRow({
  result,
  index,
  active,
  onSelect,
  onHover,
  rowRef,
}: SearchResultRowProps) {
  const navigable = isSearchResultNavigable(result);

  return (
    <li
      ref={rowRef}
      id={optionId(index)}
      role="option"
      aria-selected={active}
      aria-disabled={!navigable}
      onMouseMove={() => onHover(index)}
      onClick={() => onSelect(result)}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-100",
        active && "bg-surface-raised",
        navigable ? "cursor-pointer" : "cursor-default opacity-60"
      )}
    >
      <span className="shrink-0 font-mono text-xs text-t-primary">{result.bead_id}</span>
      <span className="min-w-0 flex-1 truncate text-t-secondary">{result.title}</span>
      <span className="flex shrink-0 items-center gap-1 rounded border border-b-default px-1.5 py-0.5 text-[11px] text-t-tertiary">
        {!navigable && <Database className="h-3 w-3" aria-hidden="true" />}
        {navigable ? result.project_name : result.database}
      </span>
      <span className={cn("shrink-0 text-[11px]", getStatusDotColor(result.status as BeadStatus))}>
        {formatStatus(result.status as BeadStatus)}
      </span>
    </li>
  );
}

/**
 * Global command palette — Ctrl+K / Cmd+K from any page.
 *
 * Queries `GET /api/search` across every Direct Dolt database and renders the
 * hits in the order the backend ranked them.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Global shortcut. preventDefault only fires when the palette actually opens.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shouldOpenSearchPalette(event, open, isEditableElement(event.target))) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Debounced query; the previous in-flight request is aborted on every change.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setActiveIndex(-1);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const hits = await api.search.query(trimmed, controller.signal);
        setResults(hits);
        setActiveIndex(hits.length > 0 ? 0 : -1);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Global search failed", { query: trimmed, error: err });
        setResults([]);
        setActiveIndex(-1);
        setError(err instanceof Error ? err.message : "Search failed");
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const openResult = useCallback(
    (result: SearchResult) => {
      const href = searchResultHref(result);
      if (!href) return;
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setError(null);
    setLoading(false);
  }, []);

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => nextResultIndex(current, results.length, direction));
        return;
      }
      if (event.key === "Enter" && activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        openResult(results[activeIndex]);
      }
    },
    [results, activeIndex, openResult]
  );

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
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search all projects by id or title…"
              className="w-full flex-1 border-0 bg-transparent pr-8 text-sm text-t-primary placeholder:text-t-faint focus:outline-none"
            />
            {loading && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-t-tertiary" aria-hidden="true" />
            )}
          </div>

          <div className="h-72 overflow-y-auto p-2">
            <ul id={LISTBOX_ID} role="listbox" aria-label="Search results" className="space-y-0.5">
              {results.map((result, index) => (
                <SearchResultRow
                  key={`${result.database}:${result.bead_id}`}
                  result={result}
                  index={index}
                  active={index === activeIndex}
                  onSelect={openResult}
                  onHover={setActiveIndex}
                  rowRef={(element) => {
                    rowRefs.current[index] = element;
                  }}
                />
              ))}
            </ul>
            {results.length === 0 && (
              <p role="status" className="px-3 py-2 text-sm text-t-muted">
                {error
                  ? error
                  : query.trim().length < MIN_QUERY_LENGTH
                    ? "Type at least 2 characters to search"
                    : loading
                      ? "Searching…"
                      : "Nothing found"}
              </p>
            )}
          </div>

          <div className="border-t border-b-default px-4 py-2 text-[11px] text-t-faint">
            ↑↓ to navigate · Enter to open · Esc to close
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
