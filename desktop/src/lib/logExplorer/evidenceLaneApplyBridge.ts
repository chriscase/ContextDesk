/**
 * Cross-window Evidence · N lane placement (mirrors timeRevisionBridge).
 *
 * Main chat and linked chat run in the main webview; Log Explorer often runs in
 * a separate Tauri `log-explorer-*` window. Same-window CustomEvent alone cannot
 * reach that Explorer. Persist to localStorage, then:
 *  - CustomEvent for in-app listeners
 *  - Tauri emit for standalone Explorer windows
 *  - Focus/visibility re-read of storage as a fail-closed backup
 */

import {
  EVIDENCE_LANE_APPLY_EVENT,
  loadEvidenceHighlights,
  loadLanes,
  loadLinkMode,
  loadVisibleLaneCount,
  persistEvidenceLanesPlacement,
  type EvidenceLaneApplyDetail,
  type LaneConfig,
  type TimeLinkMode,
} from "./laneCompose";

export { EVIDENCE_LANE_APPLY_EVENT };
export type { EvidenceLaneApplyDetail };

export type EvidenceLaneEmit = (
  eventName: string,
  payload: EvidenceLaneApplyDetail,
) => Promise<void>;

export type EvidenceLaneListen = (
  eventName: string,
  handler: (event: { payload: EvidenceLaneApplyDetail }) => void,
) => Promise<() => void>;

const MAX_SEEN_EVENT_IDS = 128;
const senderId =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `evidence-lane-${Date.now()}`;
let nextEventSequence = 0;

function createEventId(): string {
  nextEventSequence += 1;
  return `${senderId}:${nextEventSequence}`;
}

/** Wire payload may carry optional eventId for dedupe across CustomEvent+Tauri. */
export type EvidenceLaneApplyWire = EvidenceLaneApplyDetail & {
  eventId?: string;
};

function normalizeDetail(
  raw: EvidenceLaneApplyWire | EvidenceLaneApplyDetail | null | undefined,
): EvidenceLaneApplyDetail | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.corpusId !== "string" || !raw.corpusId.trim()) return null;
  if (!Array.isArray(raw.lanes)) return null;
  const lanes: LaneConfig[] = raw.lanes.slice(0, 4).map((l, i) => ({
    id: typeof l?.id === "string" ? l.id : `lane-${i}`,
    label: typeof l?.label === "string" ? l.label : `Lane ${i + 1}`,
    sources: Array.isArray(l?.sources)
      ? l.sources.filter((s): s is string => typeof s === "string")
      : [],
    rememberedSources: Array.isArray(l?.rememberedSources)
      ? l.rememberedSources.filter((s): s is string => typeof s === "string")
      : undefined,
  }));
  const visibleLaneCount = Math.max(
    1,
    Math.min(4, Math.floor(Number(raw.visibleLaneCount) || 1)),
  );
  const linkMode: TimeLinkMode =
    raw.linkMode === "follow_cursor" || raw.linkMode === "align_time"
      ? raw.linkMode
      : "independent";
  const highlightSeqs = Array.isArray(raw.highlightSeqs)
    ? raw.highlightSeqs
        .map((n) => Number(n))
        .filter((n) => Number.isSafeInteger(n) && n >= 0)
        .slice(0, 64)
    : [];
  return {
    corpusId: raw.corpusId.trim(),
    lanes,
    visibleLaneCount,
    linkMode,
    highlightSeqs,
  };
}

/**
 * Pure: map an apply detail (or storage snapshot) into Explorer state fields.
 * Tests and LogExplorer both call this so the adopt path is one function.
 */
export function evidencePlacementToExplorerState(
  detail: EvidenceLaneApplyDetail,
): {
  lanes: LaneConfig[];
  preferredLaneCount: number;
  laneCount: number;
  linkMode: TimeLinkMode;
  highlightSeqs: number[];
} {
  const lanes =
    detail.lanes.length > 0
      ? detail.lanes.map((l) => ({
          ...l,
          sources: [...l.sources],
        }))
      : [
          {
            id: "lane-0",
            label: "All sources",
            sources: [] as string[],
          },
        ];
  const preferredLaneCount = Math.max(
    1,
    Math.min(4, detail.visibleLaneCount),
  );
  return {
    lanes,
    preferredLaneCount,
    laneCount: preferredLaneCount,
    linkMode: detail.linkMode,
    highlightSeqs: [...detail.highlightSeqs],
  };
}

/**
 * LogExplorer live-adopt entry: same function the component uses.
 * Returns null when corpus does not match (session isolation).
 */
