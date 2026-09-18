"use client";

import { useState } from "react";

import { CalendarClock, Clock, PauseCircle } from "lucide-react";

import * as api from "@/lib/api";
import { formatShortDate } from "@/lib/bead-utils";
import { cn } from "@/lib/utils";
import type { Bead } from "@/types";

/**
 * Три поля расписания бида: срок, отсрочка и оценка.
 *
 * Значения уезжают в `bd update` в его собственных форматах (`+1d`,
 * `tomorrow`, `2026-01-15`) — разбор человеческого ввода остаётся за bd, иначе
 * в проекте появилась бы вторая реализация тех же форматов (bweb-717).
 *
 * Пустое место не занимается: незаполненное поле видно только как узкая кнопка
 * «добавить», и только когда правка вообще доступна.
 */

type ScheduleField = "due" | "defer" | "estimate";

const FIELDS: { key: ScheduleField; label: string; hint: string; icon: typeof Clock }[] = [
  { key: "due", label: "Срок", hint: "+1d, tomorrow, 2026-01-15", icon: CalendarClock },
  { key: "defer", label: "Отложено до", hint: "+6h, next monday, 2026-01-15", icon: PauseCircle },
  { key: "estimate", label: "Оценка", hint: "минуты, например 90", icon: Clock },
];

export interface ScheduleFieldsProps {
  bead: Bead;
  projectPath?: string;
  /** `dolt://`-проект: bd недоступен, поля только на чтение. */
  readOnly?: boolean;
  onUpdated?: () => void;
}

export function ScheduleFields({ bead, projectPath, readOnly, onUpdated }: ScheduleFieldsProps) {
  const [editing, setEditing] = useState<ScheduleField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = !readOnly && Boolean(projectPath);

  const startEditing = (field: ScheduleField) => {
    setEditing(field);
    // Дата в поле ввода бесполезна как есть: bd ждёт свой формат, а не то, что
    // он сам отдал. Правка всегда начинается с пустой строки.
    setDraft(field === "estimate" ? estimateInputValue(bead) : "");
    setError(null);
  };

  const save = async (field: ScheduleField, reason: "enter" | "blur") => {
    if (!projectPath) return;
    const raw = draft.trim();

    // Снятие значения — только явным действием. Уход фокусом с пустого поля
    // это отмена: иначе один клик мимо стирал бы уже проставленный срок.
    if (raw === "" && reason === "blur") {
      setEditing(null);
      setError(null);
      return;
    }

    // Пустое поле по Enter — это снятие: у оценки снятие и есть ноль.
    if (field === "estimate" && raw !== "" && !isValidEstimate(raw)) {
      setError("Оценка — целое число минут, 0 снимает её");
      return;
    }

    setSaving(true);
    try {
      await api.beads.update({
        path: projectPath,
        id: bead.id,
        // Пустая строка — это «снять значение», ровно так её понимает bd.
        // У оценки снятия нет: `--estimate 0` записывает ноль, а не NULL,
        // поэтому ноль и считается «оценки нет» на показе (проверено на bd 1.1.0).
        ...(field === "estimate" ? { estimate: raw === "" ? 0 : Number(raw) } : { [field]: raw }),
      });
      setEditing(null);
      setError(null);
      onUpdated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  };

  const filled = FIELDS.filter((field) => displayValue(bead, field.key) !== null);
  const empty = canEdit ? FIELDS.filter((field) => displayValue(bead, field.key) === null) : [];

  if (filled.length === 0 && empty.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      {filled.map(({ key, label, hint, icon: Icon }) => (
        <div key={key} className="flex items-center gap-2 text-sm">
          <Icon className="size-3.5 shrink-0 text-t-tertiary" aria-hidden="true" />
          <span className="text-t-tertiary">{label}:</span>
          {editing === key ? (
            <ScheduleInput
              hint={hint}
              value={draft}
              disabled={saving}
              onChange={setDraft}
              onSubmit={(reason) => void save(key, reason)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => startEditing(key)}
              className={cn(
                "rounded px-1 tabular-nums text-t-primary",
                canEdit ? "hover:bg-surface-overlay" : "cursor-default"
              )}
            >
              {displayValue(bead, key)}
            </button>
          )}
        </div>
      ))}

      {empty.map(({ key, label, hint, icon: Icon }) =>
        editing === key ? (
          <div key={key} className="flex items-center gap-2 text-sm">
            <Icon className="size-3.5 shrink-0 text-t-tertiary" aria-hidden="true" />
            <span className="text-t-tertiary">{label}:</span>
            <ScheduleInput
              hint={hint}
              value={draft}
              disabled={saving}
              onChange={setDraft}
              onSubmit={(reason) => void save(key, reason)}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : null
      )}

      {empty.some(({ key }) => editing !== key) && (
        <div className="flex flex-wrap gap-1.5">
          {empty
            .filter(({ key }) => editing !== key)
            .map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => startEditing(key)}
                className="rounded-md border border-b-default px-2 py-0.5 text-xs text-t-tertiary hover:bg-surface-overlay"
              >
                + {label.toLowerCase()}
              </button>
            ))}
        </div>
      )}

      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ScheduleInput({
  hint,
  value,
  disabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (reason: "enter" | "blur") => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      aria-label={hint}
      placeholder={hint}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onSubmit("blur")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit("enter");
        }
        if (e.key === "Escape") onCancel();
      }}
      className="min-w-0 flex-1 rounded border border-b-default bg-surface-base px-1.5 py-0.5 text-sm text-t-primary focus:outline-none focus:ring-1 focus:ring-accent"
    />
  );
}

/**
 * Оценка задаётся целым числом минут; ноль допустим — он снимает оценку.
 *
 * Без этой проверки `90m` или `abc` превращались в `Number(...) || 0`, то есть
 * опечатка молча стирала существующую оценку (находка ревью).
 */
function isValidEstimate(raw: string): boolean {
  if (!/^\d+$/.test(raw)) return false;
  return Number.isSafeInteger(Number(raw));
}

/** Что показывать в строке поля; `null` — поля нет. */
function displayValue(bead: Bead, field: ScheduleField): string | null {
  if (field === "estimate") {
    const minutes = bead.estimated_minutes ?? 0;
    // Ноль — это «оценки нет»: снятие оценки в bd пишет именно ноль.
    return minutes > 0 ? formatMinutes(minutes) : null;
  }
  const value = field === "due" ? bead.due_at : bead.defer_until;
  return value ? formatShortDate(value) : null;
}

function estimateInputValue(bead: Bead): string {
  const minutes = bead.estimated_minutes ?? 0;
  return minutes > 0 ? String(minutes) : "";
}

/** 90 -> «1 ч 30 мин», 45 -> «45 мин». */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}
