"use client";

import { useCallback, useEffect, useState } from "react";

import { RotateCcw } from "lucide-react";

import { dolt, type IgnoredDatabase } from "@/lib/api";

/**
 * Скрытые Dolt-базы и кнопка вернуть.
 *
 * Таблица `ignored_databases` наполняется при удалении проекта и до сих пор
 * никак не показывалась: удалённый проект исчезал бесследно, а автосинк молча
 * отказывался заводить его обратно. Единственным способом починить это был
 * прямой SQL по `%APPDATA%/beads/kanban-ui/data/settings.db` (bweb-1ih).
 */
export function IgnoredDatabasesPanel() {
  const [entries, setEntries] = useState<IgnoredDatabase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { ignored } = await dolt.ignored();
      setEntries(ignored);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load hidden databases");
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (name: string) => {
    setRestoring(name);
    try {
      await dolt.unignore(name);
      // Список перечитывается с сервера, а не правится локально: снятие идёт по
      // имени без учёта регистра, и какая именно строка исчезла, знает сервер.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restore the database");
    } finally {
      setRestoring(null);
    }
  };

  if (entries === null) {
    return (
      <div className="rounded-lg border border-b-default bg-surface-raised/50 p-4">
        <div className="h-4 w-40 animate-pulse rounded bg-surface-overlay" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-b-default bg-surface-raised/50 p-4">
      {error && (
        <p className="mb-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="text-sm text-t-tertiary">
          Скрытых баз нет — автосинк заводит все базы центрального сервера.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.dbName} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-t-primary">{entry.dbName}</p>
                <p className="text-sm text-t-tertiary tabular-nums">
                  скрыта {formatIgnoredAt(entry.ignoredAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void restore(entry.dbName)}
                disabled={restoring === entry.dbName}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-b-default px-3 py-1.5 text-sm text-t-secondary hover:bg-surface-overlay disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
                Вернуть
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Дата удаления человеческим видом; неразобранную строку показываем как есть —
 * она полезнее пустого места.
 */
function formatIgnoredAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}
