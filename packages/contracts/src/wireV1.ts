/**
 * `cd.v1` wire types + strict parsers for the first governed DTO family
 * (design handoff batch B2).
 *
 * The Rust side owns every shape; each parser here is proven against the
 * committed Rust-generated fixtures in `fixtures/contracts/`. Casing is the
 * exact production wire: camelCase struct fields with snake_case enum values
 * (`cd-core` `log_analysis`/`investigations` families), snake_case fields on
 * `ProcessProgress`, and untyped `{kind, payload}` stream events. Preserved
 * as-is — no cleanup, no cd.v2 speculation. `desktop/src/lib/host.ts` keeps
 * its own definitions for this batch; migration is a later batch.
 */
import { checkObject, checkValue, f, type ObjectShape } from "./parse";

// ---------------------------------------------------------------------------
// Enum wire values (exact serde renames)
// ---------------------------------------------------------------------------

export const TIME_QUALITY = ["wall", "mixed", "order_only"] as const;
export type TimeQuality = (typeof TIME_QUALITY)[number];

export const TIMESTAMP_PROVENANCE = [
  "explicit_wall_clock",
  "unresolved_local",
  "order_only",
  "legacy_unknown",
] as const;
export type TimestampProvenance = (typeof TIMESTAMP_PROVENANCE)[number];

export const ACTIVE_TIMESTAMP_BASIS = [
  "explicit_wall",
  "resolved_local",
  "order_only",
  "legacy_unknown",
] as const;
export type ActiveTimestampBasis = (typeof ACTIVE_TIMESTAMP_BASIS)[number];

export const SHARED_TIMELINE_SEVERITY = [
  "error",
  "warn",
  "info",
  "debug",
  "other",
] as const;
export type SharedTimelineSeverity = (typeof SHARED_TIMELINE_SEVERITY)[number];

export const SUPPRESSION_RULE_ORIGIN = [
  "human",
  "detector_proposal",
  "model_proposal",
] as const;
export type SuppressionRuleOrigin = (typeof SUPPRESSION_RULE_ORIGIN)[number];

export const SUPPRESSION_RULE_STATE = ["enabled", "disabled", "removed"] as const;
export type SuppressionRuleState = (typeof SUPPRESSION_RULE_STATE)[number];

export const SUPPRESSION_RULE_RESOLUTION_KIND = [
  "matches_current",
  "stale_target_missing",
  "stale_fingerprint_changed",
  "invalid_predicate",
  "conflicting_predicate",
  "inactive",
] as const;
export type SuppressionRuleResolutionKind =
  (typeof SUPPRESSION_RULE_RESOLUTION_KIND)[number];

export const SUPPRESSION_AUDIT_ACTION = [
  "previewed",
  "activated",
  "disabled",
  "reenabled",
  "removed",
] as const;
export type SuppressionAuditAction = (typeof SUPPRESSION_AUDIT_ACTION)[number];

export const NOISE_CANDIDATE_SHAPE = [
  "insufficient_time",
  "steady",
  "bursty",
] as const;
export type NoiseCandidateShape = (typeof NOISE_CANDIDATE_SHAPE)[number];

export const NOISE_CANDIDATE_REASON_CODE = [
  "high_frequency",
  "high_corpus_share",
  "multi_source_repetition",
  "temporally_persistent",
  "level_dominated_info",
  "level_dominated_warn",
  "repetitive_error_risky",
  "steady_background",
  "already_suppressed",
] as const;
export type NoiseCandidateReasonCode =
  (typeof NOISE_CANDIDATE_REASON_CODE)[number];

export const INVESTIGATION_STATUS = ["active", "archived"] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUS)[number];

export const HUMAN_PROVENANCE = ["human"] as const;
export type HumanProvenance = (typeof HUMAN_PROVENANCE)[number];

export const FINDING_KIND = ["observation", "inference", "hypothesis"] as const;
export type FindingKind = (typeof FINDING_KIND)[number];

export const FINDING_LIFECYCLE = ["accepted", "resolved"] as const;
export type FindingLifecycle = (typeof FINDING_LIFECYCLE)[number];

export const INVESTIGATION_NOISE_LENS = ["active", "suspended"] as const;
export type InvestigationNoiseLens = (typeof INVESTIGATION_NOISE_LENS)[number];

