/**
 * Tri-state label filtering for the board.
 *
 * A label is either ignored, required (OR across all required labels), or
 * excluded. One menu row cycles through the three states, so the same list
 * expresses "anything tagged X" and "everything except Y" without a second
 * control.
 */

export type LabelFilterState = "off" | "include" | "exclude";

/** Current state of `label` given the two filter lists. */
export function labelFilterState(
  label: string,
  labels: string[],
  excludeLabels: string[]
): LabelFilterState {
  if (labels.includes(label)) return "include";
  if (excludeLabels.includes(label)) return "exclude";
  return "off";
}

/**
 * Next filter lists after activating `label`: off → include → exclude → off.
 *
 * Returns fresh arrays; a label is never in both lists at once.
 */
export function cycleLabelFilter(
  label: string,
  labels: string[],
  excludeLabels: string[]
): { labels: string[]; excludeLabels: string[] } {
  const state = labelFilterState(label, labels, excludeLabels);
  const withoutInclude = labels.filter((l) => l !== label);
  const withoutExclude = excludeLabels.filter((l) => l !== label);

  if (state === "off") {
    return { labels: [...withoutInclude, label], excludeLabels: withoutExclude };
  }
  if (state === "include") {
    return { labels: withoutInclude, excludeLabels: [...withoutExclude, label] };
  }
  return { labels: withoutInclude, excludeLabels: withoutExclude };
}

/** Drops `label` from both lists, whatever state it was in. */
export function clearLabelFilter(
  label: string,
  labels: string[],
  excludeLabels: string[]
): { labels: string[]; excludeLabels: string[] } {
  return {
    labels: labels.filter((l) => l !== label),
    excludeLabels: excludeLabels.filter((l) => l !== label),
  };
}
