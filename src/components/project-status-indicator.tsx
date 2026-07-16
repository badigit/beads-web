"use client";

import { AlertTriangle } from "lucide-react";

import { StatusDonut } from "@/components/status-donut";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { BeadCounts } from "@/types";

export interface ProjectStatusIndicatorProps {
  beadCounts: BeadCounts;
  countsLoaded: boolean;
  /** Error message from the beads read (renders a warning instead of a donut). */
  beadError?: string;
  /** Donut diameter in px. */
  size?: number;
}

/**
 * Renders a project's status donut, or a warning icon (with the error in
 * a tooltip) when the beads read failed. Shared by `ProjectCard` and
 * `ProjectRow`.
 */
export function ProjectStatusIndicator({
  beadCounts,
  countsLoaded,
  beadError,
  size = 36,
}: ProjectStatusIndicatorProps) {
  if (beadError) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-warning" style={{ width: size, height: size }}>
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="text-xs">{beadError}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <StatusDonut beadCounts={beadCounts} size={size} countsLoaded={countsLoaded} />;
}