export const INVESTIGATION_POLICY_BINDING_STATUS = [
  "unbound_legacy",
  "current",
  "made_under_different_policy",
  "made_under_different_lens",
  "current_lens_unknown",
] as const;
export type InvestigationPolicyBindingStatus =
  (typeof INVESTIGATION_POLICY_BINDING_STATUS)[number];

export const PROPOSED_FINDING_STATUS = [
  "proposed",
  "accepted",
  "dismissed",
  "superseded",
] as const;
export type ProposedFindingStatus = (typeof PROPOSED_FINDING_STATUS)[number];

export const PROPOSAL_EVIDENCE_ROLE = [
  "supporting",
  "contradicting",
] as const;
export type ProposalEvidenceRole = (typeof PROPOSAL_EVIDENCE_ROLE)[number];

export const PROPOSAL_SOURCE_KIND = ["model", "detector", "internal"] as const;
export type ProposalSourceKind = (typeof PROPOSAL_SOURCE_KIND)[number];

export const FINDING_VIEW_TIME_LINK_MODE = [
  "independent",
  "follow_cursor",
  "align_time",
] as const;
export type FindingViewTimeLinkMode =
  (typeof FINDING_VIEW_TIME_LINK_MODE)[number];

export const FINDING_VIEW_FIND_MATCH_MODE = ["literal", "regex"] as const;
export type FindingViewFindMatchMode =
  (typeof FINDING_VIEW_FIND_MATCH_MODE)[number];

export const BOOKMARK_EVIDENCE_STATUS = [
  "legacy_range",
  "verified",
  "missing",
  "stale",
] as const;
export type BookmarkEvidenceStatus = (typeof BOOKMARK_EVIDENCE_STATUS)[number];

export const PROCESS_PROGRESS_KIND = [
  "log_ingest",
  "session_context_import",
] as const;
export type ProcessProgressKind = (typeof PROCESS_PROGRESS_KIND)[number];

