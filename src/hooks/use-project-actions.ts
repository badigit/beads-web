"use client";

/**
 * Shared behaviour for a single project entry (card or row):
 * navigation, external-open dropdown state, and settings dialog state.
 *
 * Extracted so `ProjectCard` and `ProjectRow` share one implementation
 * instead of duplicating the router / toast / open-external logic.
 */

import { useState, useCallback } from "react";

import { useRouter } from "next/navigation";

import { useToast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import { getFileManagerName, getFsPath } from "@/lib/project-card-utils";

/** External application targets for "open in…". */
export type OpenExternalTarget = "vscode" | "cursor" | "finder";

/** Inputs identifying which project the actions operate on. */
export interface UseProjectActionsArgs {
  id: string;
  path: string;
  localPath?: string;
}

/** Result type for the `useProjectActions` hook. */
export interface UseProjectActionsResult {
  /** Filesystem path for external operations (undefined for dolt-only). */
  fsPath: string | undefined;
  /** Which target is currently opening, or null when idle. */
  isOpening: OpenExternalTarget | null;
  /** Whether the settings dialog is open. */
  settingsOpen: boolean;
  /** Toggle the settings dialog. */
  setSettingsOpen: (open: boolean) => void;
  /** Navigate to the project's kanban board. */
  navigateToProject: () => void;
  /** Open the project in an external editor / file manager. */
  handleOpenExternal: (target: OpenExternalTarget, e: React.MouseEvent) => Promise<void>;
}

export function useProjectActions({
  id,
  path,
  localPath,
}: UseProjectActionsArgs): UseProjectActionsResult {
  const router = useRouter();
  const { toast } = useToast();
  const [isOpening, setIsOpening] = useState<OpenExternalTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fsPath = getFsPath(path, localPath);

  const navigateToProject = useCallback(() => {
    router.push(`/project?id=${id}`);
  }, [router, id]);

  const handleOpenExternal = useCallback(
    async (target: OpenExternalTarget, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!fsPath) return;
      setIsOpening(target);

      try {
        await api.fs.openExternal(fsPath, target);
        toast({
          title: "Opening project",
          description:
            target === "finder"
              ? `Opening in ${getFileManagerName()}...`
              : `Opening in ${target === "vscode" ? "VS Code" : "Cursor"}...`,
        });
      } catch (err) {
        console.error("Error opening project:", err);
        toast({
          title: "Failed to open",
          description:
            err instanceof Error
              ? err.message
              : "Could not open the project. Make sure the application is installed.",
          variant: "destructive",
        });
      } finally {
        setIsOpening(null);
      }
    },
    [fsPath, toast]
  );

  return {
    fsPath,
    isOpening,
    settingsOpen,
    setSettingsOpen,
    navigateToProject,
    handleOpenExternal,
  };
}
