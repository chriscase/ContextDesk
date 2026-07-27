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

/** Resize visible capacity without inventing automatic first-N source assignment. */
export function resizeLaneList(
  existing: LaneConfig[],
  count: number,
): LaneConfig[] {
  const n = Math.max(1, Math.min(4, count));
  const next = existing.slice(0, 4);
  if (next.length >= n) return next;
  while (next.length < n) {
    const i = next.length;
    next.push(
      i === 0
        ? { ...DEFAULT_LANE }
        : { id: `lane-${i}`, label: `Lane ${i + 1}`, sources: [] },
    );
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

/**
 * Compose a lane's source-group filter with the global source filter.
 *
 * Empty lane membership means "all sources"; empty global membership means
 * "all sources". When both are non-empty, the effective query is their
 * intersection. An empty returned array intentionally means "matches no
 * sources" and must be handled by the caller before sending a backend query,
 * because the backend's empty Vec semantics are "no source filter".
 */
export function composeLaneSources(
  laneSources: string[],
  globalSources: string[],
): string[] | undefined {
  if (laneSources.length === 0 && globalSources.length === 0) {
    return undefined;
  }
  if (laneSources.length === 0) {
    return [...globalSources];
  }
  if (globalSources.length === 0) {
    return [...laneSources];
  }
  const global = new Set(globalSources);
  return laneSources.filter((source) => global.has(source));
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