export const PROCESS_PROGRESS_PHASE = [
  "starting",
  "scan",
  "stream",
  "parse",
  "template",
  "redact",
  "store",
  "embed",
  "publish",
  "read",
  "validate",
  "extract",
  "write",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ProcessProgressPhase = (typeof PROCESS_PROGRESS_PHASE)[number];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** `cd_core::research::EventDto` — the agent-turn stream event. */
export type WireEvent = { kind: string; payload: unknown };

/** `cd_core::log_analysis::ExplorerEvent` (camelCase). */
export type WireExplorerEvent = {
  seq: number;
  ts: number;
  timestampProvenance: TimestampProvenance;
  activeTimestampBasis: ActiveTimestampBasis;
  unresolvedLocalTimestamp?: string;
  timeQuality: TimeQuality;
  level: string;
  service: string | null;
  host: string | null;
  templateId: number;
  traceId: string | null;
  message: string;
  source: string;
};

export type WireEventPage = {
  events: WireExplorerEvent[];
  nextCursor: number | null;
  nextTs?: number;
  prevCursor?: number;
  prevTs?: number;
  totalMatched: number;
  timeQuality: TimeQuality;
};

export type WireEventRowsPage = Omit<WireEventPage, "totalMatched">;

export type WireEventCount = { totalMatched: number };

export type WireLogFacets = {
  sources: Record<string, number>;
  levels: Record<string, number>;
  services: Record<string, number>;
  hosts: Record<string, number>;
  timeQuality: TimeQuality;
};

export type WireSharedTimelineSummary = {
  timeQuality: TimeQuality;
  spanFrom: number | null;
  spanTo: number | null;
  bucketWidth: number;
  bucketCount: number;
  totalMatched: number;
  buckets: { index: number; start: number; end: number }[];
  counts: number[];
  severitySeries: { severity: SharedTimelineSeverity; counts: number[] }[];
  lanes: {
    laneIndex: number;
    sourceCount: number;
    timeQuality: TimeQuality;
    totalMatched: number;
    counts: number[];
  }[];
};

export type WireSuppressionDocument = {
  schemaVersion: number;
  corpusId: string;
  revision: number;
  rules: WireSuppressionRule[];
  previews: WireSuppressionPreview[];
  audit: WireSuppressionAuditEntry[];
  resolvedTemplateRevision?: number;
};

export type WireSuppressionRule = {
  id: string;
  name: string;
  rationale: string;
  predicate: { templateId: number; templateFingerprint: string };
  origin: SuppressionRuleOrigin;
  state: SuppressionRuleState;
  createdAt: number;
  updatedAt: number;
  resolution?: WireSuppressionRuleResolution;
};

export type WireSuppressionRuleResolution = {
  kind: SuppressionRuleResolutionKind;
  matchesNothing: boolean;
  explanation: string;
};

export type WireSuppressionPreview = {
  token: string;
  corpusId: string;
  eventRevision: number;
  ruleRevision: number;
  name: string;
  rationale: string;
  predicate: { templateId: number; templateFingerprint: string };
  origin: SuppressionRuleOrigin;
  matchingEventCount: number;
  incrementalEventCount: number;
  corpusEventCount: number;
  levelCounts: { level: string; count: number }[];
  sourceCount: number;
  timeSpan: { from: number; to: number };
  representatives: {
    seq: number;
    source: string;
    timestamp: number;
    timeQuality: TimeQuality;
    level: string;
    redactedExcerpt: string;
  }[];
  createdAt: number;
};

export type WireSuppressionAuditEntry = {
  id: string;
  revision: number;
  action: SuppressionAuditAction;
  ruleId?: string;
  previewToken?: string;
  createdAt: number;
};

export type WireNoiseCandidateReport = {
  corpusId: string;
  unsuppressedEventCount: number;
  corpusEventCount: number;
  suppressionRevision: number;
  eventRevision: number;
  templateAnalysisRevision: number;
  alreadySuppressedTemplateIds: number[];
  timeQuality: TimeQuality;
  rawTimeQuality: TimeQuality;
  candidates: WireNoiseCandidate[];
  eligibleCandidateCount: number;
  templatesScanned: number;
  truncated: boolean;
  candidateCapTruncated: boolean;
  templateScanTruncated: boolean;
  responseBytesTruncated: boolean;
  metadataMissingTemplateIds: number[];
  databaseQueryCount: number;
  disclaimer: string;
  cancelled: boolean;
};

export type WireNoiseCandidate = {
  templateId: number;
  templateFingerprint: string;
  pattern: string;
  score: number;
  eventCount: number;
  corpusShareBps: number;
  sourceCount: number;
  shape: NoiseCandidateShape;
  timeQuality: TimeQuality;
  wallTimeSpan: { from: number; to: number } | null;
  orderSpan: { from: number; to: number } | null;
  levelCounts: { level: string; count: number }[];
  otherLevelCount: number;
  levelCountsTruncated: boolean;
  errorOrFatalCount: number;
  warnCount: number;
  infoCount: number;
  reasonCodes: NoiseCandidateReasonCode[];
  explanation: string;
  alreadySuppressed: boolean;
  shareBasis: string;
  proposalKind: string;
  representatives: {
    seq: number;
    source: string;
    timestamp: number;
    timeQuality: TimeQuality;
    level: string;
    redactedExcerpt: string;
  }[];
};

export type WireBookmarkEventRef = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
};

export type WireResolvedBookmark = {
  id: string;
  label: string;
  seqFrom: number;
  seqTo: number;
  tsFrom?: number;
  tsTo?: number;
  eventRefs?: WireBookmarkEventRef[];
  color?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  evidenceStatus: BookmarkEvidenceStatus;
};

export type WireInvestigationDocument = {
  schemaVersion: number;
  id: string;
  revision: number;
  title: string;
  status: InvestigationStatus;
  corpusLinks: { corpusId: string }[];
  evidence: WireEvidenceItem[];
  findings: WireFindingItem[];
  notes: WireNoteItem[];
  proposedFindings: WireProposedFindingItem[];
  createdAt: number;
  updatedAt: number;
};

export type WireEvidenceItem = {
  id: string;
  title: string;
  provenance: HumanProvenance;
  corpusId: string;
  eventRefs: WireBookmarkEventRef[];
  createdAt: number;
  updatedAt: number;
};

