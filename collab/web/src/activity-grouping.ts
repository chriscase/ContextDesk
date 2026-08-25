/**
 * One record, one row in the primary reading path.
 *
 * The committed projection already collapses rows describing one recorded
 * action written under more than one event kind. What reaches Overview can
 * still repeat: importing one analysis and then comparing it writes several
 * entries that say the same thing about the same record, moments apart, and
 * ten slots of "Latest activity" filled with the same imported analysis crowd
 * out the operational story the panel exists to tell. The same repetition
 * inflates "Open threads", so one item looks like several pieces of open work.
 *
 * Grouping here is presentational and deliberately conservative. Two rows are
 * the same recorded activity only when they agree on the investigation, the
 * activity kind, the words shown, the record they open, who acted, and where
 * the record came from. Anything that differs on any of those stays its own
 * row — including the same action genuinely performed twice by two people, or
 * with two different provenances.
 *
 * Nothing is hidden: the representative row is the newest, and it carries how
 * many times the record was written, so a repeat is stated rather than
 * silently dropped.
 */

export interface GroupableActivity {
  activityId: string;
  occurredAt: string;
  actorLabel: string;
  investigationId: string;
  summary: string;
  resolvedRoute: string;
  provenanceClass: string;
  activityKind?: string;
}

export type GroupedActivity<T extends GroupableActivity> = T & {
  /** How many recorded rows this one row stands for. Always at least 1. */
  repeatCount: number;
  /** When the earliest of them was recorded, when there is more than one. */
  earliestOccurredAt: string | null;
};

function identity(item: GroupableActivity): string {
  return JSON.stringify([
    item.investigationId,
    item.activityKind ?? "",
    item.summary,
    item.resolvedRoute,
    item.actorLabel,
    item.provenanceClass,
  ]);
}

/**
 * Collapses repeats of one recorded activity, newest first, order preserved.
 *
 * The input is expected newest-first, as the feed publishes it; the first row
 * of a group is kept as its representative so the row a reader opens is the
 * most recent one.
 */
export function groupRepeatedActivity<T extends GroupableActivity>(
  items: readonly T[],
): GroupedActivity<T>[] {
  const byIdentity = new Map<string, GroupedActivity<T>>();
  const order: GroupedActivity<T>[] = [];
  for (const item of items) {
    const key = identity(item);
    const existing = byIdentity.get(key);
    if (!existing) {
      const row: GroupedActivity<T> = { ...item, repeatCount: 1, earliestOccurredAt: null };
      byIdentity.set(key, row);
      order.push(row);
      continue;
    }
    existing.repeatCount += 1;
    // Input is newest-first, so a later row is older; keep the oldest stamp
    // that is actually smaller, rather than assuming the ordering holds.
    const candidate = existing.earliestOccurredAt ?? existing.occurredAt;
    existing.earliestOccurredAt = item.occurredAt < candidate ? item.occurredAt : candidate;
  }
  return order;
}

/** How a grouped row states its repeats, or null when it stands for one. */
export function repeatLabel(item: { repeatCount: number }): string | null {
  if (item.repeatCount < 2) return null;
  return `recorded ${item.repeatCount} times`;
}
