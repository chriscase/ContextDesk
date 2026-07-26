/**
 * User-composed evidence lanes (#486).
 * Empty `sources` means "all sources" (intersected with global filters).
 */

export type LaneConfig = {
  id: string;
  label: string;
  sources: string[];
};

export type TimeLinkMode = "independent" | "follow_cursor" | "align_time";

export const DEFAULT_LANE: LaneConfig = {
  id: "lane-0",
  label: "All sources",
  sources: [],
};

const STORAGE_PREFIX = "contextdesk.logExplorer.lanes.v1:";

export function defaultLanes(count: number): LaneConfig[] {
  const n = Math.max(1, Math.min(4, count));
  return Array.from({ length: n }, (_, i) =>
    i === 0
      ? { ...DEFAULT_LANE }
      : { id: `lane-${i}`, label: `Lane ${i + 1}`, sources: [] },
  );
}

/** Resize lane list without inventing automatic first-N source assignment. */
export function resizeLaneList(
  existing: LaneConfig[],
  count: number,
): LaneConfig[] {
  const n = Math.max(1, Math.min(4, count));
  if (existing.length === n) return existing;
  if (existing.length > n) return existing.slice(0, n);
  const next = [...existing];
  while (next.length < n) {
    const i = next.length;
    next.push({ id: `lane-${i}`, label: `Lane ${i + 1}`, sources: [] });
  }
  return next;
}

export function toggleLaneSource(
  lane: LaneConfig,
  source: string,
): LaneConfig {
  const has = lane.sources.includes(source);
  const sources = has
    ? lane.sources.filter((s) => s !== source)
    : [...lane.sources, source];
  // Empty set = all sources.
  const label =
    sources.length === 0
      ? lane.label === DEFAULT_LANE.label || lane.sources.length > 0
        ? "All sources"
        : lane.label
      : sources.length === 1
        ? sources[0]!
        : `${sources.length} sources`;
  return { ...lane, sources, label };
}

export function loadLanes(corpusId: string): LaneConfig[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + corpusId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LaneConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed
      .slice(0, 4)
      .map((l, i) => ({
        id: typeof l.id === "string" ? l.id : `lane-${i}`,
        label: typeof l.label === "string" ? l.label : `Lane ${i + 1}`,
        sources: Array.isArray(l.sources)
          ? l.sources.filter((s) => typeof s === "string")
          : [],
      }));
  } catch {
    return null;
  }
}

export function saveLanes(corpusId: string, lanes: LaneConfig[]): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + corpusId, JSON.stringify(lanes));
  } catch {
    /* ignore */
  }
}

export function loadLinkMode(corpusId: string): TimeLinkMode {
  try {
    const v = localStorage.getItem(
      `contextdesk.logExplorer.linkMode.v1:${corpusId}`,
    );
    if (v === "independent" || v === "follow_cursor" || v === "align_time") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "independent";
}

export function saveLinkMode(corpusId: string, mode: TimeLinkMode): void {
  try {
    localStorage.setItem(
      `contextdesk.logExplorer.linkMode.v1:${corpusId}`,
      mode,
    );
  } catch {
    /* ignore */
  }
}