export type WireFindingItem = {
  id: string;
  kind: FindingKind;
  lifecycle: FindingLifecycle;
  title: string;
  whyItMatters: string;
  evidenceIds: string[];
  viewRecipe?: WireFindingViewRecipe;
  policyBinding?: WireInvestigationPolicyBinding;
  provenance: HumanProvenance;
  createdAt: number;
  updatedAt: number;
};

export type WireInvestigationPolicyBinding = {
  suppressionPolicyRevision: number;
  resolvedTemplateRevision: number;
  effectivePolicySha256: string;
  noiseLens: InvestigationNoiseLens;
};

export type WireProposedFindingItem = {
  id: string;
  status: ProposedFindingStatus;
  kind: FindingKind;
  title: string;
  whyItMatters: string;
  caveats?: string;
  evidence: {
    eventRef: WireBookmarkEventRef;
    role: ProposalEvidenceRole;
  }[];
  viewRecipe?: WireFindingViewRecipe;
  corpusId: string;
  investigationId: string;
  policyBinding?: WireInvestigationPolicyBinding;
  templateRevision?: number;
  suppressionPolicyRevision?: number;
  rankInputs?: {
    supportingCount: number;
    contradictingCount: number;
    timeSpanSecs?: number;
    levelWeight?: number;
  };
  provenance: {
    source: ProposalSourceKind;
    provider?: string;
    modelId?: string;
    runId?: string;
    toolName: string;
    detectorId?: string;
  };
  idempotencyKey: string;
  acceptance?: { acceptedAt: number; edited: boolean };
  dismissReason?: string;
  acceptedFindingId?: string;
  createdAt: number;
  updatedAt: number;
};

export type WireNoteItem = {
  id: string;
  title: string;
  body: string;
  evidenceIds: string[];
  findingIds?: string[];
  provenance: HumanProvenance;
  createdAt: number;
  updatedAt: number;
};

export type WireFindingViewRecipe = {
  filters: {
    levels: string[];
    sources: string[];
    services: string[];
    hosts: string[];
    timeFrom: number | null;
    timeTo: number | null;
    seqFrom: number | null;
    seqTo: number | null;
    templateId: number | null;
    traceId: string | null;
    keyword: string | null;
  };
  lanes: { id: string; label: string; sources: string[] }[];
  visibleLaneCount: number;
  linkMode: FindingViewTimeLinkMode;
  focusedLaneId: string | null;
  focusedEvent: WireBookmarkEventRef | null;
  selection: WireBookmarkEventRef[];
  highlights: WireBookmarkEventRef[];
  find: {
    query: string;
    matchMode: FindingViewFindMatchMode;
    caseSensitive: boolean;
    semantic: boolean;
  } | null;
  viewportAnchors: { laneId: string; eventRef: WireBookmarkEventRef }[];
};

export type WireProcessProgress = {
  kind: ProcessProgressKind;
  phase: ProcessProgressPhase;
  message: string;
  fraction: number | null;
  lines_processed: number | null;
  files_processed: number | null;
  bytes_processed: number | null;
  templates: number | null;
  cancellable: boolean;
  elapsed_ms?: number;
  phase_elapsed_ms?: number;
};

// ---------------------------------------------------------------------------
// Shapes (mirror serde field-by-field; see parse.ts for mode semantics)
// ---------------------------------------------------------------------------

const timeQuality = f.en(...TIME_QUALITY);

const explorerEventShape: ObjectShape = {
  seq: f.req(f.u64),
  ts: f.req(f.i64),
  timestampProvenance: f.req(f.en(...TIMESTAMP_PROVENANCE)),
  activeTimestampBasis: f.req(f.en(...ACTIVE_TIMESTAMP_BASIS)),
  unresolvedLocalTimestamp: f.opt(f.str),
  timeQuality: f.req(timeQuality),
  level: f.req(f.str),
  service: f.nul(f.str),
  host: f.nul(f.str),
  templateId: f.req(f.u64),
  traceId: f.nul(f.str),
  message: f.req(f.str),
  source: f.req(f.str),
};

const eventPageShape: ObjectShape = {
  events: f.req(f.arr(f.obj(explorerEventShape))),
  nextCursor: f.nul(f.u64),
  nextTs: f.opt(f.i64),
  prevCursor: f.opt(f.u64),
  prevTs: f.opt(f.i64),
  totalMatched: f.req(f.u64),
  timeQuality: f.req(timeQuality),
};

