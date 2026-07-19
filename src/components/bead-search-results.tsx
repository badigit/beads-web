"use client";

import { Database } from "lucide-react";

import { MIN_QUERY_LENGTH } from "@/hooks/use-bead-search";
import type { SearchResult } from "@/lib/api";
import { formatStatus, getStatusDotColor } from "@/lib/bead-utils";
import { isSearchResultNavigable } from "@/lib/search-nav";
import { cn } from "@/lib/utils";
import type { BeadStatus } from "@/types";

/** DOM id of an option row, derived from the owning surface's id prefix. */
export const optionId = (idPrefix: string, index: number) => `${idPrefix}-option-${index}`;

interface SearchResultRowProps {
  result: SearchResult;
  index: number;
  idPrefix: string;
  active: boolean;
  onSelect: (result: SearchResult) => void;
  onHover: (index: number) => void;
  rowRef: (element: HTMLLIElement | null) => void;
}

function SearchResultRow({
  result,
  index,
  idPrefix,
  active,
  onSelect,
  onHover,
  rowRef,
}: SearchResultRowProps) {
  const navigable = isSearchResultNavigable(result);

  return (
    <li
      ref={rowRef}
      id={optionId(idPrefix, index)}
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

export interface BeadSearchResultsProps {
  listboxId: string;
  idPrefix: string;
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  activeIndex: number;
  onSelect: (result: SearchResult) => void;
  onHover: (index: number) => void;
  registerRow: (index: number) => (element: HTMLLIElement | null) => void;
}

/**
 * The listbox of search hits plus its empty/loading/error status line.
 *
 * Shared by the Ctrl+K dialog palette and the inline home-page field so both
 * surfaces render identical rows and keep the same combobox semantics.
 */
export function BeadSearchResults({
  listboxId,
  idPrefix,
  query,
  results,
  loading,
  error,
  activeIndex,
  onSelect,
  onHover,
  registerRow,
}: BeadSearchResultsProps) {
  return (
    <>
      <ul id={listboxId} role="listbox" aria-label="Search results" className="space-y-0.5">
        {results.map((result, index) => (
          <SearchResultRow
            key={`${result.database}:${result.bead_id}`}
            result={result}
            index={index}
            idPrefix={idPrefix}
            active={index === activeIndex}
            onSelect={onSelect}
            onHover={onHover}
            rowRef={registerRow(index)}
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
    </>
  );
}