export function adoptEvidencePlacementForExplorer(
  explorerCorpusId: string,
  maxLaneCount: number,
  detail: EvidenceLaneApplyDetail,
): {
  lanes: LaneConfig[];
  preferredLaneCount: number;
  laneCount: number;
  linkMode: TimeLinkMode;
  highlightSeqs: number[];
} | null {
  if (detail.corpusId !== explorerCorpusId) return null;
  const next = evidencePlacementToExplorerState(detail);
  const max = Math.max(1, Math.min(4, Math.floor(maxLaneCount) || 1));
  return {
    ...next,
    laneCount: Math.min(next.laneCount, max),
  };
}

/** Cold open / focus backup: rebuild placement from durable storage only. */
export function loadEvidencePlacementFromStorage(
  corpusId: string,
): EvidenceLaneApplyDetail | null {
  const lanes = loadLanes(corpusId);
  if (!lanes || lanes.length === 0) return null;
  const visible =
    loadVisibleLaneCount(corpusId) ?? Math.min(4, Math.max(1, lanes.length));
  return {
    corpusId,
    lanes,
    visibleLaneCount: visible,
    linkMode: loadLinkMode(corpusId),
    highlightSeqs: loadEvidenceHighlights(corpusId),
  };
}

/**
 * Broadcast placement to same-window listeners and every Tauri webview.
 * Payload should already be persisted (see applyEvidenceLanesToExplorer).
 */
export async function broadcastEvidenceLanesApply(
  detail: EvidenceLaneApplyDetail,
  injectedEmit?: EvidenceLaneEmit,
): Promise<void> {
  const normalized = normalizeDetail(detail);
  if (!normalized) return;
  const wire: EvidenceLaneApplyWire = {
    ...normalized,
    eventId: createEventId(),
  };
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(EVIDENCE_LANE_APPLY_EVENT, { detail: wire }),
    );
  }
  try {
    const send =
      injectedEmit ??
      ((await import("@tauri-apps/api/event"))
        .emit as unknown as EvidenceLaneEmit);
    await send(EVIDENCE_LANE_APPLY_EVENT, wire);
  } catch {
    // Browser preview and tests without Tauri bus still get CustomEvent.
  }
}

/**
 * Persist Evidence · N placement and notify every live Explorer surface
 * (main webview CustomEvent + Tauri cross-window emit for log-explorer-*).
 */
export function applyEvidenceLanesToExplorer(
  detail: EvidenceLaneApplyDetail,
  injectedEmit?: EvidenceLaneEmit,
): EvidenceLaneApplyDetail {
  const applied = persistEvidenceLanesPlacement(detail);
  void broadcastEvidenceLanesApply(applied, injectedEmit);
  return applied;
}

/**
 * Subscribe to same-window CustomEvent and cross-webview Tauri signals.
 * Dedupes CustomEvent+Tauri double delivery via eventId when present.
 */
export function subscribeEvidenceLanesApply(
  onApply: (detail: EvidenceLaneApplyDetail) => void,
  injectedListen?: EvidenceLaneListen,
): () => void {
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];

  const accept = (raw: EvidenceLaneApplyWire | EvidenceLaneApplyDetail | undefined) => {
    if (disposed) return;
    const wire = raw as EvidenceLaneApplyWire | undefined;
    if (wire?.eventId != null) {
      if (typeof wire.eventId !== "string" || wire.eventId.length === 0) return;
      if (seenEventIds.has(wire.eventId)) return;
      seenEventIds.add(wire.eventId);
      seenEventOrder.push(wire.eventId);
      if (seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
        const expired = seenEventOrder.shift();
        if (expired !== undefined) seenEventIds.delete(expired);
      }
    }
    const detail = normalizeDetail(raw);
    if (!detail) return;
    onApply(detail);
  };

  const onCustom = (event: Event) => {
    accept((event as CustomEvent<EvidenceLaneApplyWire>).detail);
  };
  window.addEventListener(EVIDENCE_LANE_APPLY_EVENT, onCustom);

  void (async () => {
    const listen =
      injectedListen ??
      ((await import("@tauri-apps/api/event"))
        .listen as unknown as EvidenceLaneListen);
    const stop = await listen(EVIDENCE_LANE_APPLY_EVENT, (event) =>
      accept(event.payload),
    );
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => {
    // Browser preview and tests have no Tauri event bus.
  });

  return () => {
    disposed = true;
    window.removeEventListener(EVIDENCE_LANE_APPLY_EVENT, onCustom);
    stopTauri?.();
  };
}