const eventRowsPageShape: ObjectShape = (() => {
  const rest = { ...eventPageShape } as Record<
    string,
    (typeof eventPageShape)[string]
  >;
  delete rest.totalMatched;
  return rest;
})();

const logFacetsShape: ObjectShape = {
  sources: f.req(f.map(f.u64)),
  levels: f.req(f.map(f.u64)),
  services: f.req(f.map(f.u64)),
  hosts: f.req(f.map(f.u64)),
  timeQuality: f.req(timeQuality),
};

const sharedTimelineSummaryShape: ObjectShape = {
  timeQuality: f.req(timeQuality),
  spanFrom: f.nul(f.i64),
  spanTo: f.nul(f.i64),
  bucketWidth: f.req(f.i64),
  bucketCount: f.req(f.u64),
  totalMatched: f.req(f.u64),
  buckets: f.req(
    f.arr(
      f.obj({
        index: f.req(f.u64),
        start: f.req(f.i64),
        end: f.req(f.i64),
      }),
    ),
  ),
  counts: f.req(f.arr(f.u64)),
  severitySeries: f.req(
    f.arr(
      f.obj({
        severity: f.req(f.en(...SHARED_TIMELINE_SEVERITY)),
        counts: f.req(f.arr(f.u64)),
      }),
    ),
  ),
  lanes: f.req(
    f.arr(
      f.obj({
        laneIndex: f.req(f.u64),
        sourceCount: f.req(f.u64),
        timeQuality: f.req(timeQuality),
        totalMatched: f.req(f.u64),
        counts: f.req(f.arr(f.u64)),
      }),
    ),
  ),
};

const predicateShape: ObjectShape = {
  templateId: f.req(f.u64),
  templateFingerprint: f.req(f.str),
};

const levelCountShape: ObjectShape = {
  level: f.req(f.str),
  count: f.req(f.u64),
};

const timeSpanShape: ObjectShape = { from: f.req(f.i64), to: f.req(f.i64) };

const representativeShape: ObjectShape = {
  seq: f.req(f.u64),
  source: f.req(f.str),
  timestamp: f.req(f.i64),
  timeQuality: f.req(timeQuality),
  level: f.req(f.str),
  redactedExcerpt: f.req(f.str),
};

const suppressionDocumentShape: ObjectShape = {
  schemaVersion: f.req(f.u64),
  corpusId: f.req(f.str),
  revision: f.req(f.u64),
  rules: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        name: f.req(f.str),
        rationale: f.req(f.str),
        predicate: f.req(f.obj(predicateShape)),
        origin: f.req(f.en(...SUPPRESSION_RULE_ORIGIN)),
        state: f.req(f.en(...SUPPRESSION_RULE_STATE)),
        createdAt: f.req(f.i64),
        updatedAt: f.req(f.i64),
        resolution: f.opt(
          f.obj({
            kind: f.req(f.en(...SUPPRESSION_RULE_RESOLUTION_KIND)),
            matchesNothing: f.req(f.bool),
            explanation: f.req(f.str),
          }),
        ),
      }),
    ),
  ),
  previews: f.req(
    f.arr(
      f.obj({
        token: f.req(f.str),
        corpusId: f.req(f.str),
        eventRevision: f.req(f.u64),
        ruleRevision: f.req(f.u64),
        name: f.req(f.str),
        rationale: f.req(f.str),
        predicate: f.req(f.obj(predicateShape)),
        origin: f.req(f.en(...SUPPRESSION_RULE_ORIGIN)),
        matchingEventCount: f.req(f.u64),
        incrementalEventCount: f.req(f.u64),
        corpusEventCount: f.req(f.u64),
        levelCounts: f.req(f.arr(f.obj(levelCountShape))),
        sourceCount: f.req(f.u64),
        timeSpan: f.req(f.obj(timeSpanShape)),
        representatives: f.req(f.arr(f.obj(representativeShape))),
        createdAt: f.req(f.i64),
      }),
    ),
  ),
  audit: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        revision: f.req(f.u64),
        action: f.req(f.en(...SUPPRESSION_AUDIT_ACTION)),
        ruleId: f.opt(f.str),
        previewToken: f.opt(f.str),
        createdAt: f.req(f.i64),
      }),
    ),
  ),
  resolvedTemplateRevision: f.opt(f.u64),
};

