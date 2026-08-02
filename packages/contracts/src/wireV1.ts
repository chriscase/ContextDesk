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
import { parseModelOptions } from "./modelCurationV1";

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

/** `cd_core::investigations::ReportSectionKind` (snake_case). */
export const REPORT_SECTION_KIND = [
  "executive_summary",
  "unresolved_questions",
  "next_actions",
] as const;
export type ReportSectionKind = (typeof REPORT_SECTION_KIND)[number];

/** `cd_core::investigations::EvidenceReferenceStatus` (snake_case). */
export const EVIDENCE_REFERENCE_STATUS = [
  "verified",
  "missing",
  "stale",
] as const;
export type EvidenceReferenceStatus = (typeof EVIDENCE_REFERENCE_STATUS)[number];

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
  reportSections: WireReportSectionItem[];
  proposedReportSections: WireProposedReportSectionItem[];
  createdAt: number;
  updatedAt: number;
};

/** `cd_core::investigations::ReportSectionItem` (schema v6, #532). */
export type WireReportSectionItem = {
  id: string;
  kind: ReportSectionKind;
  body: string;
  evidenceIds?: string[];
  findingIds?: string[];
  noteIds?: string[];
  provenance: HumanProvenance;
  acceptedFromProposalId?: string;
  createdAt: number;
  updatedAt: number;
};

/** `cd_core::investigations::ProposedReportSectionItem` (schema v6, #532). */
export type WireProposedReportSectionItem = {
  id: string;
  status: ProposedFindingStatus;
  kind: ReportSectionKind;
  body: string;
  evidenceIds?: string[];
  findingIds?: string[];
  noteIds?: string[];
  corpusId: string;
  investigationId: string;
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
  acceptedSectionId?: string;
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
  noiseLens: InvestigationNoiseLens | null;
};

export type WireProposalProvenance = {
  source: ProposalSourceKind;
  provider?: string;
  modelId?: string;
  runId?: string;
  toolName: string;
  detectorId?: string;
};

export type WireHumanProposalAcceptance = {
  acceptedAt: number;
  edited: boolean;
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

/** `cd_core::investigations::ReportCurrentPolicy`. */
export type WireReportCurrentPolicy = {
  suppressionPolicyRevision: number;
  resolvedTemplateRevision: number;
  effectivePolicySha256: string;
  noiseLens: InvestigationNoiseLens | null;
};

/** `cd_core::investigations::ReportTimeWindow`. */
export type WireReportTimeWindow = {
  minTimestampHint: number;
  maxTimestampHint: number;
  mixedQuality: boolean;
};

/** `cd_core::investigations::ReportScope`. */
export type WireReportScope = {
  corpusIds: string[];
  evidenceCount: number;
  findingCount: number;
  noteCount: number;
  timeWindow?: WireReportTimeWindow;
};

/** `cd_core::investigations::ReportAuthoredSection`. */
export type WireReportAuthoredSection = {
  sectionId: string;
  body: string;
  evidenceIds: string[];
  findingIds: string[];
  noteIds: string[];
  acceptedFromProposalId?: string;
  acceptedProposalProvenance?: WireProposalProvenance;
  acceptedProposalAcceptance?: WireHumanProposalAcceptance;
  updatedAt: number;
};

/** `cd_core::investigations::ReportSections` — fixed authorable slots. */
export type WireReportSections = {
  executiveSummary?: WireReportAuthoredSection;
  unresolvedQuestions?: WireReportAuthoredSection;
  nextActions?: WireReportAuthoredSection;
};

/** `cd_core::investigations::ReportEventReference` — exact identity + status. */
export type WireReportEventReference = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
  status: EvidenceReferenceStatus;
};

/** `cd_core::investigations::ReportFindingCitation`. */
export type WireReportFindingCitation = {
  evidenceId: string;
  evidenceTitle: string;
  references: WireReportEventReference[];
};

