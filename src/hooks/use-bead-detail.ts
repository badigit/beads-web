"use client";

import { useState, useCallback, useMemo } from "react";

import type { Bead } from "@/types";

export interface UseBeadDetailResult {
  /** The currently selected bead (resolved from allBeads) */
  detailBead: Bead | null;
  /** Whether the detail panel is open */
  isDetailOpen: boolean;
  /** Open detail for a bead */
  openBead: (bead: Bead) => void;
  /** Open a bead from the current detail panel, preserving navigation history. */
  openNestedBead: (bead: Bead) => void;
  /** Handle detail panel open/close */
  handleDetailOpenChange: (open: boolean) => void;
  /** Navigate to a bead by ID (for dependencies, memory panel, etc.) */
  navigateToBead: (beadId: string) => void;
}

/**
 * Manages bead detail panel state: which bead is selected, open/close logic.
 *
 * @param allBeads - All beads array (used to resolve bead by ID)
 */
export function useBeadDetail(allBeads: Bead[]): UseBeadDetailResult {
  const [detailHistory, setDetailHistory] = useState<string[]>([]);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const detailBeadId = detailHistory.at(-1) ?? null;

  const detailBead = useMemo(() => {
    if (!detailBeadId) return null;
    return allBeads.find((b) => b.id === detailBeadId) || null;
  }, [detailBeadId, allBeads]);

  const openBead = useCallback((bead: Bead) => {
    setDetailHistory([bead.id]);
    setIsDetailOpen(true);
  }, []);

  const openNestedBead = useCallback((bead: Bead) => {
    setDetailHistory((history) => {
      const existingIndex = history.lastIndexOf(bead.id);
      return existingIndex >= 0 ? history.slice(0, existingIndex + 1) : [...history, bead.id];
    });
    setIsDetailOpen(true);
  }, []);

  const handleDetailOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsDetailOpen(true);
    } else if (detailHistory.length > 1) {
      setDetailHistory((history) => history.slice(0, -1));
    } else {
      setDetailHistory([]);
      setIsDetailOpen(false);
    }
  }, [detailHistory.length]);

  const navigateToBead = useCallback((beadId: string) => {
    const found = allBeads.find((b) => b.id === beadId);
    if (found) {
      openNestedBead(found);
    }
  }, [allBeads, openNestedBead]);

  return {
    detailBead,
    isDetailOpen,
    openBead,
    openNestedBead,
    handleDetailOpenChange,
    navigateToBead,
  };
}