const noiseCandidateReportShape: ObjectShape = {
  corpusId: f.req(f.str),
  unsuppressedEventCount: f.req(f.u64),
  corpusEventCount: f.req(f.u64),
  suppressionRevision: f.req(f.u64),
  eventRevision: f.req(f.u64),
  templateAnalysisRevision: f.req(f.u64),
  alreadySuppressedTemplateIds: f.req(f.arr(f.u64)),
  timeQuality: f.req(timeQuality),
  rawTimeQuality: f.req(timeQuality),
  candidates: f.req(
    f.arr(
      f.obj({
        templateId: f.req(f.u64),
        templateFingerprint: f.req(f.str),
        pattern: f.req(f.str),
        score: f.req(f.u64),
        eventCount: f.req(f.u64),
        corpusShareBps: f.req(f.u64),
        sourceCount: f.req(f.u64),
        shape: f.req(f.en(...NOISE_CANDIDATE_SHAPE)),
        timeQuality: f.req(timeQuality),
        wallTimeSpan: f.nul(f.obj(timeSpanShape)),
        orderSpan: f.nul(f.obj(timeSpanShape)),
        levelCounts: f.req(f.arr(f.obj(levelCountShape))),
        otherLevelCount: f.req(f.u64),
        levelCountsTruncated: f.req(f.bool),
        errorOrFatalCount: f.req(f.u64),
        warnCount: f.req(f.u64),
        infoCount: f.req(f.u64),
        reasonCodes: f.req(f.arr(f.en(...NOISE_CANDIDATE_REASON_CODE))),
        explanation: f.req(f.str),
        alreadySuppressed: f.req(f.bool),
        shareBasis: f.req(f.str),
        proposalKind: f.req(f.str),
        representatives: f.req(f.arr(f.obj(representativeShape))),
      }),
    ),
  ),
  eligibleCandidateCount: f.req(f.u64),
  templatesScanned: f.req(f.u64),
  truncated: f.req(f.bool),
  candidateCapTruncated: f.req(f.bool),
  templateScanTruncated: f.req(f.bool),
  responseBytesTruncated: f.req(f.bool),
  metadataMissingTemplateIds: f.req(f.arr(f.u64)),
  databaseQueryCount: f.req(f.u64),
  disclaimer: f.req(f.str),
  cancelled: f.req(f.bool),
};

const bookmarkEventRefShape: ObjectShape = {
  corpusId: f.req(f.str),
  seq: f.req(f.u64),
  source: f.req(f.str),
  timestampHint: f.req(f.i64),
  timeQualityHint: f.req(timeQuality),
};

const resolvedBookmarkShape: ObjectShape = {
  id: f.req(f.str),
  label: f.req(f.str),
  seqFrom: f.req(f.u64),
  seqTo: f.req(f.u64),
  tsFrom: f.opt(f.i64),
  tsTo: f.opt(f.i64),
  eventRefs: f.opt(f.arr(f.obj(bookmarkEventRefShape))),
  color: f.opt(f.str),
  note: f.opt(f.str),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
  evidenceStatus: f.req(f.en(...BOOKMARK_EVIDENCE_STATUS)),
};

const findingViewRecipeShape: ObjectShape = {
  filters: f.req(
    f.obj({
      levels: f.req(f.arr(f.str)),
      sources: f.req(f.arr(f.str)),
      services: f.req(f.arr(f.str)),
      hosts: f.req(f.arr(f.str)),
      timeFrom: f.nul(f.i64),
      timeTo: f.nul(f.i64),
      seqFrom: f.nul(f.u64),
      seqTo: f.nul(f.u64),
      templateId: f.nul(f.u64),
      traceId: f.nul(f.str),
      keyword: f.nul(f.str),
    }),
  ),
  lanes: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        label: f.req(f.str),
        sources: f.req(f.arr(f.str)),
      }),
    ),
  ),
  visibleLaneCount: f.req(f.u64),
  linkMode: f.req(f.en(...FINDING_VIEW_TIME_LINK_MODE)),
  focusedLaneId: f.nul(f.str),
  focusedEvent: f.nul(f.obj(bookmarkEventRefShape)),
  selection: f.req(f.arr(f.obj(bookmarkEventRefShape))),
  highlights: f.req(f.arr(f.obj(bookmarkEventRefShape))),
  find: f.nul(
    f.obj({
      query: f.req(f.str),
      matchMode: f.req(f.en(...FINDING_VIEW_FIND_MATCH_MODE)),
      caseSensitive: f.req(f.bool),
      semantic: f.req(f.bool),
    }),
  ),
  viewportAnchors: f.req(
    f.arr(
      f.obj({
        laneId: f.req(f.str),
        eventRef: f.req(f.obj(bookmarkEventRefShape)),
      }),
    ),
  ),
};

