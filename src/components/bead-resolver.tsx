"use client";

import { useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import * as api from "@/lib/api";
import { resolveBead, type BeadResolution } from "@/lib/bead-resolve";

export interface BeadResolverProps {
  /** The `?bead=` value from a link that carries no project uuid. */
  beadId: string;
}

/**
 * Screen for `/project?bead=<id>` — a bead link without the project uuid.
 *
 * Asks the global search which project owns the id and rewrites the address to
 * the canonical `/project?id=…&bead=…`, so every existing link, the board
 * state and the browser history keep working unchanged. Anything the search
 * cannot decide is shown rather than guessed: an unknown prefix says so, and
 * two projects answering to the same id become a choice.
 */
export function BeadResolver({ beadId }: BeadResolverProps) {
  const router = useRouter();
  const [resolution, setResolution] = useState<BeadResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const results = await api.search.query(beadId, controller.signal);
        if (cancelled) return;
        const next = resolveBead(results, beadId);
        setResolution(next);
        if (next.kind === "redirect") {
          router.replace(next.href);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        console.error("Bead resolution failed", { beadId, error: err });
        setError(err instanceof Error ? err.message : "Lookup failed");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [beadId, router]);

  if (error) {
    return (
      <Shell>
        <p role="alert" className="text-danger">
          Could not look up {beadId}: {error}
        </p>
        <BackToProjects />
      </Shell>
    );
  }

  if (!resolution || resolution.kind === "redirect") {
    return (
      <Shell>
        <p role="status" className="text-t-muted">
          Looking up {beadId}…
        </p>
      </Shell>
    );
  }

  if (resolution.kind === "choice") {
    return (
      <Shell>
        <p className="text-t-primary">
          {beadId} exists in {resolution.options.length} projects. Pick one:
        </p>
        <ul className="flex flex-col gap-2">
          {resolution.options.map((option) => (
            <li key={option.project_id}>
              <Button variant="outline" asChild>
                <a href={`/project?id=${encodeURIComponent(option.project_id as string)}&bead=${encodeURIComponent(option.bead_id)}`}>
                  {option.project_name}
                </a>
              </Button>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  if (resolution.kind === "unregistered") {
    return (
      <Shell>
        <p role="alert" className="text-t-muted text-pretty text-center">
          {beadId} lives in {resolution.databases.join(", ")}, which is not added as a project here.
        </p>
        <BackToProjects />
      </Shell>
    );
  }

  return (
    <Shell>
      <p role="alert" className="text-t-muted text-pretty text-center">
        No project has a bead called {beadId}. Check the id — its prefix is what picks the project.
      </p>
      <BackToProjects />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-base px-4">
      {children}
    </div>
  );
}

function BackToProjects() {
  return (
    <Button variant="outline" asChild>
      <a href="/">Back to projects</a>
    </Button>
  );
}
