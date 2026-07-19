"use client";

import { useState, useEffect, useCallback } from "react";

import { Loader2, FileText, AlertCircle } from "lucide-react";

import { DesignDocDialog } from "@/components/design-doc-dialog";
import { Button } from "@/components/ui/button";
import {
  fetchDesignDoc,
  fetchDesignDocList,
  isDesignDocDir,
  joinDesignDocPath,
  truncateMarkdownToPlainText,
} from "@/lib/design-doc";

export interface DesignDocPreviewProps {
  /** Path to a design doc file (".designs/BD-001.md") or directory (".designs/bd-BD-001/") */
  designDocPath: string;
  /** Epic ID for display */
  epicId: string;
  /** Project root path (absolute) */
  projectPath: string;
}

/** Drop the ".md" suffix for display: "spec.md" → "spec". */
function fileLabel(fileName: string): string {
  return fileName.replace(/\.md$/i, "");
}

/**
 * Design doc preview component.
 *
 * Two shapes are supported:
 * - a single `.md` file — truncated plain-text preview + "View Full Document"
 * - a directory (superpowers writes `.designs/bd-{id}/spec.md` + `plan.md`) —
 *   a list of the markdown files it contains, each opening in the dialog
 */
export function DesignDocPreview({
  designDocPath,
  epicId,
  projectPath,
}: DesignDocPreviewProps) {
  const isDirectory = isDesignDocDir(designDocPath);

  const [content, setContent] = useState<string>("");
  const [files, setFiles] = useState<string[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setIsLoading(true);
        setError(null);
        if (isDirectory) {
          const names = await fetchDesignDocList(designDocPath, projectPath);
          if (!cancelled) setFiles(names);
        } else {
          const docContent = await fetchDesignDoc(designDocPath, projectPath);
          if (!cancelled) setContent(docContent);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load design doc");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [designDocPath, projectPath, isDirectory]);

  /** Load one file from the directory and show it in the dialog. */
  const handleOpenFile = useCallback(
    async (fileName: string) => {
      setOpenFile(fileName);
      setIsDialogOpen(true);
      setContent("");
      try {
        const filePath = joinDesignDocPath(designDocPath, fileName);
        const docContent = await fetchDesignDoc(filePath, projectPath);
        setContent(docContent);
      } catch (err) {
        setContent(
          `_${err instanceof Error ? err.message : "Failed to load design doc"}_`
        );
      }
    },
    [designDocPath, projectPath]
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Loading design document…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive text-xs py-2">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        <span>{error}</span>
      </div>
    );
  }

  if (isDirectory) {
    if (files.length === 0) {
      return (
        <p className="text-xs text-muted-foreground py-2">
          No design documents in this directory yet.
        </p>
      );
    }

    return (
      <>
        <div className="flex flex-wrap gap-1.5">
          {files.map((fileName) => (
            <Button
              key={fileName}
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void handleOpenFile(fileName);
              }}
              className="text-xs h-7"
            >
              <FileText className="h-3 w-3 mr-1.5" aria-hidden="true" />
              {fileLabel(fileName)}
            </Button>
          ))}
        </div>

        <DesignDocDialog
          open={isDialogOpen}
          onOpenChange={setIsDialogOpen}
          content={content}
          epicId={openFile ? `${epicId} · ${fileLabel(openFile)}` : epicId}
        />
      </>
    );
  }

  const preview = truncateMarkdownToPlainText(content, 180);

  return (
    <>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {preview}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setIsDialogOpen(true);
          }}
          className="text-xs h-7"
        >
          <FileText className="h-3 w-3 mr-1.5" aria-hidden="true" />
          View Full Document
        </Button>
      </div>

      <DesignDocDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        content={content}
        epicId={epicId}
      />
    </>
  );
}