const investigationPolicyBindingShape: ObjectShape = {
  suppressionPolicyRevision: f.req(f.u64),
  resolvedTemplateRevision: f.req(f.u64),
  effectivePolicySha256: f.req(f.str),
  noiseLens: f.req(f.en(...INVESTIGATION_NOISE_LENS)),
};

const proposedFindingShape: ObjectShape = {
  id: f.req(f.str),
  status: f.req(f.en(...PROPOSED_FINDING_STATUS)),
  kind: f.req(f.en(...FINDING_KIND)),
  title: f.req(f.str),
  whyItMatters: f.req(f.str),
  caveats: f.opt(f.str),
  evidence: f.req(
    f.arr(
      f.obj({
        eventRef: f.req(f.obj(bookmarkEventRefShape)),
        role: f.req(f.en(...PROPOSAL_EVIDENCE_ROLE)),
      }),
    ),
  ),
  viewRecipe: f.opt(f.obj(findingViewRecipeShape)),
  corpusId: f.req(f.str),
  investigationId: f.req(f.str),
  policyBinding: f.opt(f.obj(investigationPolicyBindingShape)),
  templateRevision: f.opt(f.u64),
  suppressionPolicyRevision: f.opt(f.u64),
  rankInputs: f.opt(
    f.obj({
      supportingCount: f.req(f.u64),
      contradictingCount: f.req(f.u64),
      timeSpanSecs: f.opt(f.u64),
      levelWeight: f.opt(f.u64),
    }),
  ),
  provenance: f.req(
    f.obj({
      source: f.req(f.en(...PROPOSAL_SOURCE_KIND)),
      provider: f.opt(f.str),
      modelId: f.opt(f.str),
      runId: f.opt(f.str),
      toolName: f.req(f.str),
      detectorId: f.opt(f.str),
    }),
  ),
  idempotencyKey: f.req(f.str),
  acceptance: f.opt(
    f.obj({
      acceptedAt: f.req(f.i64),
      edited: f.req(f.bool),
    }),
  ),
  dismissReason: f.opt(f.str),
  acceptedFindingId: f.opt(f.str),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
};

const investigationDocumentShape: ObjectShape = {
  schemaVersion: f.req(f.u64),
  id: f.req(f.str),
  revision: f.req(f.u64),
  title: f.req(f.str),
  status: f.req(f.en(...INVESTIGATION_STATUS)),
  corpusLinks: f.req(f.arr(f.obj({ corpusId: f.req(f.str) }))),
  evidence: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        title: f.req(f.str),
        provenance: f.req(f.en(...HUMAN_PROVENANCE)),
        corpusId: f.req(f.str),
        eventRefs: f.req(f.arr(f.obj(bookmarkEventRefShape))),
        createdAt: f.req(f.i64),
        updatedAt: f.req(f.i64),
      }),
    ),
  ),
  findings: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        kind: f.req(f.en(...FINDING_KIND)),
        lifecycle: f.req(f.en(...FINDING_LIFECYCLE)),
        title: f.req(f.str),
        whyItMatters: f.req(f.str),
        evidenceIds: f.req(f.arr(f.str)),
        viewRecipe: f.opt(f.obj(findingViewRecipeShape)),
        policyBinding: f.opt(f.obj(investigationPolicyBindingShape)),
        provenance: f.req(f.en(...HUMAN_PROVENANCE)),
        createdAt: f.req(f.i64),
        updatedAt: f.req(f.i64),
      }),
    ),
  ),
  notes: f.req(
    f.arr(
      f.obj({
        id: f.req(f.str),
        title: f.req(f.str),
        body: f.req(f.str),
        evidenceIds: f.req(f.arr(f.str)),
        findingIds: f.opt(f.arr(f.str)),
        provenance: f.req(f.en(...HUMAN_PROVENANCE)),
        createdAt: f.req(f.i64),
        updatedAt: f.req(f.i64),
      }),
    ),
  ),
  proposedFindings: f.req(f.arr(f.obj(proposedFindingShape))),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
};

