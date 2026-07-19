"use client";

import { Bot, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSessionSpawn } from "@/hooks/use-session-spawn";
import { cn } from "@/lib/utils";

export interface SpawnSessionButtonProps {
  /** Bead the session is started for. */
  beadId: string;
  /** Project root. Dolt-only projects render nothing — no filesystem repo. */
  projectPath?: string;
  /** Extra classes for the button itself (e.g. `w-full` inside a card). */
  className?: string;
  /** Button size, matching the surrounding controls. */
  size?: "xs" | "sm";
  /** Classes for the wrapper that also holds progress and error text. */
  wrapperClassName?: string;
}

/**
 * Starts a Claude Desktop session for a bead: worktree, headless `claude -p`,
 * hand-off to the desktop app.
 *
 * The whole round-trip takes tens of seconds, so the button both blocks itself
 * and keeps an elapsed-seconds line visible — waiting silently reads as a hang.
 * Failures land right under the button rather than in a global surface.
 */
export function SpawnSessionButton({
  beadId,
  projectPath,
  className,
  size = "sm",
  wrapperClassName,
}: SpawnSessionButtonProps) {
  const { canSpawn, isSpawning, elapsedSeconds, error, spawn } = useSessionSpawn({
    beadId,
    projectPath,
  });

  if (!canSpawn) return null;

  return (
    <div className={cn("flex flex-col items-stretch gap-1", wrapperClassName)}>
      <Button
        variant="outline"
        size={size}
        disabled={isSpawning}
        aria-label={`Start Claude session for ${beadId}`}
        onClick={(e) => {
          e.stopPropagation();
          void spawn();
        }}
        className={className}
      >
        {isSpawning ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Bot className="size-3.5" aria-hidden="true" />
        )}
        {isSpawning ? `Starting… ${elapsedSeconds}s` : "Claude session"}
      </Button>

      {isSpawning && (
        <p role="status" className="text-[10px] leading-snug text-t-muted">
          Creating the worktree and starting Claude — this usually takes about
          40 seconds.
        </p>
      )}

      {error && (
        <p role="alert" className="text-[10px] leading-snug text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
