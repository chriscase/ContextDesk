/** Log Explorer shared types (#480). */

export type TimeQuality = "wall" | "mixed" | "order_only";

export type LaneTimeState = {
  status: "unloaded" | "loaded" | "empty" | "error";
  quality: TimeQuality | null;
};

const TIME_QUALITY_RANK: Record<TimeQuality, number> = {
  wall: 0,
  mixed: 1,
  order_only: 2,
};

export function leastReliableTimeQuality(
  qualities: TimeQuality[],
): TimeQuality {
  if (qualities.length === 0) return "order_only";
  return qualities.reduce((least, quality) =>
    TIME_QUALITY_RANK[quality] > TIME_QUALITY_RANK[least] ? quality : least,
  );
}

/** Return the least trustworthy quality; unknown lanes fail closed. */
export function aggregateLaneTimeQuality(
  laneIds: string[],
  states: Record<string, LaneTimeState>,
): TimeQuality {
  if (laneIds.length === 0) return "order_only";
  const qualities: TimeQuality[] = [];
  for (const laneId of laneIds) {
    const state = states[laneId];
    if (state?.status !== "loaded" || state.quality == null) {
      return "order_only";
    }
    qualities.push(state.quality);
  }
  return leastReliableTimeQuality(qualities);
}

export type ExplorerFilters = {
  levels: string[];
  sources: string[];
  services: string[];
  hosts: string[];
  timeFrom: number | null;
  timeTo: number | null;
  keyword: string | null;
};

export type LaneConfig = {
  id: string;
  label: string;
  sources: string[];
};

export type LogNavAction = {
  type: "log_nav";
  corpusId: string;
  sources?: string[];
  levels?: string[];
  tsFrom?: number | null;
  tsTo?: number | null;
  highlightSeq?: number[];
  focusLane?: string | null;
  label?: string | null;
};

export type LogNavApplyResult = {
  filters: ExplorerFilters;
  highlightSeq: number[];
  focusLane: string | null;
  label: string | null;
  corpusMatch: boolean;
};

export type Density = "comfortable" | "compact";

export type Breakpoint = "narrow" | "normal" | "ultrawide";

export function emptyFilters(): ExplorerFilters {
  return {
    levels: [],
    sources: [],
    services: [],
    hosts: [],
    timeFrom: null,
    timeTo: null,
    keyword: null,
  };
}

export function classifyBreakpoint(width: number): Breakpoint {
  if (width < 900) return "narrow";
  if (width >= 1600) return "ultrawide";
  return "normal";
}

export function timeQualityLabel(q: TimeQuality): string {
  switch (q) {
    case "wall":
      return "wall clock";
    case "mixed":
      return "mixed time quality";
    case "order_only":
      return "order only (not calendar time)";
  }
}

/** Canonical UTC timestamp string (full precision, no locale). */
export function formatCanonicalUtc(ts: number): string {
  try {
    return new Date(ts * 1000).toISOString().replace("T", " ");
  } catch {
    return String(ts);
  }
}

/**
 * Adaptive visible time for dense rows (#535).
 * Same UTC day → HH:mm:ss; multi-day → MM-DD HH:mm:ss; multi-year → full date+time.
 * Order-only never fabricates calendar time.
 */
export function formatEventTime(
  ts: number,
  quality: TimeQuality,
  opts?: { minTs?: number; maxTs?: number },
): string {
  if (quality === "order_only" || ts < 946_684_800) {
    return `ord ${ts}`;
  }
  if (quality === "mixed" && ts < 946_684_800) {
    return `ord ${ts}`;
  }
  try {
    const d = new Date(ts * 1000);
    const iso = d.toISOString(); // always UTC
    const hhmmss = iso.slice(11, 19);
    const ymd = iso.slice(0, 10);
    const min = opts?.minTs;
    const max = opts?.maxTs;
    if (min != null && max != null && min >= 946_684_800 && max >= 946_684_800) {
      const a = new Date(min * 1000).toISOString();
      const b = new Date(max * 1000).toISOString();
      const sameDay = a.slice(0, 10) === b.slice(0, 10);
      const sameYear = a.slice(0, 4) === b.slice(0, 4);
      if (sameDay) {
        // Prefer discriminating time-of-day for single-day investigations.
        return `${hhmmss}Z`;
      }
      if (sameYear) {
        return `${ymd.slice(5)} ${hhmmss}Z`; // MM-DD HH:mm:ssZ
      }
    }
    return `${ymd} ${hhmmss}Z`;
  } catch {
    return String(ts);
  }
}

/** Accessible full timestamp title including quality. */
export function formatEventTimeTitle(ts: number, quality: TimeQuality): string {
  if (quality === "order_only" || ts < 946_684_800) {
    return `order-only seq-time ${ts} (not calendar time)`;
  }
  return `${formatCanonicalUtc(ts)} · ${timeQualityLabel(quality)} · UTC`;
}
