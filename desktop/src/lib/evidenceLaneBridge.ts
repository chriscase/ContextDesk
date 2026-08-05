/**
 * Chat citation → evidence set → 1–4 customer-log lanes + investigation.
 *
 * Pure logic only: no host I/O, no prose scraping, no invented timestamps or
 * service identity. Tests call these functions directly with synthetic XYZ
 * fixtures.
 */

import {
  classifyCompletedCitation,
  parseGovernedLogCitationId,
  parseLogEventSeq,
  type GovernedLogCitationId,
} from "./citations";
import type { LaneConfig, TimeLinkMode } from "./logExplorer/laneCompose";
import { defaultLanes } from "./logExplorer/laneCompose";
import { exactAlignmentAllowed, linkAllowed } from "./logExplorer/lanes";
import { chatCitationKey, type ChatCitation } from "./turn";

/** Max customer-evidence lanes (Activity rail is separate and never counted). */
export const MAX_EVIDENCE_LANES = 4;

export type EvidenceKind =
  | "log_event"
  | "log_template"
  | "workspace"
  | "web"
  | "other";

export type TimeQualityHint = "wall" | "mixed" | "order_only";

/**
 * Host-attached citation only. Never construct from answer prose.
 * Optional resolution fields come only from host-verified event data.
 */
export type HostEvidenceCitation = ChatCitation & {
  /** Host-verified source path/id — never invented from label. */
  source?: string;
  /** Host-verified service — never invented. */
  service?: string | null;
  /** Host-verified timestamp — never invented. */
  timestamp?: number;
  timeQuality?: TimeQualityHint;
};

export type EvidenceItem = {
  /** Stable key including corpus provenance. */
  key: string;
  id: string;
  label: string;
  title?: string;
  corpusId?: string;
  kind: EvidenceKind;
  /** True only for governed log_event with corpus — eligible for log lanes. */
  laneEligible: boolean;
  /** True for workspace/file (and similar) that open source surfaces, not lanes. */
  workspaceOnly: boolean;
  source?: string;
  service?: string | null;
  timestamp?: number;
  timeQuality?: TimeQualityHint;
  /** Safe-integer seq when navigable log_event. */
  seq?: number;
  governed?: GovernedLogCitationId;
};

export type LaneAssignmentMode =
  | "one_lane"
  | "group_related"
  | "one_source_per_lane";

export type LaneAssignmentResult = {
  mode: LaneAssignmentMode;
  lanes: LaneConfig[];
  visibleLaneCount: number;
  /** Items placed into a lane. */
  placedKeys: string[];
  /** Eligible items that could not fit within the 4-lane cap. */
  overflowKeys: string[];
  /** Human-readable assignment rationale (deterministic). */
  explanation: string[];
  linkMode: TimeLinkMode;
  /** Why time alignment is unavailable, when refused. */
  alignmentRefuseReason: string | null;
  /** Why timestamp link is unavailable, when refused. */
  linkRefuseReason: string | null;
};

export type OccupiedLanePreview = {
  needsConfirm: boolean;
  current: LaneConfig[];
  proposed: LaneConfig[];
  freeSlotCount: number;
  replacedLaneIds: string[];
  explanation: string[];
};

export type IdentityCheckResult =
  | { ok: true; item: EvidenceItem }
  | {
      ok: false;
      item: EvidenceItem;
      reason:
        | "missing_corpus"
        | "stale_corpus"
        | "mismatched_corpus"
        | "invalid_identity"
        | "missing_event"
        | "session_isolation";
      message: string;
    };

export type InvestigationAddStatus =
  | "idle"
  | "preview"
  | "confirmed"
  | "cancelled"
  | "undone"
  | "applied";

export type InvestigationEventRef = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQualityHint;
  citationId: string;
  citationKey: string;
};

export type InvestigationAddState = {
  status: InvestigationAddStatus;
  corpusId: string | null;
  investigationId: string | null;
  createsDraft: boolean;
  title: string;
  eventRefs: InvestigationEventRef[];
  /** Host-attached citation keys only. */
  citationKeys: string[];
  failReason: string | null;
  /** Snapshot for undo before host apply. */
  priorStatus: InvestigationAddStatus | null;
  /** Opaque, process-local host token binding exact payload + target. */
  commitToken: string | null;
  /** Exact existing target revision, null only for a host-bound create-new target. */
  expectedRevision: number | null;
};