const processProgressShape: ObjectShape = {
  kind: f.req(f.en(...PROCESS_PROGRESS_KIND)),
  phase: f.req(f.en(...PROCESS_PROGRESS_PHASE)),
  message: f.req(f.str),
  fraction: f.nul(f.unit),
  lines_processed: f.nul(f.u64),
  files_processed: f.nul(f.u64),
  bytes_processed: f.nul(f.u64),
  templates: f.nul(f.u64),
  cancellable: f.req(f.bool),
  elapsed_ms: f.opt(f.u64),
  phase_elapsed_ms: f.opt(f.u64),
};

const eventShape: ObjectShape = {
  kind: f.req(f.str),
  payload: f.req(f.json),
};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parserFor<T>(root: string, shape: ObjectShape) {
  return (value: unknown): T => {
    checkObject(root, shape, value);
    return value as T;
  };
}

function listParserFor<T>(root: string, shape: ObjectShape) {
  return (value: unknown): T[] => {
    checkValue(root, f.arr(f.obj(shape)), value);
    return value as T[];
  };
}

export const parseEventStream = listParserFor<WireEvent>("event", eventShape);
export const parseExplorerEvent = parserFor<WireExplorerEvent>(
  "explorerEvent",
  explorerEventShape,
);
export const parseEventPage = parserFor<WireEventPage>(
  "eventPage",
  eventPageShape,
);
export const parseEventRowsPage = parserFor<WireEventRowsPage>(
  "eventRowsPage",
  eventRowsPageShape,
);
export const parseEventCount = parserFor<WireEventCount>("eventCount", {
  totalMatched: f.req(f.u64),
});
export const parseLogFacets = parserFor<WireLogFacets>(
  "logFacets",
  logFacetsShape,
);
export const parseSharedTimelineSummary = parserFor<WireSharedTimelineSummary>(
  "sharedTimelineSummary",
  sharedTimelineSummaryShape,
);
export const parseSuppressionDocument = parserFor<WireSuppressionDocument>(
  "suppressionDocument",
  suppressionDocumentShape,
);
export const parseNoiseCandidateReport = parserFor<WireNoiseCandidateReport>(
  "noiseCandidateReport",
  noiseCandidateReportShape,
);
export const parseInvestigationDocument = parserFor<WireInvestigationDocument>(
  "investigationDocument",
  investigationDocumentShape,
);
export const parseResolvedBookmarks = listParserFor<WireResolvedBookmark>(
  "resolvedBookmark",
  resolvedBookmarkShape,
);
export const parseProcessProgressStream = listParserFor<WireProcessProgress>(
  "processProgress",
  processProgressShape,
);
export const parseBookmarkEventRef = parserFor<WireBookmarkEventRef>(
  "bookmarkEventRef",
  bookmarkEventRefShape,
);

/**
 * Committed fixture manifest: exact file set under `fixtures/contracts/` and
 * the strict parser proving each. Tests fail when the directory and this
 * manifest disagree in either direction, or when discovery yields zero files.
 */
export const FIXTURE_PARSERS: Readonly<
  Record<string, (value: unknown) => unknown>
> = {
  "event.v1.json": parseEventStream,
  "explorer_event.v1.json": parseExplorerEvent,
  "event_page.v1.json": parseEventPage,
  "event_rows_page.v1.json": parseEventRowsPage,
  "event_count.v1.json": parseEventCount,
  "log_facets.v1.json": parseLogFacets,
  "shared_timeline_summary.v1.json": parseSharedTimelineSummary,
  "suppression_document.v1.json": parseSuppressionDocument,
  "noise_candidate_report.v1.json": parseNoiseCandidateReport,
  "investigation_document.v1.json": parseInvestigationDocument,
  "resolved_bookmark.v1.json": parseResolvedBookmarks,
  "process_progress.v1.json": parseProcessProgressStream,
};
