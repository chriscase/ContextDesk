/** Log Explorer shared types (#480). */

export type TimeQuality = "wall" | "mixed" | "order_only";

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

/** Format ts honestly for order_only vs wall. */
export function formatEventTime(ts: number, quality: TimeQuality): string {
  if (quality === "order_only" || ts < 946_684_800) {
    return `seq-time ${ts}`;
  }
  try {
    return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return String(ts);
  }
}
