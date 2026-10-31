import type { Bead, CustomStatus } from '@/types';

export const DEFAULT_STAGES = [
  { status: 'open', title: 'Open', category: 'active' },
  { status: 'in_progress', title: 'In Progress', category: 'wip' },
  { status: 'inreview', title: 'In Review', category: 'wip' },
  { status: 'closed', title: 'Closed', category: 'done' },
] as const;

export interface PipelineStage {
  status: string;
  title: string;
  category: string;
  count: number;
  types: [string, number][];
}

/** Include configured empty stages and observed unknown stages without inventing categories. */
export function buildPipelineStages(beads: Bead[], custom: CustomStatus[]): PipelineStage[] {
  const stages = new Map<string, PipelineStage>();
  for (const stage of DEFAULT_STAGES) {
    stages.set(stage.status, { ...stage, count: 0, types: [] });
  }
  for (const { name, category } of custom) {
    if (name === 'tombstone') continue;
    stages.set(name, { status: name, title: name, category, count: 0, types: [] });
  }
  const types = new Map<string, Map<string, number>>();
  for (const bead of beads) {
    const status = bead.status;
    if (!stages.has(status)) {
      stages.set(status, { status, title: status, category: 'unspecified', count: 0, types: [] });
    }
    stages.get(status)!.count++;
    const counts = types.get(status) ?? new Map<string, number>();
    const type = bead.issue_type || 'task';
    counts.set(type, (counts.get(type) ?? 0) + 1);
    types.set(status, counts);
  }
  return Array.from(stages.values()).map(stage => ({
    ...stage,
    types: Array.from(types.get(stage.status)?.entries() ?? []).sort(([a], [b]) => a.localeCompare(b)),
  }));
}
