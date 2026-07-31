/**
 * Private fixtures for visual/noise-suppress.test.tsx — owned by that suite
 * only. Deterministic DTOs adapted from the reference unit-test factories:
 * - policyDocument / suppressionPreview: NoisePolicy.test.tsx (policy(),
 *   preview() at src/components/logExplorer/NoisePolicy.test.tsx:13-93)
 * - noiseCandidate / candidateReport: NoiseCandidateReview.test.tsx
 *   (candidate(), report() at
 *   src/components/logExplorer/NoiseCandidateReview.test.tsx:34-108) — the
 *   ERROR-heavy bursty candidate carrying the `repetitive_error_risky` risk
 *   chip, "Showing 1 of 24" summary, and bounded-review limit notice.
 *
 * Type-only host imports: the suite mocks ../src/lib/host with a factory, and
 * `import type` is erased at runtime so these fixtures never touch the mock
 * boundary.
 */
import type {
  NoiseCandidateDto,
  NoiseCandidateReportDto,
  SuppressionDocumentDto,
  SuppressionMutationResultDto,
  SuppressionPreviewDto,
} from "../../src/lib/host";

/** One enabled human rule (templateId 22) at revision 7, matches_current. */
export function policyDocument(): SuppressionDocumentDto {
  return {
    schemaVersion: 1,
    corpusId: "c1",
    revision: 7,
    resolvedTemplateRevision: 11,
    rules: [
      {
        id: "rule-1",
        name: "Routine heartbeat",
        rationale: "Known repetitive health traffic.",
        predicate: {
          templateId: 22,
          templateFingerprint: "template-22",
        },
        origin: "human",
        state: "enabled",
        createdAt: 1,
        updatedAt: 2,
        resolution: {
          kind: "matches_current",
          matchesNothing: false,
          explanation: "Exact template matches the current corpus.",
        },
      },
    ],
    previews: [],
    audit: [
      {
        id: "audit-1",
        revision: 7,
        action: "activated",
        ruleId: "rule-1",
        previewToken: null,
        createdAt: 2,
      },
    ],
  };
}

/** Trusted impact preview: 250 matches, 25.0% of a 1,000-event corpus. */
export function suppressionPreview(): SuppressionPreviewDto {
  return {
    token: "preview-token",
    corpusId: "c1",
    eventRevision: 4,
    ruleRevision: 7,
    name: "Routine heartbeat",
    rationale: "Known repetitive health traffic.",
    predicate: {
      templateId: 22,
      templateFingerprint: "template-22",
    },
    origin: "human",
    matchingEventCount: 250,
    incrementalEventCount: 240,
    corpusEventCount: 1_000,
    levelCounts: [
      { level: "INFO", count: 245 },
      { level: "WARN", count: 5 },
    ],
    sourceCount: 3,
    timeSpan: { from: 1_700_000_000, to: 1_700_003_600 },
    representatives: [
      {
        seq: 44,
        source: "health.log",
        timestamp: 1_700_000_000,
        timeQuality: "wall",
        level: "INFO",
        redactedExcerpt: "heartbeat token=[REDACTED]",
      },
    ],
    createdAt: 3,
  };
}

/** ERROR-heavy bursty candidate with the risky-to-hide reason chip. */
export function noiseCandidate(): NoiseCandidateDto {
  return {
    templateId: 326,
    templateFingerprint: "template-326-fingerprint",
    pattern: "probe client closed before response route=<*>",
    score: 54,
    eventCount: 12_452,
    corpusShareBps: 498,
    sourceCount: 3,
    timeQuality: "wall",
    wallTimeSpan: { from: 1_735_732_800, to: 1_735_764_039 },
    orderSpan: null,
    levelCounts: [
      { level: "ERROR", count: 12_000 },
      { level: "WARN", count: 452 },
    ],
    otherLevelCount: 0,
    levelCountsTruncated: false,
    errorOrFatalCount: 12_000,
    warnCount: 452,
    infoCount: 0,
    reasonCodes: [
      "high_frequency",
      "multi_source_repetition",
      "repetitive_error_risky",
    ],
    explanation:
      "Proposal score 54 from corpus facts only (not confirmed noise). Human preview and activation required.",
    alreadySuppressed: false,
    shareBasis: "unsuppressed_events",
    proposalKind: "suppression_candidate",
    representatives: [
      {
        seq: 125_060,
        source: "edge/access.jsonl",
        timestamp: 1_735_732_800,
        timeQuality: "wall",
        level: "ERROR",
        redactedExcerpt: "probe client closed token=[REDACTED]",
      },
    ],
    shape: "bursty",
  };
}

/** Bounded review at policy revision 7: "Showing 1 of 24" + cap notice. */
export function candidateReport(
  overrides: Partial<NoiseCandidateReportDto> = {},
): NoiseCandidateReportDto {
  return {
    corpusId: "c1",
    unsuppressedEventCount: 250_000,
    corpusEventCount: 250_000,
    suppressionRevision: 7,
    eventRevision: 4,
    templateAnalysisRevision: 2,
    alreadySuppressedTemplateIds: [],
    timeQuality: "wall",
    rawTimeQuality: "wall",
    candidates: [noiseCandidate()],
    templatesScanned: 648,
    eligibleCandidateCount: 24,
    truncated: true,
    candidateCapTruncated: true,
    templateScanTruncated: false,
    responseBytesTruncated: false,
    metadataMissingTemplateIds: [],
    databaseQueryCount: 4,
    disclaimer: "Human review only. Nothing was auto-suppressed.",
    cancelled: false,
    ...overrides,
  };
}

export function mutationResult(): SuppressionMutationResultDto {
  return {
    revision: 8,
    rule: policyDocument().rules[0]!,
  };
}
