/**
 * Build one bounded, shared event-time row model for visible evidence lanes.
 *
 * Rows are keyed by exact timestamp plus occurrence index. If two lanes have an
 * event at the same timestamp, those events occupy the same visual row. A lane
 * without an event at that timestamp receives an explicit null cell—not a fake
 * log event. Duplicate same-time events in one lane receive stable additional
 * rows.
 */

export type AlignableEvent = {
  seq: number;
  ts: number;
};

export type AlignedLaneRow<T extends AlignableEvent> = {
  key: string;
  ts: number;
  event: T | null;
  height: number;
};

export type AlignedLaneInput<T extends AlignableEvent> = {
  id: string;
  events: T[];
};

export function buildAlignedLaneRows<T extends AlignableEvent>(
  lanes: AlignedLaneInput<T>[],
  rowHeight: (event: T) => number,
  emptyRowHeight: number,
): Record<string, AlignedLaneRow<T>[]> {
  const byTimestamp = new Map<number, Map<string, T[]>>();

  for (const lane of lanes) {
    for (const event of lane.events) {
      const byLane = byTimestamp.get(event.ts) ?? new Map<string, T[]>();
      const laneEvents = byLane.get(lane.id) ?? [];
      laneEvents.push(event);
      byLane.set(lane.id, laneEvents);
      byTimestamp.set(event.ts, byLane);
    }
  }

  const result = Object.fromEntries(
    lanes.map((lane) => [lane.id, [] as AlignedLaneRow<T>[]]),
  );
  const timestamps = [...byTimestamp.keys()].sort((a, b) => a - b);

  for (const ts of timestamps) {
    const byLane = byTimestamp.get(ts)!;
    const occurrences = Math.max(
      1,
      ...lanes.map((lane) => byLane.get(lane.id)?.length ?? 0),
    );
    for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
      const events = lanes
        .map((lane) => byLane.get(lane.id)?.[occurrence] ?? null)
        .filter((event): event is T => event != null);
      const height = Math.max(
        emptyRowHeight,
        ...events.map((event) => rowHeight(event)),
      );
      const key = `${ts}:${occurrence}`;
      for (const lane of lanes) {
        result[lane.id]!.push({
          key,
          ts,
          event: byLane.get(lane.id)?.[occurrence] ?? null,
          height,
        });
      }
    }
  }

  return result;
}
