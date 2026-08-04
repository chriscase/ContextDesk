/**
 * User-composed evidence lanes (#486).
 * Empty `sources` means "all sources" (intersected with global filters).
 */

export type LaneConfig = {
  id: string;
  label: string;
  sources: string[];
  /** Last deliberate specific membership, retained while All sources is active. */
  rememberedSources?: string[];
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
  return {
    ...lane,
    sources,
    label,
    rememberedSources:
      sources.length > 0 ? [...sources] : [...lane.sources],
  };
}

/** Activate All sources without discarding the prior specific composition. */
export function selectAllLaneSources(lane: LaneConfig): LaneConfig {
  if (lane.sources.length === 0) return lane;
  return {
    ...lane,
    label: "All sources",
    sources: [],
    rememberedSources: [...lane.sources],
  };
}

/** Restore the last specific composition, when one has been remembered. */
export function restoreSpecificLaneSources(lane: LaneConfig): LaneConfig {
  const sources = [
    ...new Set(
      (lane.rememberedSources ?? []).filter((source) => source.length > 0),
    ),
  ];
  if (sources.length === 0) return lane;
  return {
    ...lane,
    sources,
    rememberedSources: [...sources],
    label: sources.length === 1 ? sources[0]! : `${sources.length} sources`,
  };
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
        rememberedSources: Array.isArray(l.rememberedSources)
          ? l.rememberedSources.filter((s) => typeof s === "string")
          : undefined,
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

const VISIBLE_COUNT_PREFIX = "contextdesk.logExplorer.visibleLaneCount.v1:";
const HIGHLIGHT_PREFIX = "contextdesk.logExplorer.evidenceHighlights.v1:";

/** Custom event: live Explorer windows must adopt Evidence · N lane placement. */
export const EVIDENCE_LANE_APPLY_EVENT = "contextdesk.evidence-lanes.apply";

export type EvidenceLaneApplyDetail = {
  corpusId: string;
  lanes: LaneConfig[];
  visibleLaneCount: number;
  linkMode: TimeLinkMode;
  highlightSeqs: number[];
};

export function loadVisibleLaneCount(corpusId: string): number | null {
  try {
    const raw = localStorage.getItem(VISIBLE_COUNT_PREFIX + corpusId);
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(4, Math.floor(n)));
  } catch {
    return null;
  }
}

export function saveVisibleLaneCount(
  corpusId: string,
  count: number,
): void {
  try {
    const n = Math.max(1, Math.min(4, Math.floor(count)));
    localStorage.setItem(VISIBLE_COUNT_PREFIX + corpusId, String(n));
  } catch {
    /* ignore */
  }
}

export function loadEvidenceHighlights(corpusId: string): number[] {
  try {
    const raw = localStorage.getItem(HIGHLIGHT_PREFIX + corpusId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => Number(x))
      .filter((n) => Number.isSafeInteger(n) && n >= 0);
  } catch {
    return [];
  }
}

export function saveEvidenceHighlights(
  corpusId: string,
  seqs: number[],
): void {
  try {
    localStorage.setItem(
      HIGHLIGHT_PREFIX + corpusId,
      JSON.stringify(
        seqs.filter((n) => Number.isSafeInteger(n) && n >= 0).slice(0, 64),
      ),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Persist placement only (lanes, visible count, link mode, highlights).
 * Cross-window notify is `broadcastEvidenceLanesApply` / full
 * `applyEvidenceLanesToExplorer` in evidenceLaneApplyBridge.
 */
export function persistEvidenceLanesPlacement(
  detail: EvidenceLaneApplyDetail,
): EvidenceLaneApplyDetail {
  const lanes = detail.lanes.slice(0, 4).map((l) => ({
    ...l,
    sources: [...l.sources],
  }));
  const visibleLaneCount = Math.max(
    1,
    Math.min(4, Math.floor(detail.visibleLaneCount)),
  );
  const highlightSeqs = [...detail.highlightSeqs];
  const applied: EvidenceLaneApplyDetail = {
    corpusId: detail.corpusId,
    lanes,
    visibleLaneCount,
    linkMode: detail.linkMode,
    highlightSeqs,
  };
  saveLanes(applied.corpusId, applied.lanes);
  saveVisibleLaneCount(applied.corpusId, applied.visibleLaneCount);
  saveLinkMode(applied.corpusId, applied.linkMode);
  saveEvidenceHighlights(applied.corpusId, applied.highlightSeqs);
  return applied;
}
