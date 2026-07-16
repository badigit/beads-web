"use client";

import { ProjectActionsMenu } from "@/components/project-actions-menu";
import { ProjectPathMeta } from "@/components/project-path-meta";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { ProjectStatusIndicator } from "@/components/project-status-indicator";
import { TagPicker } from "@/components/tag-picker";
import { Badge } from "@/components/ui/badge";
import { useProjectActions } from "@/hooks/use-project-actions";
import type { Tag } from "@/lib/db";
import { formatProjectName } from "@/lib/project-card-utils";
import type { BeadCounts } from "@/types";

interface ProjectRowProps {
  id: string;
  name: string;
  path: string;
  localPath?: string;
  tags: Tag[];
  beadCounts?: BeadCounts;
  countsLoaded?: boolean;
  dataSource?: string;
  beadError?: string;
  archivedAt?: string;
  onTagsChange?: (tags: Tag[]) => void;
  onUpdated?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}

/** A compact count chip (coloured dot + number) for the list view. */
function CountChip({ colorVar, count, label }: { colorVar: string; count: number; label: string }) {
  const dim = count === 0;
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${dim ? "text-t-faint" : "text-t-secondary"}`}
      title={`${count} ${label}`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `hsl(var(${colorVar}))`, opacity: dim ? 0.4 : 1 }}
        aria-hidden="true"
      />
      {count}
    </span>
  );
}

/**
 * Compact, full-width list row for a project. Mirrors `ProjectCard`
 * behaviour (navigate on click, external-open, settings, archive/restore)
 * but in a single horizontal line. Reuses the same shared hook and
 * sub-components so there is no duplicated logic.
 */
export function ProjectRow({
  id,
  name,
  path,
  localPath,
  tags,
  beadCounts = { open: 0, in_progress: 0, inreview: 0, closed: 0 },
  countsLoaded = true,
  dataSource,
  beadError,
  archivedAt,
  onTagsChange,
  onUpdated,
  onArchive,
  onUnarchive,
  onDelete,
}: ProjectRowProps) {
  const {
    fsPath,
    isOpening,
    settingsOpen,
    setSettingsOpen,
    navigateToProject,
    handleOpenExternal,
  } = useProjectActions({ id, path, localPath });

  return (
    <>
      <div
        className={`group flex items-center gap-3 rounded-lg border border-b-default bg-surface-raised/70 px-3 py-2.5 cursor-pointer transition-colors hover:bg-surface-overlay/60${archivedAt ? " opacity-50" : ""}`}
        onClick={navigateToProject}
        role="link"
        tabIndex={0}
        aria-label={`View ${formatProjectName(name)} project`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigateToProject();
          }
        }}
      >
        <div className="shrink-0">
          <ProjectStatusIndicator
            beadCounts={beadCounts}
            countsLoaded={countsLoaded}
            beadError={beadError}
            size={28}
          />
        </div>

        {/* Name */}
        <h3 className="shrink-0 truncate font-project-name text-base font-medium max-w-[160px] sm:max-w-[220px]">
          {formatProjectName(name)}
        </h3>

        {/* Counts */}
        <div className="hidden shrink-0 items-center gap-2.5 text-xs sm:flex">
          <CountChip colorVar="--status-open" count={beadCounts.open} label="open" />
          <CountChip colorVar="--status-progress" count={beadCounts.in_progress} label="in progress" />
          <CountChip colorVar="--status-closed" count={beadCounts.closed} label="closed" />
        </div>

        {/* Tags */}
        <div
          className="hidden shrink-0 items-center gap-1.5 lg:flex"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              size="sm"
              style={{
                backgroundColor: `${tag.color}20`,
                color: tag.color,
                borderColor: tag.color,
              }}
            >
              {tag.name}
            </Badge>
          ))}
          {onTagsChange && (
            <TagPicker projectId={id} projectTags={tags} onTagsChange={onTagsChange} />
          )}
        </div>

        {/* Path + source badges (grows to fill) */}
        <ProjectPathMeta path={path} name={name} dataSource={dataSource} archivedAt={archivedAt} />

        {/* Actions */}
        <ProjectActionsMenu
          fsPath={fsPath}
          isOpening={isOpening}
          onSettings={() => setSettingsOpen(true)}
          onOpenExternal={handleOpenExternal}
          archivedAt={archivedAt}
          onUnarchive={onUnarchive}
        />
      </div>
      <ProjectSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        projectId={id}
        projectName={name}
        projectPath={path}
        projectLocalPath={localPath}
        archivedAt={archivedAt}
        onUpdated={onUpdated ?? (() => {})}
        onArchive={onArchive}
        onDelete={onDelete}
      />
    </>
  );
}