export type ShowInExplorerPlan = {
  corpusId: string;
  assignment: LaneAssignmentResult;
  occupiedPreview: OccupiedLanePreview;
  highlightSeqs: number[];
  navTargets: GovernedLogCitationId[];
  /** Corpus open only — never reimport/mutate/duplicate. */
  openMode: "open_or_focus_existing";
  refuses: string[];
};

/** Classify a host citation into an evidence item. */
export function classifyHostCitation(
  citation: HostEvidenceCitation,
): EvidenceItem {
  const key = chatCitationKey(citation);
  const route = classifyCompletedCitation(citation.id);
  const governed = parseGovernedLogCitationId(citation.id);
  let kind: EvidenceKind = "other";
  if (governed?.kind === "event") kind = "log_event";
  else if (governed?.kind === "template") kind = "log_template";
  else if (route === "file") kind = "workspace";
  else if (/^https?:\/\//i.test(citation.id)) kind = "web";

  const seq =
    governed?.kind === "event" ? parseLogEventSeq(citation.id) ?? undefined : undefined;

  const laneEligible =
    kind === "log_event" &&
    Boolean(citation.corpusId?.trim()) &&
    seq != null;

  const workspaceOnly =
    kind === "workspace" ||
    kind === "web" ||
    kind === "other" ||
    (kind === "log_template" && !laneEligible);

  // Host stream puts verified source paths in `label` for search_logs event
  // citations (e.g. "xyz/api.log"). Only promote path-like labels — never
  // generic display names or model prose.
  const labelTrim = citation.label?.trim() ?? "";
  const labelLooksLikeHostSource =
    kind === "log_event" &&
    labelTrim.length > 0 &&
    labelTrim !== citation.id &&
    !labelTrim.startsWith("log_event:") &&
    !labelTrim.startsWith("log_template:") &&
    (labelTrim.includes("/") ||
      labelTrim.includes("\\") ||
      /\.(log|jsonl?|txt|out)$/i.test(labelTrim));
  const hostSource =
    citation.source?.trim() ||
    (labelLooksLikeHostSource ? labelTrim : undefined);

  return {
    key,
    id: citation.id,
    label: citation.label,
    title: citation.title,
    corpusId: citation.corpusId?.trim() || undefined,
    kind,
    laneEligible,
    workspaceOnly: workspaceOnly && !laneEligible,
    source: hostSource || undefined,
    service: citation.service ?? undefined,
    timestamp: citation.timestamp,
    timeQuality: citation.timeQuality,
    seq,
    governed: governed ?? undefined,
  };
}

/**
 * Build the evidence set from host-attached citations only.
 * Dedupes by citation key; never reads answer prose.
 */
export function buildEvidenceSetFromHostCitations(
  hostCitations: readonly HostEvidenceCitation[] | null | undefined,
): EvidenceItem[] {
  if (!hostCitations?.length) return [];
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const c of hostCitations) {
    if (!c?.id) continue;
    const item = classifyHostCitation(c);
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/**
 * Reject forged prose IDs: only identities present in the host evidence set
 * may enter selection / lane placement / investigation.
 */
export function filterToHostEvidenceSet(
  hostSet: readonly EvidenceItem[],
  candidateIds: readonly string[],
): { accepted: EvidenceItem[]; rejected: string[] } {
  const byId = new Map<string, EvidenceItem[]>();
  for (const item of hostSet) {
    const list = byId.get(item.id) ?? [];
    list.push(item);
    byId.set(item.id, list);
  }
  const accepted: EvidenceItem[] = [];
  const rejected: string[] = [];
  const acceptedKeys = new Set<string>();
  for (const raw of candidateIds) {
    const id = raw.trim();
    if (!id) continue;
    const matches = byId.get(id);
    if (!matches?.length) {
      rejected.push(id);
      continue;
    }
    for (const m of matches) {
      if (acceptedKeys.has(m.key)) continue;
      acceptedKeys.add(m.key);
      accepted.push(m);
    }
  }
  return { accepted, rejected };
}

/** Lane-eligible log events only (never workspace/file forced into lanes). */
export function laneEligibleItems(
  items: readonly EvidenceItem[],
): EvidenceItem[] {
  return items.filter((i) => i.laneEligible);
}

function laneIsFree(lane: LaneConfig): boolean {
  // Empty sources = "all sources" default — treat as free for placement when
  // label is still the stock default; user-specific empty membership with a
  // custom label counts as occupied composition.
  if (lane.sources.length > 0) return false;
  if (lane.rememberedSources && lane.rememberedSources.length > 0) return false;
  return (
    lane.label === "All sources" ||
    /^Lane \d+$/.test(lane.label) ||
    lane.label.trim() === ""
  );
}

function groupKey(item: EvidenceItem, mode: LaneAssignmentMode): string {
  if (mode === "one_lane") return "__all__";
  if (mode === "one_source_per_lane") {
    // Only real host source — never invent from label.
    return item.source?.trim() || "__unresolved_source__";
  }
  // group_related: prefer service when host-verified, else source, else corpus.
  const service = item.service?.trim();
  if (service) return `svc:${service}`;
  const source = item.source?.trim();
  if (source) return `src:${source}`;
  return `corpus:${item.corpusId ?? "unknown"}`;
}

function groupLabel(key: string, items: EvidenceItem[]): string {
  if (key === "__all__") return "Evidence";
  if (key === "__unresolved_source__") return "Unresolved source";
  if (key.startsWith("svc:")) return key.slice(4);
  if (key.startsWith("src:")) return key.slice(4);
  if (key.startsWith("corpus:")) {
    const id = key.slice(7);
    return id === "unknown" ? "Evidence" : `Corpus ${id.slice(0, 8)}`;
  }
  const src = items[0]?.source;
  return src || items[0]?.label || "Evidence";
}

/**
 * Deterministic lane assignment from real source/service/time fields only.
 * Prefers free lanes; overflow past 4 is reported, never silent drop without
 * explanation.
 */
export function assignEvidenceToLanes(
  selected: readonly EvidenceItem[],
  mode: LaneAssignmentMode,
  existingLanes: readonly LaneConfig[] = [],
): LaneAssignmentResult {
  const eligible = laneEligibleItems(selected);
  const explanation: string[] = [];
  const groups = new Map<string, EvidenceItem[]>();

  for (const item of eligible) {
    const k = groupKey(item, mode);
    const list = groups.get(k) ?? [];
    list.push(item);
    groups.set(k, list);
  }

  const groupEntries = [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  if (mode === "one_lane") {
    explanation.push(
      "Mode “one lane”: all selected log events share a single customer-evidence lane.",
    );
  } else if (mode === "group_related") {
    explanation.push(
      "Mode “group related”: buckets use host-verified service, then source, then corpus — never invented identity.",
    );
  } else {
    explanation.push(
      "Mode “one source per lane”: one host-verified source per lane (unresolved sources share a bucket).",
    );
  }

  const proposedGroups = groupEntries.slice(0, MAX_EVIDENCE_LANES);
  const overflowGroups = groupEntries.slice(MAX_EVIDENCE_LANES);
  const overflowKeys = overflowGroups.flatMap(([, items]) =>
    items.map((i) => i.key),
  );
  if (overflowKeys.length > 0) {
    explanation.push(
      `Lane limit ${MAX_EVIDENCE_LANES}: ${overflowKeys.length} event(s) in ${overflowGroups.length} group(s) could not be placed.`,
    );
  }

  const base =
    existingLanes.length > 0
      ? existingLanes.map((l) => ({ ...l, sources: [...l.sources] }))
      : defaultLanes(Math.max(1, proposedGroups.length));

  // Prefer free slots; build replacement proposal for remaining.
  const lanes: LaneConfig[] = base.slice(0, MAX_EVIDENCE_LANES).map((l, i) => ({
    id: l.id || `lane-${i}`,
    label: l.label,
    sources: [...l.sources],
    rememberedSources: l.rememberedSources
      ? [...l.rememberedSources]
      : undefined,
  }));

  while (lanes.length < Math.min(MAX_EVIDENCE_LANES, proposedGroups.length)) {
    const i = lanes.length;
    lanes.push({
      id: `lane-${i}`,
      label: `Lane ${i + 1}`,
      sources: [],
    });
  }

  // Map groups onto free lanes first, then lowest index unoccupied by this plan.
  const freeIdx = lanes
    .map((l, i) => (laneIsFree(l) ? i : -1))
    .filter((i) => i >= 0);
  let freePtr = 0;
  const used = new Set<number>();
  const placedKeys: string[] = [];

  for (const [gKey, items] of proposedGroups) {
    let targetIdx: number;
    if (freePtr < freeIdx.length) {
      targetIdx = freeIdx[freePtr]!;
      freePtr += 1;
    } else {
      targetIdx = 0;
      while (used.has(targetIdx) && targetIdx < MAX_EVIDENCE_LANES) {
        targetIdx += 1;
      }
      if (targetIdx >= MAX_EVIDENCE_LANES) {
        for (const it of items) overflowKeys.push(it.key);
        continue;
      }
    }
    used.add(targetIdx);
    const sources = [
      ...new Set(
        items
          .map((i) => i.source?.trim())
          .filter((s): s is string => Boolean(s)),
      ),
    ];
    // If no host source known, leave sources empty with explanatory label —
    // do not invent source paths.
    const label = groupLabel(gKey, items);
    lanes[targetIdx] = {
      id: lanes[targetIdx]!.id,
      label,
      sources,
      rememberedSources: sources.length > 0 ? [...sources] : undefined,
    };
    for (const it of items) placedKeys.push(it.key);
    if (sources.length === 0) {
      explanation.push(
        `Lane “${label}”: no host-verified source path — membership left open (not invented).`,
      );
    } else {
      explanation.push(
        `Lane “${label}”: sources ${sources.join(", ")} (${items.length} event${
          items.length === 1 ? "" : "s"
        }).`,
      );
    }
  }

  const visibleLaneCount = Math.max(
    1,
    Math.min(MAX_EVIDENCE_LANES, Math.max(lanes.length, used.size || 1)),
  );

  const qualities = eligible
    .map((i) => i.timeQuality)
    .filter((q): q is TimeQualityHint => q != null);
  const aggregateQuality: TimeQualityHint =
    qualities.length === 0
      ? "order_only"
      : qualities.every((q) => q === "wall")
        ? "wall"
        : qualities.some((q) => q === "order_only")
          ? "order_only"
          : "mixed";

  const alignRefuse = exactAlignmentAllowed(aggregateQuality);
  const linkRefuse = linkAllowed(aggregateQuality);
  if (alignRefuse) {
    explanation.push(`Time alignment unavailable: ${alignRefuse}`);
  } else {
    explanation.push(
      "Timestamps are wall-clock trustworthy — aligned time view is available.",
    );
  }
  if (qualities.length === 0) {
    explanation.push(
      "No host-verified timestamps on selection — causal/source order only.",
    );
  }

  return {
    mode,
    lanes: lanes.slice(0, MAX_EVIDENCE_LANES),
    visibleLaneCount,
    placedKeys,
    overflowKeys: [...new Set(overflowKeys)],
    explanation,
    linkMode: alignRefuse ? "independent" : "align_time",
    alignmentRefuseReason: alignRefuse,
    linkRefuseReason: linkRefuse,
  };
}

/**
 * Preview whether applying proposed lanes would replace user-occupied lanes.
 * Never silent — caller must show preview and accept cancel.
 */
export function previewOccupiedLaneChange(
  current: readonly LaneConfig[],
  proposed: readonly LaneConfig[],
): OccupiedLanePreview {
  const freeSlotCount = current.filter(laneIsFree).length;
  const replacedLaneIds: string[] = [];
  const explanation: string[] = [];

  const n = Math.max(current.length, proposed.length);
  for (let i = 0; i < n; i++) {
    const cur = current[i];
    const prop = proposed[i];
    if (!prop) continue;
    if (!cur) {
      explanation.push(`New lane slot ${prop.id} (“${prop.label}”).`);
      continue;
    }
    const same =
      cur.label === prop.label &&
      cur.sources.length === prop.sources.length &&
      cur.sources.every((s, j) => s === prop.sources[j]);
    if (same) continue;
    if (!laneIsFree(cur)) {
      replacedLaneIds.push(cur.id);
      explanation.push(
        `Replace occupied lane “${cur.label}” with “${prop.label}”.`,
      );
    } else {
      explanation.push(
        `Use free lane “${cur.label || cur.id}” for “${prop.label}”.`,
      );
    }
  }

  const needsConfirm = replacedLaneIds.length > 0;
  if (!needsConfirm) {
    explanation.push("No occupied lanes would be replaced.");
  } else {
    explanation.push(
      "Confirm to reconfigure occupied lanes, or cancel to keep your current layout.",
    );
  }

  return {
    needsConfirm,
    current: current.map((l) => ({
      ...l,
      sources: [...l.sources],
    })),
    proposed: proposed.map((l) => ({
      ...l,
      sources: [...l.sources],
    })),
    freeSlotCount,
    replacedLaneIds,
    explanation,
  };
}

/**
 * Apply lane assignment only when allowed. Cancel preserves current lanes.
 */
export function applyLaneAssignment(
  current: readonly LaneConfig[],
  assignment: LaneAssignmentResult,
  confirmReplace: boolean,
):
  | { applied: true; lanes: LaneConfig[]; visibleLaneCount: number }
  | { applied: false; reason: "cancelled_occupied_preview"; lanes: LaneConfig[] } {
  const preview = previewOccupiedLaneChange(current, assignment.lanes);
  if (preview.needsConfirm && !confirmReplace) {
    return {
      applied: false,
      reason: "cancelled_occupied_preview",
      lanes: current.map((l) => ({ ...l, sources: [...l.sources] })),
    };
  }
  return {
    applied: true,
    lanes: assignment.lanes.map((l) => ({
      ...l,
      sources: [...l.sources],
    })),
    visibleLaneCount: assignment.visibleLaneCount,
  };
}

/** Pin / remove / reorder within the four-lane limit. */
export function pinLane(lanes: readonly LaneConfig[], laneId: string): LaneConfig[] {
  const idx = lanes.findIndex((l) => l.id === laneId);
  if (idx <= 0) return lanes.map((l) => ({ ...l, sources: [...l.sources] }));
  const next = lanes.map((l) => ({ ...l, sources: [...l.sources] }));
  const [item] = next.splice(idx, 1);
  next.unshift(item!);
  return next.slice(0, MAX_EVIDENCE_LANES);
}

export function removeLane(
  lanes: readonly LaneConfig[],
  laneId: string,
): LaneConfig[] {
  const next = lanes
    .filter((l) => l.id !== laneId)
    .map((l) => ({ ...l, sources: [...l.sources] }));
  if (next.length === 0) return defaultLanes(1);
  return next.slice(0, MAX_EVIDENCE_LANES);
}

export function reorderLanes(
  lanes: readonly LaneConfig[],
  fromIndex: number,
  toIndex: number,
): LaneConfig[] {
  const next = lanes.map((l) => ({ ...l, sources: [...l.sources] }));
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= next.length ||
    toIndex >= next.length ||
    fromIndex === toIndex
  ) {
    return next.slice(0, MAX_EVIDENCE_LANES);
  }
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item!);
  return next.slice(0, MAX_EVIDENCE_LANES);
}

export function failClosedIdentityCheck(
  item: EvidenceItem,
  opts: {
    availableCorpusIds?: ReadonlySet<string> | readonly string[];
    expectedCorpusId?: string | null;
    sessionCorpusId?: string | null;
    eventExists?: boolean | null;
  } = {},
): IdentityCheckResult {
  if (item.kind === "log_event" || item.kind === "log_template") {
    if (!item.governed) {
      return {
        ok: false,
        item,
        reason: "invalid_identity",
        message:
          "Citation is not a canonical log_event:<id> or log_template:<id> identity.",
      };
    }
    if (!item.corpusId) {
      return {
        ok: false,
        item,
        reason: "missing_corpus",
        message:
          "This older log citation does not record its original corpus. ContextDesk will not substitute another corpus.",
      };
    }
    if (
      opts.expectedCorpusId &&
      opts.expectedCorpusId !== item.corpusId
    ) {
      return {
        ok: false,
        item,
        reason: "mismatched_corpus",
        message: `Citation corpus ${item.corpusId} does not match expected ${opts.expectedCorpusId}.`,
      };
    }
    if (
      opts.sessionCorpusId != null &&
      opts.sessionCorpusId !== "" &&
      opts.sessionCorpusId !== item.corpusId
    ) {
      // Cross-corpus is allowed for open-original, but investigation add is
      // isolated to one corpus at a time.
    }
    const available = opts.availableCorpusIds
      ? opts.availableCorpusIds instanceof Set
        ? opts.availableCorpusIds
        : new Set(opts.availableCorpusIds)
      : null;
    if (available && !available.has(item.corpusId)) {
      return {
        ok: false,
        item,
        reason: "stale_corpus",
        message: `The original log corpus for this citation is unavailable (${item.corpusId}).`,
      };
    }
    if (opts.eventExists === false) {
      return {
        ok: false,
        item,
        reason: "missing_event",
        message: `Event ${item.id} is missing from corpus ${item.corpusId}.`,
      };
    }
  }
  return { ok: true, item };
}

/**
 * Opening evidence never reimports, mutates, or duplicates a corpus.
 * Pure policy token used by Show-in-Explorer plans and tests.
 */
export function corpusOpenPolicy(): {
  reimport: false;
  mutate: false;
  duplicate: false;
  mode: "open_or_focus_existing";
} {
  return {
    reimport: false,
    mutate: false,
    duplicate: false,
    mode: "open_or_focus_existing",
  };
}

export function planShowInExplorer(
  selected: readonly EvidenceItem[],
  mode: LaneAssignmentMode,
  existingLanes: readonly LaneConfig[],
  opts: {
    availableCorpusIds?: ReadonlySet<string> | readonly string[];
  } = {},
): ShowInExplorerPlan | { error: string } {
  const eligible = laneEligibleItems(selected);
  if (eligible.length === 0) {
    return {
      error:
        "No lane-eligible log events selected. Workspace and file citations open their source surface instead of log lanes.",
    };
  }

  // Single corpus only — mixed corpus selection fails closed for lane place.
  const corpora = [...new Set(eligible.map((e) => e.corpusId!).filter(Boolean))];
  if (corpora.length !== 1) {
    return {
      error: `Selected evidence spans ${corpora.length} corpora; Show in Explorer requires one corpus at a time.`,
    };
  }
  const corpusId = corpora[0]!;

  const refuses: string[] = [];
  for (const item of eligible) {
    const check = failClosedIdentityCheck(item, {
      availableCorpusIds: opts.availableCorpusIds,
      expectedCorpusId: corpusId,
    });
    if (!check.ok) {
      refuses.push(check.message);
    }
  }
  if (refuses.length > 0) {
    return { error: refuses[0]! };
  }

  const assignment = assignEvidenceToLanes(eligible, mode, existingLanes);
  const occupiedPreview = previewOccupiedLaneChange(
    existingLanes,
    assignment.lanes,
  );
  const highlightSeqs = eligible
    .map((e) => e.seq)
    .filter((s): s is number => s != null);
  const navTargets = eligible
    .map((e) => e.governed)
    .filter((g): g is GovernedLogCitationId => g != null);

  return {
    corpusId,
    assignment,
    occupiedPreview,
    highlightSeqs,
    navTargets,
    openMode: corpusOpenPolicy().mode,
    refuses: assignment.overflowKeys.length
      ? [
          `${assignment.overflowKeys.length} event(s) exceed the ${MAX_EVIDENCE_LANES}-lane limit.`,
        ]
      : [],
  };
}

/**
 * User lane edits applied *after* assignment from host-resolved items.
 * Never a full LaneConfig[] snapshot taken before resolve — that would discard
 * host-verified sources when chat citations arrive without `source`.
 */
export type LaneEdit =
  | { type: "pin"; laneId: string }
  | { type: "remove"; laneId: string }
  | { type: "reorder"; fromIndex: number; toIndex: number };

/** Apply pin/remove/reorder log onto an assignment built from resolved items. */
export function applyLaneEdits(
  lanes: readonly LaneConfig[],
  edits: readonly LaneEdit[],
): LaneConfig[] {
  let next = lanes.map((l) => ({ ...l, sources: [...l.sources] }));
  for (const edit of edits) {
    if (edit.type === "pin") {
      next = pinLane(next, edit.laneId);
    } else if (edit.type === "remove") {
      next = removeLane(next, edit.laneId);
    } else if (edit.type === "reorder") {
      next = reorderLanes(next, edit.fromIndex, edit.toIndex);
    }
  }
  return next.slice(0, MAX_EVIDENCE_LANES);
}

/**
 * Demo/show path: **always** assign from host-resolved items, then apply
 * optional lane edits. Never prefer a pre-resolve working LaneConfig[].
 */
export function finalizeShowAssignment(args: {
  resolved: readonly EvidenceItem[];
  mode: LaneAssignmentMode;
  existing: readonly LaneConfig[];
  laneEdits?: readonly LaneEdit[];
  availableCorpusIds?: ReadonlySet<string> | readonly string[];
}): ShowInExplorerPlan | { error: string } {
  const plan = planShowInExplorer(
    args.resolved,
    args.mode,
    args.existing,
    { availableCorpusIds: args.availableCorpusIds },
  );
  if ("error" in plan) return plan;

  const edits = args.laneEdits ?? [];
  const lanes =
    edits.length > 0
      ? applyLaneEdits(plan.assignment.lanes, edits)
      : plan.assignment.lanes.map((l) => ({
          ...l,
          sources: [...l.sources],
        }));
  const visibleLaneCount = Math.max(
    1,
    Math.min(
      MAX_EVIDENCE_LANES,
      edits.length > 0 ? Math.max(lanes.length, 1) : plan.assignment.visibleLaneCount,
    ),
  );
  const assignment: LaneAssignmentResult = {
    ...plan.assignment,
    lanes,
    visibleLaneCount,
  };
  const occupiedPreview = previewOccupiedLaneChange(args.existing, assignment.lanes);
  return {
    ...plan,
    assignment,
    occupiedPreview,
  };
}

export function idleInvestigationAdd(): InvestigationAddState {
  return {
    status: "idle",
    corpusId: null,
    investigationId: null,
    createsDraft: false,
    title: "",
    eventRefs: [],
    citationKeys: [],
    failReason: null,
    priorStatus: null,
    commitToken: null,
    expectedRevision: null,
  };
}

/**
 * Build investigation preview from host evidence only. Requires explicit
 * confirm before any host write. Event refs preserve corpus/seq/source/time.
 */
export function previewInvestigationAdd(
  selected: readonly EvidenceItem[],
  opts: {
    title?: string;
    investigationId?: string | null;
    availableCorpusIds?: ReadonlySet<string> | readonly string[];
  } = {},
): InvestigationAddState {
  const eligible = laneEligibleItems(selected);
  if (eligible.length === 0) {
    return {
      ...idleInvestigationAdd(),
      status: "preview",
      failReason:
        "No log-event evidence selected. Workspace citations cannot be added as log investigation evidence.",
    };
  }

  const corpora = [...new Set(eligible.map((e) => e.corpusId!).filter(Boolean))];
  if (corpora.length !== 1) {
    return {
      ...idleInvestigationAdd(),
      status: "preview",
      failReason: `Cannot mix ${corpora.length} corpora in one investigation add.`,
    };
  }
  const corpusId = corpora[0]!;

  const eventRefs: InvestigationEventRef[] = [];
  for (const item of eligible) {
    const check = failClosedIdentityCheck(item, {
      availableCorpusIds: opts.availableCorpusIds,
      expectedCorpusId: corpusId,
    });
    if (!check.ok) {
      return {
        ...idleInvestigationAdd(),
        status: "preview",
        failReason: check.message,
      };
    }
    if (item.seq == null) {
      return {
        ...idleInvestigationAdd(),
        status: "preview",
        failReason: `Citation ${item.id} has no navigable event seq.`,
      };
    }
    // Source/time only when host-verified; placeholder empty source refuses inventing.
    if (!item.source?.trim()) {
      return {
        ...idleInvestigationAdd(),
        status: "preview",
        failReason: `Citation ${item.id} lacks host-verified source identity; refuse to invent it for investigation storage.`,
      };
    }
    if (item.timestamp == null || item.timeQuality == null) {
      return {
        ...idleInvestigationAdd(),
        status: "preview",
        failReason: `Citation ${item.id} lacks host-verified timestamp/quality; refuse fabricated alignment for investigation storage.`,
      };
    }
    eventRefs.push({
      corpusId,
      seq: item.seq,
      source: item.source,
      timestampHint: item.timestamp,
      timeQualityHint: item.timeQuality,
      citationId: item.id,
      citationKey: item.key,
    });
  }

  const investigationId = opts.investigationId ?? null;
  return {
    status: "preview",
    corpusId,
    investigationId,
    createsDraft: investigationId == null,
    title:
      opts.title?.trim() ||
      `Evidence · ${eventRefs.length} event${eventRefs.length === 1 ? "" : "s"}`,
    eventRefs,
    citationKeys: eventRefs.map((r) => r.citationKey),
    failReason: null,
    priorStatus: "idle",
    commitToken: null,
    expectedRevision: null,
  };
}

/** Attach the host's exact, one-shot investigation target to a preview. */
export function bindPreparedInvestigationTarget(
  state: InvestigationAddState,
  prepared: {
    commitToken: string;
    investigationId: string | null;
    expectedRevision: number | null;
    createsDraft: boolean;
  },
): InvestigationAddState {
  if (
    state.status !== "preview" ||
    state.failReason ||
    !prepared.commitToken.trim() ||
    (prepared.createsDraft
      ? prepared.investigationId != null || prepared.expectedRevision != null
      : !prepared.investigationId || prepared.expectedRevision == null)
  ) {
    return {
      ...state,
      failReason: "Host could not bind an exact investigation target.",
    };
  }
  return {
    ...state,
    commitToken: prepared.commitToken,
    investigationId: prepared.investigationId,
    expectedRevision: prepared.expectedRevision,
    createsDraft: prepared.createsDraft,
  };
}

export function confirmInvestigationAdd(
  state: InvestigationAddState,
): InvestigationAddState {
  if (state.status !== "preview" || state.failReason || !state.commitToken) {
    return {
      ...state,
      failReason:
        state.failReason ??
        (state.commitToken
          ? "Nothing to confirm — open a valid preview first."
          : "Wait for the host to bind the exact investigation target."),
    };
  }
  return {
    ...state,
    status: "confirmed",
    priorStatus: "preview",
  };
}

export function cancelInvestigationAdd(
  state: InvestigationAddState,
): InvestigationAddState {
  if (state.status !== "preview" && state.status !== "confirmed") {
    return state;
  }
  return {
    ...idleInvestigationAdd(),
    status: "cancelled",
    priorStatus: state.status,
  };
}

/** Undo a confirmed (not yet applied) add — discards payload. */
export function undoInvestigationAdd(
  state: InvestigationAddState,
): InvestigationAddState {
  if (state.status !== "confirmed") {
    return {
      ...state,
      failReason: "Undo is only available after confirm and before apply.",
    };
  }
  return {
    ...idleInvestigationAdd(),
    status: "undone",
    priorStatus: "confirmed",
  };
}

/** Mark applied after successful host write (no silent model path). */
export function markInvestigationApplied(
  state: InvestigationAddState,
): InvestigationAddState {
  if (state.status !== "confirmed") {
    return {
      ...state,
      failReason: "Host apply requires an explicit confirmed preview.",
    };
  }
  return {
    ...state,
    status: "applied",
    priorStatus: "confirmed",
    commitToken: null,
  };
}

/**
 * Selection helpers — pure set ops keyed by citation key.
 */
export function toggleEvidenceSelection(
  selectedKeys: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selectedKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function selectAllLaneEligible(
  items: readonly EvidenceItem[],
): Set<string> {
  return new Set(laneEligibleItems(items).map((i) => i.key));
}

export function selectionFromKeys(
  items: readonly EvidenceItem[],
  keys: ReadonlySet<string>,
): EvidenceItem[] {
  return items.filter((i) => keys.has(i.key));
}

/** Evidence · N label; N is host evidence count (never prose-derived). */
export function evidenceControlLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `Evidence · ${n}`;
}

/**
 * Activity rail vs customer-evidence lanes: structural separation token.
 * Customer lanes use log-explorer lane ids; Activity uses message trail UI.
 */
export function customerEvidenceLaneSemantics(): {
  maxLanes: number;
  activityRailSeparate: true;
  activityNeverCountsAsEvidenceLane: true;
  cssCustomerLanes: "log-explorer__lanes";
  cssActivityRail: "message-activity";
} {
  return {
    maxLanes: MAX_EVIDENCE_LANES,
    activityRailSeparate: true,
    activityNeverCountsAsEvidenceLane: true,
    cssCustomerLanes: "log-explorer__lanes",
    cssActivityRail: "message-activity",
  };
}

/**
 * Enrich host citations with resolved explorer events (host-verified only).
 * Matching is by corpus + seq; never by prose.
 */
export function enrichWithHostEvents(
  items: readonly EvidenceItem[],
  events: readonly {
    corpusId: string;
    seq: number;
    source: string;
    ts: number;
    timeQuality: TimeQualityHint;
    service?: string | null;
  }[],
): EvidenceItem[] {
  const byKey = new Map(
    events.map((e) => [`${e.corpusId}\u0000${e.seq}`, e] as const),
  );
  return items.map((item) => {
    if (item.seq == null || !item.corpusId) return item;
    const hit = byKey.get(`${item.corpusId}\u0000${item.seq}`);
    if (!hit) return item;
    return {
      ...item,
      source: hit.source,
      service: hit.service ?? item.service,
      timestamp: hit.ts,
      timeQuality: hit.timeQuality,
      laneEligible: true,
      workspaceOnly: false,
    };
  });
}
