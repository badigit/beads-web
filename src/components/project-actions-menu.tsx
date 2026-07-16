"use client";

import { ArchiveRestore, Code, FolderOpen, Loader2, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { OpenExternalTarget } from "@/hooks/use-project-actions";
import { getFileManagerName } from "@/lib/project-card-utils";

export interface ProjectActionsMenuProps {
  /** Filesystem path (undefined for dolt-only projects → no open menu). */
  fsPath: string | undefined;
  /** Which external target is currently opening, or null. */
  isOpening: OpenExternalTarget | null;
  /** Open the settings dialog. */
  onSettings: () => void;
  /** Open the project in an external application. */
  onOpenExternal: (target: OpenExternalTarget, e: React.MouseEvent) => void;
  /** ISO timestamp when the project was archived (shows Restore instead). */
  archivedAt?: string;
  /** Restore an archived project. */
  onUnarchive?: () => void;
}

/**
 * Shared action controls for a project entry (card or row): a settings
 * button plus an "open in external app" dropdown, or a Restore button
 * when the project is archived.
 *
 * All controls `stopPropagation` so they never trigger the parent's
 * navigate-on-click behaviour.
 */
export function ProjectActionsMenu({
  fsPath,
  isOpening,
  onSettings,
  onOpenExternal,
  archivedAt,
  onUnarchive,
}: ProjectActionsMenuProps) {
  if (archivedAt) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onUnarchive?.();
          }}
          aria-label="Restore project"
        >
          <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
          Restore
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              mode="icon"
              className="shrink-0"
              aria-label="Project settings"
              onClick={(e) => {
                e.stopPropagation();
                onSettings();
              }}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Project settings</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {fsPath && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <DropdownMenu>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    mode="icon"
                    className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label="Open in external application"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Open in editor or file manager</p>
              </TooltipContent>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => onOpenExternal("vscode", e)}
                  disabled={isOpening !== null}
                >
                  {isOpening === "vscode" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Code className="h-4 w-4" aria-hidden="true" />
                  )}
                  VS Code
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => onOpenExternal("cursor", e)}
                  disabled={isOpening !== null}
                >
                  {isOpening === "cursor" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Code className="h-4 w-4" aria-hidden="true" />
                  )}
                  Cursor
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => onOpenExternal("finder", e)}
                  disabled={isOpening !== null}
                >
                  {isOpening === "finder" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                  )}
                  {getFileManagerName()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
