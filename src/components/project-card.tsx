"use client";

import { ProjectActionsMenu } from "@/components/project-actions-menu";
import { ProjectPathMeta } from "@/components/project-path-meta";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { ProjectStatusIndicator } from "@/components/project-status-indicator";
import { TagPicker } from "@/components/tag-picker";
import { Badge } from "@/components/ui/badge";
import { RoiuiCard } from "@/components/ui/card";
import { useProjectActions } from "@/hooks/use-project-actions";
import type { Tag } from "@/lib/db";
import { formatProjectName } from "@/lib/project-card-utils";
import type { BeadCounts } from "@/types";

interface ProjectCardProps {
  id: string;
  name: string;
  path: string;
  localPath?: string;
  tags: Tag[];
  beadCounts?: BeadCounts;
  /**
   * True once `beadCounts` reflects either cached or freshly-fetched
   * data. When false, the card renders a dashed placeholder donut so
   * the user never sees misleading zeros on first paint.
   */
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

export function ProjectCard({
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
}: ProjectCardProps) {
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
      <RoiuiCard
        className={`cursor-pointer flex flex-col min-h-[155px]${archivedAt ? " opacity-50" : ""}`}
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
        {/* Top row: Donut left, Tags right */}
        <div className="flex items-start justify-between">
          <ProjectStatusIndicator
            beadCounts={beadCounts}
            countsLoaded={countsLoaded}
            beadError={beadError}
            size={36}
          />
          <div
            className="flex flex-wrap items-center gap-1.5"
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
        </div>

        {/* Middle: Title (grows to fill space) */}
        <div className="flex-1 flex items-center">
          <h3 className="text-xl font-medium text-balance font-project-name">
            {formatProjectName(name)}
          </h3>
        </div>

        {/* Bottom row: Path left, actions right */}
        <div className="flex items-center justify-between gap-2">
          <ProjectPathMeta path={path} name={name} dataSource={dataSource} archivedAt={archivedAt} />
          <ProjectActionsMenu
            fsPath={fsPath}
            isOpening={isOpening}
            onSettings={() => setSettingsOpen(true)}
            onOpenExternal={handleOpenExternal}
            archivedAt={archivedAt}
            onUnarchive={onUnarchive}
          />
        </div>
      </RoiuiCard>
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
