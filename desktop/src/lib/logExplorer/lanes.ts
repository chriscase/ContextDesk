/** Timestamp link + gap pure logic (mirrors cd-core lanes). */

export type LaneEventRef = { seq: number; ts: number };

export type GapRegion = {
  tsFrom: number;
  tsTo: number;
  emptyLaneIds: string[];
  filledLaneIds: string[];
};

export type PeerPosition = {
  laneId: string;
  seq: number | null;
  ts: number | null;
  deltaTs: number | null;
};

export type LinkScrubResult = {
  cursorTs: number;
  peerPositions: PeerPosition[];
  linked: boolean;
  refuseReason: string | null;
};

export function linkAllowed(quality: "wall" | "mixed" | "order_only"): string | null {
  if (quality === "order_only") {
    return "timestamp link requires wall-clock time; corpus is order-only (seq is not calendar time)";
  }
  return null;
}

export function exactAlignmentAllowed(
  quality: "wall" | "mixed" | "order_only",
): string | null {
  if (quality === "mixed") {
    return "exact alignment requires a reliable shared wall clock; corpus has mixed time quality";
  }
  if (quality === "order_only") {
    return "exact alignment requires a reliable shared wall clock; corpus is order-only";
  }
  return null;
}

export function nearestAtOrAfter(
  events: LaneEventRef[],
  cursorTs: number,
): LaneEventRef | null {
  if (events.length === 0) return null;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.ts < cursorTs) lo = mid + 1;
    else hi = mid;
  }
  if (lo < events.length) return events[lo]!;
  return events[events.length - 1]!;
}

export function scrubLinked(
  cursorTs: number,
  lanes: { id: string; events: LaneEventRef[] }[],
  quality: "wall" | "mixed" | "order_only",
): LinkScrubResult {
  const refuse = linkAllowed(quality);
  if (refuse) {
    return {
      cursorTs,
      peerPositions: lanes.map((l) => ({
        laneId: l.id,
        seq: null,
        ts: null,
        deltaTs: null,
      })),
      linked: false,
      refuseReason: refuse,
    };
  }
  return {
    cursorTs,
    peerPositions: lanes.map((l) => {
      const n = nearestAtOrAfter(l.events, cursorTs);
      return {
        laneId: l.id,
        seq: n?.seq ?? null,
        ts: n?.ts ?? null,
        deltaTs: n != null ? Math.abs(n.ts - cursorTs) : null,
      };
    }),
    linked: true,
    refuseReason: null,
  };
}

export function computeGaps(
  lanes: { id: string; events: LaneEventRef[] }[],
  windowFrom: number,
  windowTo: number,
  bucketSecs: number,
  quality: "wall" | "mixed" | "order_only",
): GapRegion[] | { error: string } {
  const refuse = exactAlignmentAllowed(quality);
  if (refuse) return { error: refuse };
  if (lanes.length === 0 || windowTo <= windowFrom) return [];
  const width = Math.max(1, bucketSecs);
  const gaps: GapRegion[] = [];
  for (let t = windowFrom; t < windowTo; t += width) {
    const end = Math.min(t + width, windowTo);
    const empty: string[] = [];
    const filled: string[] = [];
    for (const l of lanes) {
      const has = l.events.some((e) => e.ts >= t && e.ts < end);
      if (has) filled.push(l.id);
      else empty.push(l.id);
    }
    if (empty.length > 0 && filled.length > 0) {
      gaps.push({
        tsFrom: t,
        tsTo: end,
        emptyLaneIds: empty,
        filledLaneIds: filled,
      });
    }
  }
  return mergeAdjacent(gaps);
}

function mergeAdjacent(gaps: GapRegion[]): GapRegion[] {
  const out: GapRegion[] = [];
  for (const g of gaps) {
    const last = out[out.length - 1];
    if (
      last &&
      last.tsTo === g.tsFrom &&
      sameIds(last.emptyLaneIds, g.emptyLaneIds) &&
      sameIds(last.filledLaneIds, g.filledLaneIds)
    ) {
      last.tsTo = g.tsTo;
    } else {
      out.push({ ...g, emptyLaneIds: [...g.emptyLaneIds], filledLaneIds: [...g.filledLaneIds] });
    }
  }
  return out;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

export function clampLaneCount(n: number): number {
  return Math.min(4, Math.max(1, Math.floor(n)));
}
