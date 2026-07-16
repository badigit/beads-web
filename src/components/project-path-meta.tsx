"use client";

import { AlertTriangle, Archive } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { deriveBeadPrefix } from "@/lib/utils";

export interface ProjectPathMetaProps {
  path: string;
  name: string;
  dataSource?: string;
  archivedAt?: string;
}

/** Human label for a non-jsonl data source. */
function dataSourceLabel(dataSource: string): string {
  switch (dataSource) {
    case "dolt-project":
      return "Dolt (project)";
    case "dolt-central":
      return "Dolt (central)";
    case "dolt-direct":
      return "Dolt (direct)";
    case "cli":
      return "CLI";
    default:
      return dataSource;
  }
}

/**
 * Renders a project's path (truncated, with a full-path tooltip) plus
 * status badges: Archived, "Old format — migrate", or the data source.
 * Shared by `ProjectCard` and `ProjectRow`.
 */
export function ProjectPathMeta({ path, name, dataSource, archivedAt }: ProjectPathMetaProps) {
  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <p className="text-sm text-t-muted truncate min-w-0" title={path}>
        {path}
      </p>
      {archivedAt && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-overlay px-2 py-0.5 text-[10px] font-medium text-t-muted">
          <Archive className="h-3 w-3" aria-hidden="true" />
          Archived
        </span>
      )}
      {!archivedAt && dataSource === "jsonl" && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="note"
                tabIndex={0}
                aria-label={`Old beads format — migrate with bd init --prefix ${deriveBeadPrefix(path, name)}`}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Old format — migrate
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <div className="space-y-1">
                <p className="text-xs">
                  This project uses the old JSONL beads format. Run this in the project directory to
                  migrate to Dolt:
                </p>
                <code className="block rounded bg-black/30 px-1.5 py-1 font-mono text-[11px]">
                  bd init --prefix {deriveBeadPrefix(path, name)}
                </code>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!archivedAt && dataSource && dataSource !== "jsonl" && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-surface-overlay px-2 py-0.5 text-[10px] font-medium text-t-muted">
          {dataSourceLabel(dataSource)}
        </span>
      )}
    </div>
  );
}
