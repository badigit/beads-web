"use client";

/**
 * Spawn a Claude Desktop session for a single bead.
 *
 * `POST /api/session/spawn` creates the worktree, runs a headless `claude -p`
 * inside it and hands the resulting session to Claude Desktop. A measured run
 * takes ~35 seconds, so this hook also exposes an elapsed-seconds counter: the
 * button needs to prove it is still working, otherwise the user assumes it
 * hung and starts clicking again.
 *
 * The server answers 409 to a concurrent spawn of the same repo+bead pair, but
 * a second click of one's own button must never surface as an error — the
 * in-flight ref below blocks it before the request is made.
 */

import { useState, useRef, useEffect, useCallback } from "react";

import { toast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import { isDoltProject } from "@/lib/utils";

/** Inputs identifying which bead the session is spawned for. */
export interface UseSessionSpawnArgs {
  beadId: string;
  /** Project root. `undefined` or `dolt://…` means "no filesystem repo". */
  projectPath?: string;
}

/** Result type for the `useSessionSpawn` hook. */
export interface UseSessionSpawnResult {
  /** False for dolt-only / unknown paths — the server would answer 403. */
  canSpawn: boolean;
  /** True from the click until the request settles. */
  isSpawning: boolean;
  /** Seconds since the current spawn started (0 while idle). */
  elapsedSeconds: number;
  /** Last failure, shown next to the button. Cleared on retry. */
  error: string | null;
  /** Start a spawn. Silently ignored while one is already in flight. */
  spawn: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Could not start the session. Is Claude Desktop installed?";
}

export function useSessionSpawn({
  beadId,
  projectPath,
}: UseSessionSpawnArgs): UseSessionSpawnResult {
  const [isSpawning, setIsSpawning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const canSpawn = !!projectPath && !isDoltProject(projectPath);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isSpawning) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isSpawning]);

  const spawn = useCallback(async () => {
    if (!canSpawn || inFlightRef.current) return;

    inFlightRef.current = true;
    setIsSpawning(true);
    setElapsedSeconds(0);
    setError(null);

    try {
      const result = await api.session.spawn({
        project_path: projectPath!,
        bead_id: beadId,
      });
      // eslint-disable-next-line no-console
      console.info("Session spawned", {
        bead_id: beadId,
        session_id: result.session_id,
        branch: result.branch,
        worktree_already_existed: result.worktree_already_existed,
        duration_ms: result.duration_ms,
      });
      toast({
        title: "Session started in Claude Desktop",
        description: `${beadId} — branch ${result.branch}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Session spawn failed", { bead_id: beadId, error: err });
      if (mountedRef.current) setError(errorMessage(err));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setIsSpawning(false);
        setElapsedSeconds(0);
      }
    }
  }, [canSpawn, projectPath, beadId]);

  return { canSpawn, isSpawning, elapsedSeconds, error, spawn };
}
