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
const EVIDENCE_SNAPSHOT_PREFIX =
  "contextdesk.logExplorer.evidencePlacement.v2:";
const EVIDENCE_REVISION_PREFIX =
  "contextdesk.logExplorer.evidencePlacementRevision.v1:";

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
    // An ordinary Explorer edit supersedes any older Evidence · N snapshot.
    localStorage.removeItem(EVIDENCE_SNAPSHOT_PREFIX + corpusId);
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
    localStorage.removeItem(EVIDENCE_SNAPSHOT_PREFIX + corpusId);
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
  /** Corpus-scoped monotonic commit revision. Required on the cross-window wire. */
  revision: number;
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
    localStorage.removeItem(EVIDENCE_SNAPSHOT_PREFIX + corpusId);
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
    localStorage.removeItem(EVIDENCE_SNAPSHOT_PREFIX + corpusId);
  } catch {
    /* ignore */
  }
}

/**
 * Persist placement only (lanes, visible count, link mode, highlights).
 * Cross-window notify is `broadcastEvidenceLanesApply` / full
 * `applyEvidenceLanesToExplorer` in evidenceLaneApplyBridge.
 */
export type EvidenceLayoutSnapshot = Omit<EvidenceLaneApplyDetail, "revision">;

function storageKeys(corpusId: string): string[] {
  return [
    STORAGE_PREFIX + corpusId,
    VISIBLE_COUNT_PREFIX + corpusId,
    `contextdesk.logExplorer.linkMode.v1:${corpusId}`,
    HIGHLIGHT_PREFIX + corpusId,
    EVIDENCE_SNAPSHOT_PREFIX + corpusId,
    EVIDENCE_REVISION_PREFIX + corpusId,
  ];
}

/** Stable current-layout identity used as a compare-and-swap precondition. */
export function evidenceLayoutFingerprint(corpusId: string): string {
  return JSON.stringify({
    lanes: loadLanes(corpusId) ?? [],
    visibleLaneCount: loadVisibleLaneCount(corpusId),
    linkMode: loadLinkMode(corpusId),
    highlightSeqs: loadEvidenceHighlights(corpusId),
  });
}

function restoreStorage(
  previous: ReadonlyMap<string, string | null>,
): void {
  for (const [key, value] of previous) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
}

/** Read only a fully committed, versioned Evidence · N placement. */
export function loadEvidencePlacementSnapshot(
  corpusId: string,
): EvidenceLaneApplyDetail | null {
  try {
    const raw = localStorage.getItem(EVIDENCE_SNAPSHOT_PREFIX + corpusId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EvidenceLaneApplyDetail;
    if (
      parsed?.corpusId !== corpusId ||
      !Number.isSafeInteger(parsed.revision) ||
      parsed.revision < 1 ||
      !Array.isArray(parsed.lanes) ||
      !Array.isArray(parsed.highlightSeqs)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Commit all Evidence · N preferences as one versioned transaction. The single
 * snapshot is written last and is the cross-window commit marker. Any storage
 * failure restores every prior key and is reported to the caller.
 */
export function persistEvidenceLanesPlacement(
  detail: Omit<EvidenceLaneApplyDetail, "revision">,
  expectedLayoutFingerprint: string,
): EvidenceLaneApplyDetail {
  if (!detail.corpusId.trim() || [...detail.corpusId].length > 256) {
    throw new Error("Explorer evidence corpus identity is invalid or too large.");
  }
  if (detail.lanes.length < 1 || detail.lanes.length > 4) {
    throw new Error("Explorer evidence placement must contain one to four lanes.");
  }
  for (const lane of detail.lanes) {
    if (
      !lane.id.trim() ||
      [...lane.id].length > 256 ||
      !lane.label.trim() ||
      [...lane.label].length > 256 ||
      lane.sources.length > 256 ||
      (lane.rememberedSources?.length ?? 0) > 256 ||
      [...lane.sources, ...(lane.rememberedSources ?? [])].some(
        (source) =>
          !source.trim() || [...source].length > 1_024 || source.includes("\0"),
      )
    ) {
      throw new Error("Explorer evidence lane identity or source set is invalid or too large.");
    }
  }
  if (evidenceLayoutFingerprint(detail.corpusId) !== expectedLayoutFingerprint) {
    throw new Error(
      "Explorer layout changed after preview; review the current lanes and try again.",
    );
  }
  const lanes = detail.lanes.slice(0, 4).map((l) => ({
    ...l,
    sources: [...l.sources],
  }));
  const visibleLaneCount = Math.max(
    1,
    Math.min(4, Math.floor(detail.visibleLaneCount)),
  );
  const highlightSeqs = [...detail.highlightSeqs];
  const keys = storageKeys(detail.corpusId);
  const previous = new Map(
    keys.map((key) => [key, localStorage.getItem(key)] as const),
  );
  const priorRevision = Number(
    localStorage.getItem(EVIDENCE_REVISION_PREFIX + detail.corpusId) ?? "0",
  );
  if (priorRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Explorer evidence placement revision is exhausted.");
  }
  const revision = Number.isSafeInteger(priorRevision) && priorRevision >= 0
    ? priorRevision + 1
    : 1;
  const applied: EvidenceLaneApplyDetail = {
    corpusId: detail.corpusId,
    lanes,
    visibleLaneCount,
    linkMode: detail.linkMode,
    highlightSeqs,
    revision,
  };
  try {
    // Write legacy keys for the ordinary Explorer controls, then publish the
    // versioned snapshot last. Do not use the forgiving save* helpers here.
    localStorage.setItem(STORAGE_PREFIX + applied.corpusId, JSON.stringify(applied.lanes));
    localStorage.setItem(
      VISIBLE_COUNT_PREFIX + applied.corpusId,
      String(applied.visibleLaneCount),
    );
    localStorage.setItem(
      `contextdesk.logExplorer.linkMode.v1:${applied.corpusId}`,
      applied.linkMode,
    );
    localStorage.setItem(
      HIGHLIGHT_PREFIX + applied.corpusId,
      JSON.stringify(applied.highlightSeqs.slice(0, 64)),
    );
    localStorage.setItem(
      EVIDENCE_REVISION_PREFIX + applied.corpusId,
      String(applied.revision),
    );
    localStorage.setItem(
      EVIDENCE_SNAPSHOT_PREFIX + applied.corpusId,
      JSON.stringify(applied),
    );
    return applied;
  } catch (error) {
    try {
      restoreStorage(previous);
    } catch (rollbackError) {
      throw new Error(
        "Could not save Explorer evidence lanes, and storage rollback also failed.",
        { cause: rollbackError },
      );
    }
    throw new Error(
      `Could not save Explorer evidence lanes: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
