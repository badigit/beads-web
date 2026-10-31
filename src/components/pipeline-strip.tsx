'use client';

import type { PipelineStage } from '@/lib/pipeline-stages';
import { cn } from '@/lib/utils';

export function PipelineStrip({ stages, selected, onSelect }: {
  stages: PipelineStage[];
  selected: string[];
  onSelect: (status: string) => void;
}) {
  return (
    <div role="group" aria-label="Pipeline stages" className="flex gap-2 overflow-x-auto px-4 pb-3">
      {stages.map(stage => (
        <button
          key={stage.status}
          type="button"
          aria-label={`${stage.title}, ${stage.count} ${stage.count === 1 ? 'issue' : 'issues'}`}
          data-category={stage.category}
          aria-pressed={selected.includes(stage.status)}
          onClick={() => onSelect(stage.status)}
          className={cn('min-w-32 shrink-0 rounded-md border border-b-default bg-surface-raised px-3 py-2 text-left',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selected.includes(stage.status) && 'border-info bg-info/10')}
        >
          <span className="flex items-baseline justify-between gap-3 text-sm font-medium">
            <span>{stage.title}</span><span className="tabular-nums">{stage.count}</span>
          </span>
          <span className="block whitespace-nowrap text-xs text-t-muted">
            {stage.types.map(([type, count]) => `${count} ${type}`).join(' · ') || '0 tasks'}
          </span>
        </button>
      ))}
    </div>
  );
}