/** `cd_core::investigations::ReportFindingEntry`. */
export type WireReportFindingEntry = {
  findingId: string;
  kind: FindingKind;
  lifecycle: FindingLifecycle;
  title: string;
  whyItMatters: string;
  policyBindingStatus: InvestigationPolicyBindingStatus;
  hasSavedView: boolean;
  citations: WireReportFindingCitation[];
  createdAt: number;
};

/** `cd_core::investigations::ReportTimelineEntry`. */
export type WireReportTimelineEntry = {
  corpusId: string;
  seq: number;
  source: string;
  timestampHint: number;
  timeQualityHint: TimeQuality;
  evidenceId: string;
  evidenceTitle: string;
  status: EvidenceReferenceStatus;
};

/** `cd_core::investigations::ReportTimeline` — bounded with omitted count. */
export type WireReportTimeline = {
  entries: WireReportTimelineEntry[];
  omittedCount: number;
};

/**
 * `cd_core::investigations::InvestigationReport` — the versioned, payload-free
 * report projection (#532). Proposals never appear in this projection.
 */
export type WireInvestigationReport = {
  schemaVersion: number;
  investigationId: string;
  title: string;
  status: InvestigationStatus;
  sourceRevision: number;
  generatedAt: number;
  currentPolicy?: WireReportCurrentPolicy;
  scope: WireReportScope;
  sections: WireReportSections;
  findings: WireReportFindingEntry[];
  timeline: WireReportTimeline;
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

/** `cd_core::investigations::ProposalProvenance` (shared by both proposal kinds). */
const proposalProvenanceShape: ObjectShape = {
  source: f.req(f.en(...PROPOSAL_SOURCE_KIND)),
  provider: f.opt(f.str),
  modelId: f.opt(f.str),
  runId: f.opt(f.str),
  toolName: f.req(f.str),
  detectorId: f.opt(f.str),
};

/** `cd_core::investigations::HumanProposalAcceptance` (shared). */
const proposalAcceptanceShape: ObjectShape = {
  acceptedAt: f.req(f.i64),
  edited: f.req(f.bool),
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
  provenance: f.req(f.obj(proposalProvenanceShape)),
  idempotencyKey: f.req(f.str),
  acceptance: f.opt(f.obj(proposalAcceptanceShape)),
  dismissReason: f.opt(f.str),
  acceptedFindingId: f.opt(f.str),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
};

/** Schema v6 (#532): durable authored report section. */
const reportSectionItemShape: ObjectShape = {
  id: f.req(f.str),
  kind: f.req(f.en(...REPORT_SECTION_KIND)),
  body: f.req(f.str),
  evidenceIds: f.opt(f.arr(f.str)),
  findingIds: f.opt(f.arr(f.str)),
  noteIds: f.opt(f.arr(f.str)),
  provenance: f.req(f.en(...HUMAN_PROVENANCE)),
  acceptedFromProposalId: f.opt(f.str),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
};

/** Schema v6 (#532): durable proposed report section awaiting human review. */
const proposedReportSectionItemShape: ObjectShape = {
  id: f.req(f.str),
  status: f.req(f.en(...PROPOSED_FINDING_STATUS)),
  kind: f.req(f.en(...REPORT_SECTION_KIND)),
  body: f.req(f.str),
  evidenceIds: f.opt(f.arr(f.str)),
  findingIds: f.opt(f.arr(f.str)),
  noteIds: f.opt(f.arr(f.str)),
  corpusId: f.req(f.str),
  investigationId: f.req(f.str),
  provenance: f.req(f.obj(proposalProvenanceShape)),
  idempotencyKey: f.req(f.str),
  acceptance: f.opt(f.obj(proposalAcceptanceShape)),
  dismissReason: f.opt(f.str),
  acceptedSectionId: f.opt(f.str),
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
  reportSections: f.req(f.arr(f.obj(reportSectionItemShape))),
  proposedReportSections: f.req(f.arr(f.obj(proposedReportSectionItemShape))),
  createdAt: f.req(f.i64),
  updatedAt: f.req(f.i64),
};

/** `cd_core::investigations::ReportAuthoredSection` (projection). */
const reportAuthoredSectionShape: ObjectShape = {
  sectionId: f.req(f.str),
  body: f.req(f.str),
  evidenceIds: f.req(f.arr(f.str)),
  findingIds: f.req(f.arr(f.str)),
  noteIds: f.req(f.arr(f.str)),
  acceptedFromProposalId: f.opt(f.str),
  acceptedProposalProvenance: f.opt(f.obj(proposalProvenanceShape)),
  acceptedProposalAcceptance: f.opt(f.obj(proposalAcceptanceShape)),
  updatedAt: f.req(f.i64),
};

/** `cd_core::investigations::ReportEventReference` (projection). */
const reportEventReferenceShape: ObjectShape = {
  corpusId: f.req(f.str),
  seq: f.req(f.u64),
  source: f.req(f.str),
  timestampHint: f.req(f.i64),
  timeQualityHint: f.req(timeQuality),
  status: f.req(f.en(...EVIDENCE_REFERENCE_STATUS)),
};

/** `cd_core::investigations::InvestigationReport` (#532). */
const investigationReportShape: ObjectShape = {
  schemaVersion: f.req(f.u64),
  investigationId: f.req(f.str),
  title: f.req(f.str),
  status: f.req(f.en(...INVESTIGATION_STATUS)),
  sourceRevision: f.req(f.u64),
  generatedAt: f.req(f.i64),
  currentPolicy: f.opt(
    f.obj({
      suppressionPolicyRevision: f.req(f.u64),
      resolvedTemplateRevision: f.req(f.u64),
      effectivePolicySha256: f.req(f.str),
      noiseLens: f.nul(f.en(...INVESTIGATION_NOISE_LENS)),
    }),
  ),
  scope: f.req(
    f.obj({
      corpusIds: f.req(f.arr(f.str)),
      evidenceCount: f.req(f.u64),
      findingCount: f.req(f.u64),
      noteCount: f.req(f.u64),
      timeWindow: f.opt(
        f.obj({
          minTimestampHint: f.req(f.i64),
          maxTimestampHint: f.req(f.i64),
          mixedQuality: f.req(f.bool),
        }),
      ),
    }),
  ),
  sections: f.req(
    f.obj({
      executiveSummary: f.opt(f.obj(reportAuthoredSectionShape)),
      unresolvedQuestions: f.opt(f.obj(reportAuthoredSectionShape)),
      nextActions: f.opt(f.obj(reportAuthoredSectionShape)),
    }),
  ),
  findings: f.req(
    f.arr(
      f.obj({
        findingId: f.req(f.str),
        kind: f.req(f.en(...FINDING_KIND)),
        lifecycle: f.req(f.en(...FINDING_LIFECYCLE)),
        title: f.req(f.str),
        whyItMatters: f.req(f.str),
        policyBindingStatus: f.req(f.en(...INVESTIGATION_POLICY_BINDING_STATUS)),
        hasSavedView: f.req(f.bool),
        citations: f.req(
          f.arr(
            f.obj({
              evidenceId: f.req(f.str),
              evidenceTitle: f.req(f.str),
              references: f.req(f.arr(f.obj(reportEventReferenceShape))),
            }),
          ),
        ),
        createdAt: f.req(f.i64),
      }),
    ),
  ),
  timeline: f.req(
    f.obj({
      entries: f.req(
        f.arr(
          f.obj({
            corpusId: f.req(f.str),
            seq: f.req(f.u64),
            source: f.req(f.str),
            timestampHint: f.req(f.i64),
            timeQualityHint: f.req(timeQuality),
            evidenceId: f.req(f.str),
            evidenceTitle: f.req(f.str),
            status: f.req(f.en(...EVIDENCE_REFERENCE_STATUS)),
          }),
        ),
      ),
      omittedCount: f.req(f.u64),
    }),
  ),
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
export const parseInvestigationReport = parserFor<WireInvestigationReport>(
  "investigationReport",
  investigationReportShape,
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

/* ------------------------------------------------------------------ *
 * Import preview + ImportProfile v1 (#751 / #763)
 *
 * Mirrors `cd_core::log_analysis::import_preview` and `::import_profile`.
 * Casing follows the house wire style: camelCase struct fields with
 * snake_case enum values.
 * ------------------------------------------------------------------ */

/** Disposition of one previewed file or archive member. */
export const IMPORT_ITEM_STATUS = [
  "ready",
  "review",
  "raw_fallback",
  "supporting",
  "ignored",
  "unsupported",
  "blocked",
] as const;
export type ImportItemStatus = (typeof IMPORT_ITEM_STATUS)[number];

/**
 * Proposed handling role. Values match the Incident Evidence Bundle
 * manifest `role` vocabulary so a bundle declaration needs no translation.
 */
export const IMPORT_ITEM_ROLE = [
  "log",
  "operational_metrics",
  "attachment",
  "readme",
  "unknown",
] as const;
export type ImportItemRole = (typeof IMPORT_ITEM_ROLE)[number];

/** What the user selected for preview. */
export const IMPORT_SOURCE_KIND = ["file", "directory", "archive"] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KIND)[number];

/** Machine-readable explanation for an item's status. */
export const IMPORT_PREVIEW_REASON = [
  "manifest_declared",
  "strong_format_match",
  "ambiguous_format_match",
  "mixed_format_records",
  "no_structured_match",
  "binary_content",
  "empty_content",
  "oversized",
  "hidden",
  "symlink_rejected",
  "non_regular_rejected",
  "archive_depth_exceeded",
  "compression_ratio_exceeded",
  "traversal_rejected",
  "duplicate_identity",
  "encrypted_entry",
  "read_failed",
  "metrics_document",
  "readme_document",
  "weak_name_hint_only",
  "nested_archive_not_inventoried",
] as const;
export type ImportPreviewReason = (typeof IMPORT_PREVIEW_REASON)[number];

/** Three-valued deterministic fingerprint outcome. */
export const IMPORT_FORMAT_OUTCOME = [
  "matched",
  "ambiguous",
  "unknown",
] as const;
export type ImportFormatOutcome = (typeof IMPORT_FORMAT_OUTCOME)[number];

const importPreviewItemShape: ObjectShape = {
  identity: f.req(f.str),
  basename: f.req(f.str),
  bytes: f.req(f.u64),
  status: f.req(f.en(...IMPORT_ITEM_STATUS)),
  role: f.req(f.en(...IMPORT_ITEM_ROLE)),
  selected: f.req(f.bool),
  formatId: f.opt(f.str),
  formatVersion: f.opt(f.u64),
  outcome: f.opt(f.en(...IMPORT_FORMAT_OUTCOME)),
  score: f.opt(f.u64),
  runnerUpMargin: f.opt(f.u64),
  producerHint: f.opt(f.str),
  decisiveClueCodes: f.opt(f.arr(f.str)),
  reasons: f.req(f.arr(f.en(...IMPORT_PREVIEW_REASON))),
  representative: f.opt(f.str),
  groupId: f.opt(f.str),
};

const importPreviewReportShape: ObjectShape = {
  schemaVersion: f.req(f.u64),
  sourceKind: f.req(f.en(...IMPORT_SOURCE_KIND)),
  items: f.req(f.arr(f.obj(importPreviewItemShape))),
  groups: f.opt(
    f.arr(
      f.obj({
        groupId: f.req(f.str),
        stem: f.req(f.str),
        formatId: f.req(f.str),
        formatVersion: f.req(f.u64),
        memberIdentities: f.req(f.arr(f.str)),
        possibleOverlap: f.req(f.bool),
      }),
    ),
  ),
  counts: f.req(
    f.obj({
      total: f.req(f.u64),
      selected: f.req(f.u64),
      ready: f.req(f.u64),
      review: f.req(f.u64),
      rawFallback: f.req(f.u64),
      supporting: f.req(f.u64),
      ignored: f.req(f.u64),
      unsupported: f.req(f.u64),
      blocked: f.req(f.u64),
    }),
  ),
  truncated: f.req(f.bool),
  manifest: f.opt(
    f.obj({
      schemaId: f.req(f.str),
      valid: f.req(f.bool),
      declaredComponents: f.req(f.u64),
      diagnosticCodes: f.opt(f.arr(f.str)),
    }),
  ),
};

/** One previewed file or archive member. */
export type WireImportPreviewItem = {
  identity: string;
  basename: string;
  bytes: number;
  status: ImportItemStatus;
  role: ImportItemRole;
  selected: boolean;
  formatId?: string;
  formatVersion?: number;
  outcome?: ImportFormatOutcome;
  score?: number;
  runnerUpMargin?: number;
  producerHint?: string;
  decisiveClueCodes?: string[];
  reasons: ImportPreviewReason[];
  representative?: string;
  groupId?: string;
};

/** Bounded preview of one import source. */
export type WireImportPreviewReport = {
  schemaVersion: number;
  sourceKind: ImportSourceKind;
  items: WireImportPreviewItem[];
  groups?: {
    groupId: string;
    stem: string;
    formatId: string;
    formatVersion: number;
    memberIdentities: string[];
    possibleOverlap: boolean;
  }[];
  counts: {
    total: number;
    selected: number;
    ready: number;
    review: number;
    rawFallback: number;
    supporting: number;
    ignored: number;
    unsupported: number;
    blocked: number;
  };
  truncated: boolean;
  manifest?: {
    schemaId: string;
    valid: boolean;
    declaredComponents: number;
    diagnosticCodes?: string[];
  };
};

const profileRefShape: ObjectShape = {
  id: f.req(f.str),
  version: f.req(f.u64),
};

const importProfileShape: ObjectShape = {
  schemaId: f.req(f.str),
  minReaderVersion: f.req(f.u64),
  profileId: f.req(f.str),
  version: f.req(f.u64),
  scope: f.req(f.obj({ label: f.req(f.str) })),
  name: f.req(f.str),
  sourceGroups: f.req(
    f.arr(
      f.obj({
        groupId: f.req(f.str),
        include: f.req(f.arr(f.str)),
        exclude: f.opt(f.arr(f.str)),
        role: f.req(f.en(...IMPORT_ITEM_ROLE)),
        formatProfile: f.opt(f.obj(profileRefShape)),
        framingProfile: f.opt(f.obj(profileRefShape)),
        timestampPolicy: f.opt(f.str),
      }),
    ),
  ),
};

/** Whether a recipe expectation held, drifted, or conflicted. */
export const PROFILE_FINDING_KIND = ["match", "drift", "conflict"] as const;
export type ProfileFindingKind = (typeof PROFILE_FINDING_KIND)[number];

/** Why a recipe finding was raised. */
export const PROFILE_DIAGNOSTIC_CODE = [
  "schema_id_invalid",
  "reader_too_old",
  "min_reader_version_invalid",
  "identifier_invalid",
  "version_invalid",
  "no_source_groups",
  "too_many_groups",
  "duplicate_group_id",
  "too_many_patterns",
  "group_has_no_includes",
  "pattern_empty",
  "pattern_too_long",
  "pattern_too_many_wildcards",
  "pattern_too_many_segments",
  "pattern_not_relative",
  "pattern_traversal",
  "pattern_control_character",
  "pattern_empty_segment",
  "pattern_empty_segment",
  "profile_ref_invalid",
  "document_too_large",
] as const;
export type ProfileDiagnosticCode = (typeof PROFILE_DIAGNOSTIC_CODE)[number];

export const PROFILE_APPLICABILITY = [
  "applicable",
  "not_applicable",
  "incomplete",
] as const;
export type ProfileApplicability = (typeof PROFILE_APPLICABILITY)[number];

export const PROFILE_FINDING_REASON = [
  "format_agrees",
  "format_disagrees",
  "format_unconfirmed",
  "no_format_expectation",
  "pattern_matched_nothing",
  "role_conflict",
  "format_conflict",
  "item_blocked",
  "role_incompatible_with_status",
  "preview_truncated",
] as const;
export type ProfileFindingReason = (typeof PROFILE_FINDING_REASON)[number];

const profileValidationShape: ObjectShape = {
  valid: f.req(f.bool),
  diagnostics: f.opt(
    f.arr(
      f.obj({
        code: f.req(f.en(...PROFILE_DIAGNOSTIC_CODE)),
        location: f.req(f.str),
      }),
    ),
  ),
};

const profileMatchReportShape: ObjectShape = {
  profile: f.req(
    f.obj({
      profileId: f.req(f.str),
      version: f.req(f.u64),
      digest: f.req(f.str),
    }),
  ),
  clean: f.req(f.bool),
  applicability: f.req(f.en(...PROFILE_APPLICABILITY)),
  validation: f.req(f.obj(profileValidationShape)),
  findings: f.req(
    f.arr(
      f.obj({
        kind: f.req(f.en(...PROFILE_FINDING_KIND)),
        reason: f.req(f.en(...PROFILE_FINDING_REASON)),
        groupId: f.req(f.str),
        identity: f.opt(f.str),
        expectedFormatId: f.opt(f.str),
        observedFormatId: f.opt(f.str),
      }),
    ),
  ),
  proposedRoles: f.req(f.map(f.en(...IMPORT_ITEM_ROLE))),
};

/** A portable, declarative, versioned import plan. */
export type WireImportProfile = {
  schemaId: string;
  minReaderVersion: number;
  profileId: string;
  version: number;
  scope: { label: string };
  name: string;
  sourceGroups: {
    groupId: string;
    include: string[];
    exclude?: string[];
    role: ImportItemRole;
    formatProfile?: { id: string; version: number };
    framingProfile?: { id: string; version: number };
    timestampPolicy?: string;
  }[];
};

/**
 * Result of matching a recipe against a preview.
 *
 * `proposedRoles` is a proposal only — nothing has been applied, and a
 * `formatProfile` reference is reported as a match only where observed
 * content already agrees.
 */
export type WireProfileMatchReport = {
  profile: { profileId: string; version: number; digest: string };
  clean: boolean;
  applicability: ProfileApplicability;
  validation: {
    valid: boolean;
    diagnostics?: { code: ProfileDiagnosticCode; location: string }[];
  };
  findings: {
    kind: ProfileFindingKind;
    reason: ProfileFindingReason;
    groupId: string;
    identity?: string;
    expectedFormatId?: string;
    observedFormatId?: string;
  }[];
  proposedRoles: Record<string, ImportItemRole>;
};

/** A reviewed preview plus the plan binding a run to exactly this inventory. */
export type WireImportPreviewPlan = {
  report: WireImportPreviewReport;
  planToken: string;
  planVersion: number;
};

const importPreviewPlanShape: ObjectShape = {
  report: f.req(f.obj(importPreviewReportShape)),
  planToken: f.req(f.str),
  planVersion: f.req(f.u64),
};

export const parseImportPreviewPlan = parserFor<WireImportPreviewPlan>(
  "importPreviewPlan",
  importPreviewPlanShape,
);

export const parseImportPreviewReport = parserFor<WireImportPreviewReport>(
  "importPreviewReport",
  importPreviewReportShape,
);
export const parseImportProfile = parserFor<WireImportProfile>(
  "importProfile",
  importProfileShape,
);
export const parseProfileMatchReport = parserFor<WireProfileMatchReport>(
  "profileMatchReport",
  profileMatchReportShape,
);

/* ------------------------------------------------------------------ *
 * Reviewed format profiles (contextdesk.reviewed_format.v1)
 *
 * Mirrors `cd_core::log_analysis::reviewed_format`. A reviewed format is a
 * bounded grammar a user confirms for their own log shape; there is no user
 * regex, only this closed token vocabulary.
 * ------------------------------------------------------------------ */

/** Timestamp grammar tokens. `literal` carries its own character. */
export const TIME_TOKEN_SIMPLE = [
  "year4",
  "month2",
  "day2",
  "hour24",
  "minute2",
  "second2",
  "millis3",
  "micros6",
  "offset",
] as const;
export type TimeTokenSimple = (typeof TIME_TOKEN_SIMPLE)[number];
export type TimeToken = TimeTokenSimple | { literal: string };

/** Field slots applied left to right after the timestamp. */
export const FIELD_SLOT_SIMPLE = ["whitespace", "level", "message"] as const;
export type FieldSlotSimple = (typeof FIELD_SLOT_SIMPLE)[number];
export type FieldSlot =
  | FieldSlotSimple
  | { literal: string }
  | { logger: { open: string | null; close: string | null } }
  | { thread: { open: string | null; close: string | null } };

/** How continuation lines are attributed. */
export const MULTILINE_RULE = [
  "none",
  "continuation_until_next_timestamp",
] as const;
export type MultilineRule = (typeof MULTILINE_RULE)[number];

/**
 * Timestamp provenance. `unresolved_local` means calendar text only — a
 * reviewed format never converts it; the reviewed-declaration path does.
 */
export const REVIEWED_TIMESTAMP_PROVENANCE = [
  "explicit_wall_clock",
  "unresolved_local",
  "order_only",
  "legacy_unknown",
] as const;
export type ReviewedTimestampProvenance =
  (typeof REVIEWED_TIMESTAMP_PROVENANCE)[number];

/** A simple token string, or `{ literal: "<char>" }`. */
const isTimeToken = (value: unknown): boolean =>
  (typeof value === "string" &&
    (TIME_TOKEN_SIMPLE as readonly string[]).includes(value)) ||
  (typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { literal?: unknown }).literal === "string");

/** A simple slot string, or a single-key object for literal/logger/thread. */
const isFieldSlot = (value: unknown): boolean => {
  if (typeof value === "string") {
    return (FIELD_SLOT_SIMPLE as readonly string[]).includes(value);
  }
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys;
  const inner = (value as Record<string, unknown>)[key];
  if (key === "literal") return typeof inner === "string";
  if (key !== "logger" && key !== "thread") return false;
  if (typeof inner !== "object" || inner === null) return false;
  const delims = inner as { open?: unknown; close?: unknown };
  const ok = (d: unknown) => d === null || typeof d === "string";
  return ok(delims.open) && ok(delims.close);
};

const reviewedFormatShape: ObjectShape = {
  schemaId: f.req(f.str),
  minReaderVersion: f.req(f.u64),
  formatId: f.req(f.str),
  version: f.req(f.u64),
  name: f.req(f.str),
  pathPatterns: f.opt(f.arr(f.str)),
  // The closed vocabulary is enforced here, not merely advertised: a token or
  // slot outside it must fail at the boundary, because "a reviewed format is
  // not code" is only true if the wire refuses anything the grammar cannot
  // express. `f.json` accepted arbitrary values.
  timestamp: f.req(f.obj({ tokens: f.req(f.arr(f.pred("timeToken", isTimeToken))) })),
  layout: f.req(f.arr(f.pred("fieldSlot", isFieldSlot))),
  multiline: f.req(f.en(...MULTILINE_RULE)),
  priority: f.req(f.u64),
  suggestedTimezone: f.opt(f.str),
};

const reviewedFormatPreviewShape: ObjectShape = {
  formatId: f.req(f.str),
  version: f.req(f.u64),
  linesInspected: f.req(f.u64),
  recordsMatched: f.req(f.u64),
  linesUnattributed: f.req(f.u64),
  linesDropped: f.req(f.u64),
  formatValid: f.req(f.bool),
  provenance: f.req(f.en(...REVIEWED_TIMESTAMP_PROVENANCE)),
  needsTimezoneReview: f.req(f.bool),
  samples: f.opt(
    f.arr(
      f.obj({
        fields: f.req(
          f.obj({
            timestampText: f.req(f.str),
            provenance: f.req(f.en(...REVIEWED_TIMESTAMP_PROVENANCE)),
            level: f.opt(f.str),
            logger: f.opt(f.str),
            thread: f.opt(f.str),
            message: f.req(f.str),
          }),
        ),
        continuation: f.opt(f.arr(f.str)),
        startLine: f.req(f.u64),
        truncated: f.opt(f.bool),
        linesDropped: f.opt(f.u64),
      }),
    ),
  ),
};

/** A bounded, user-confirmable line grammar. */
export type WireReviewedFormat = {
  schemaId: string;
  minReaderVersion: number;
  formatId: string;
  version: number;
  name: string;
  pathPatterns?: string[];
  timestamp: { tokens: TimeToken[] };
  layout: FieldSlot[];
  multiline: MultilineRule;
  priority: number;
  /** Inert. Recorded, never applied. */
  suggestedTimezone?: string;
};

/** What a grammar would do to a sample. Nothing is applied. */
export type WireReviewedFormatPreview = {
  formatId: string;
  version: number;
  linesInspected: number;
  recordsMatched: number;
  linesUnattributed: number;
  /** Continuation lines dropped at the cap, across ALL records. */
  linesDropped: number;
  /** False when the format failed validation. */
  formatValid: boolean;
  provenance: ReviewedTimestampProvenance;
  /** True when a reviewed IANA declaration is still required. */
  needsTimezoneReview: boolean;
  samples?: {
    fields: {
      timestampText: string;
      provenance: ReviewedTimestampProvenance;
      level?: string;
      logger?: string;
      thread?: string;
      message: string;
    };
    continuation?: string[];
    startLine: number;
    truncated?: boolean;
    linesDropped?: number;
  }[];
};

export const parseReviewedFormat = parserFor<WireReviewedFormat>(
  "reviewedFormat",
  reviewedFormatShape,
);
export const parseReviewedFormatPreview = parserFor<WireReviewedFormatPreview>(
  "reviewedFormatPreview",
  reviewedFormatPreviewShape,
);

/**
 * Committed fixture manifest: exact file set under `fixtures/contracts/` and
 * the strict parser proving each. Tests fail when the directory and this
 * manifest disagree in either direction, or when discovery yields zero files.
 */
export const FIXTURE_PARSERS: Readonly<
  Record<string, (value: unknown) => unknown>
> = {
  "model_options.v1.json": parseModelOptions,
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
  "investigation_report.v1.json": parseInvestigationReport,
  "resolved_bookmark.v1.json": parseResolvedBookmarks,
  "process_progress.v1.json": parseProcessProgressStream,
  "reviewed_format.v1.json": parseReviewedFormat,
  "reviewed_format_preview.v1.json": parseReviewedFormatPreview,
  "import_preview_report.v1.json": parseImportPreviewReport,
  "import_preview_plan.v1.json": parseImportPreviewPlan,
  "import_profile.v1.json": parseImportProfile,
  "profile_match_report.v1.json": parseProfileMatchReport,
};
