"use client";

/**
 * Two-way binding between the `?bead=<id>` URL param and the detail panel.
 *
 * Inbound (deep link): when the address bar names a bead, open its detail once
 * the bead list has loaded.
 * Outbound (URL sync): while a detail panel is open, keep `?bead=<id>` in the
 * address bar; drop it when the panel closes.
 *
 * The two directions must not race: the outbound effect has to stay quiet
 * until the current `?bead=` param has been resolved, otherwise it strips the
 * param off the address bar before the deep link ever gets to use it.
 */

import { useEffect, useState } from "react";

import { useSearchParams, useRouter } from "next/navigation";

import { toast } from "@/hooks/use-toast";
import { buildProjectUrl, parseBeadIdParam } from "@/lib/bead-link";
import type { Bead } from "@/types";

export interface UseBeadUrlSyncOptions {
  /** Project id from the URL (`?id=`); URL sync is inert without it. */
  projectId: string | null;
  /** Full, unfiltered bead list used to resolve the `?bead=` param. */
  beads: Bead[];
  /**
   * Whether `beads` is the project's real list rather than a placeholder.
   *
   * Must stay `false` until the project itself has resolved: `useBeads("")`
   * reports "not loading" with an empty array while the project path is still
   * being fetched, and resolving `?bead=` against that empty array would
   * wrongly report the deep-linked bead as missing.
   */
  beadsReady: boolean;
  /** Bead currently shown in the detail panel, if any. */
  detailBead: Bead | null;
  /** Opens the detail panel for a bead. */
  openBead: (bead: Bead) => void;
}

export function useBeadUrlSync({
  projectId,
  beads,
  beadsReady,
  detailBead,
  openBead,
}: UseBeadUrlSyncOptions): void {
  const searchParams = useSearchParams();
  const router = useRouter();
  const beadIdParam = parseBeadIdParam(searchParams);

  // Which `?bead=` value has already been resolved against the loaded beads.
  // Tracking the VALUE (not a one-shot boolean) is what makes a late-arriving
  // param work: under static export `useSearchParams()` is empty on the first
  // client render, so a boolean seeded from it would freeze at "resolved" and
  // the deep link would never run. `undefined` is the "nothing resolved yet"
  // seed and never equals a real value — including `null` for "no param".
  const [resolvedParam, setResolvedParam] = useState<string | null | undefined>(undefined);
  const urlBeadResolved = resolvedParam === beadIdParam;

  // Deep link: open the bead named by `?bead=` once beads have loaded, even
  // if current filters would hide it from the board (`beads` here is the
  // full unfiltered list). Shows a toast instead of a blank screen when the
  // id doesn't resolve — closed, filtered by data, or from another project
  // all look the same from here: "not in this project's bead list".
  useEffect(() => {
    if (urlBeadResolved) return;
    if (!beadsReady) return;
    if (beadIdParam) {
      const found = beads.find((b) => b.id === beadIdParam);
      if (found) {
        openBead(found);
      } else {
        toast({
          variant: "destructive",
          title: "Bead not found",
          description: `"${beadIdParam}" isn't in this project — it may be closed, moved, or the link may be wrong.`,
        });
      }
    }
    setResolvedParam(beadIdParam);
  }, [urlBeadResolved, beadIdParam, beadsReady, beads, openBead]);

  // Keep the URL in sync with the open detail bead (`?bead=<id>` while open,
  // stripped when closed). Uses replaceState (via router.replace) so opening
  // cards doesn't pile up Back-button history entries.
  useEffect(() => {
    if (!urlBeadResolved || !projectId) return;
    const nextUrl = buildProjectUrl(projectId, detailBead?.id ?? null);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl) {
      router.replace(nextUrl, { scroll: false });
    }
  }, [urlBeadResolved, detailBead?.id, projectId, router]);
}
