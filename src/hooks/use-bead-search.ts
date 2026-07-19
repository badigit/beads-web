"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "next/navigation";

import * as api from "@/lib/api";
import type { SearchResult } from "@/lib/api";
import { nextResultIndex, searchResultHref } from "@/lib/search-nav";

/** Matches the backend's MIN_QUERY_CHARS — below this the API returns []. */
export const MIN_QUERY_LENGTH = 2;

/** Debounce before hitting the API, in milliseconds. */
export const DEBOUNCE_MS = 250;

export interface UseBeadSearchOptions {
  /**
   * When false the hook stays idle and never queries — used by the dialog
   * shell so a closed palette does not hit the API.
   */
  enabled?: boolean;
}

export interface UseBeadSearchResult {
  query: string;
  setQuery: (value: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Arrow-key navigation + Enter to open. Attach to the input's onKeyDown. */
  onInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Navigates to a hit; no-op for hits without a local project. */
  openResult: (result: SearchResult) => void;
  /** Clears query, results and selection back to the idle state. */
  reset: () => void;
  /** Registers a row element so the active one can be scrolled into view. */
  registerRow: (index: number) => (element: HTMLLIElement | null) => void;
}

/**
 * Bead search state shared by every search surface.
 *
 * Owns the debounce, the AbortController cancellation of superseded requests,
 * the highlighted-row bookkeeping and the navigation on select, so the dialog
 * palette and the inline home-page field behave identically and only differ
 * in how they are presented.
 */
export function useBeadSearch(options: UseBeadSearchOptions = {}): UseBeadSearchResult {
  const { enabled = true } = options;
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Debounced query; the previous in-flight request is aborted on every change.
  useEffect(() => {
    if (!enabled) return;
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
        console.error("Bead search failed", { query: trimmed, error: err });
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
  }, [query, enabled]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const reset = useCallback(() => {
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setError(null);
    setLoading(false);
  }, []);

  const openResult = useCallback(
    (result: SearchResult) => {
      const href = searchResultHref(result);
      if (!href) return;
      router.push(href);
    },
    [router]
  );

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

  const registerRow = useCallback(
    (index: number) => (element: HTMLLIElement | null) => {
      rowRefs.current[index] = element;
    },
    []
  );

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    activeIndex,
    setActiveIndex,
    onInputKeyDown,
    openResult,
    reset,
    registerRow,
  };
}
