export type GroupedOption = {
  value: string;
  label: string;
  /**
   * Optional heading to file this option under. Options with no group render loose at
   * the top, so a list where nothing is grouped looks exactly as it did before.
   */
  group?: string;
};

/**
 * Buckets options by their group, preserving first-seen order so grouping never
 * reshuffles the caller's list.
 *
 * Shared by Select and Combobox. Two copies would drift on the first list that mixed
 * grouped and ungrouped entries, which is precisely the case the ordering rule exists
 * for.
 */
export function byGroup<T extends GroupedOption>(
  options: T[],
): Array<[string | null, T[]]> {
  const groups = new Map<string | null, T[]>();
  for (const option of options) {
    const key = option.group ?? null;
    const existing = groups.get(key);
    if (existing) existing.push(option);
    else groups.set(key, [option]);
  }
  return [...groups.entries()];
}
