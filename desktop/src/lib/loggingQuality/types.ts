/**
 * Typed DTOs for deterministic Logging Quality Assessment.
 * Mirrors `cd-core` `LoggingQualityAssessment` camelCase wire form.
 * Frontend never re-scores; host returns this shape only.
 */

export type LoggingQualityGrade =
  | "excellent"
  | "good"
  | "fair"
  | "poor"
  | "insufficient";

export type LoggingQualityFindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export type LoggingQualityFindingCategory =
  | "timestamp_certainty"
  | "selection_coverage"
  | "parse_structure"
  | "stored_level_honesty"
  | "noise_concentration_review"
  | "trace_id_coverage"
  | "corpus";

export type LoggingQualityFindingConfidence = "high" | "medium" | "low";

export type LoggingQualityEvidenceKind =
  | "corpus_metric"
  | "source_aggregate"
  | "template"
  | "selection_bucket";

export type TimeQuality = "wall" | "mixed" | "order_only";

export type LoggingQualityEvidenceLocator = {
  kind: LoggingQualityEvidenceKind;
  key: string;
  value?: number | null;
  label: string;
};

export type LoggingQualityImprovementHint = {
  templateId: string;
  change: string;
  acceptanceCriteria: string[];
};

export type LoggingQualityFinding = {
  id: string;
  severity: LoggingQualityFindingSeverity;
  priority: number;
  category: LoggingQualityFindingCategory;
  title: string;
  measuredFact: string;
  finding: string;
  improvementHint: LoggingQualityImprovementHint;
  evidence: LoggingQualityEvidenceLocator[];
  confidence: LoggingQualityFindingConfidence;
  limitations: string[];
};

export type LoggingQualityDimensionScore = {
  id: string;
  label: string;
  score: number;
  weightBps: number;
  measuredFact: string;
};

export type LoggingQualitySelectionCoverage = {
  selectedImported: number;
  discovered: number;
  ignored: number;
  unsupported: number;
  excludedPolicy: number;
  failed: number;
  partial: boolean;
  exclusionReasonCounts: Record<string, number>;
  availabilityNote: string;
};

export type LoggingQualityTemplateRef = {
  templateId: number;
  eventCount: number;
};

export type LoggingQualityTemplateMetrics = {
  templateCount: number;
  eventCount: number;
  reductionRatio: number;
  topTemplateShareBps: number;
  concentrationHhiBps: number;
  topTemplateErrorOrFatalCount: number;
  topTemplates: LoggingQualityTemplateRef[];
  proposalNote: string;
};

export type LoggingQualityStoredLevelMetrics = {
  levelCounts: Record<string, number>;
  knownLevelCount: number;
  unknownLevelCount: number;
  knownLevelShareBps: number;
  severityProvenanceAvailable: boolean;
  honestyNote: string;
};

export type LoggingQualityTraceIdMetrics = {
  withTraceId: number;
  traceIdShareBps: number;
  availabilityNote: string;
};

export type LoggingQualityMetrics = {
  timeQuality: TimeQuality;
  timestampProvenanceCounts: Record<string, number>;
  activeTimestampBasisCounts: Record<string, number>;
  wallEventCount: number;
  orderOnlyEventCount: number;
  unresolvedLocalEventCount: number;
  selection: LoggingQualitySelectionCoverage;
  templates: LoggingQualityTemplateMetrics;
  storedLevel: LoggingQualityStoredLevelMetrics;
  traceId: LoggingQualityTraceIdMetrics;
  formatCounts: Record<string, number>;
};

export type LoggingQualitySourceMetrics = {
  sourceKey: string;
  eventCount: number;
  wallEventCount: number;
  orderOnlyEventCount: number;
  unresolvedLocalEventCount: number;
  withTraceId: number;
  unknownLevelCount: number;
  dominantLevel?: string | null;
};

export type LoggingQualityAssessment = {
  schemaId: string;
  schemaVersion: number;
  privacy: {
    redactionMode: string;
    policySummary: string;
    sourcesTruncated: boolean;
    inventoryCapped: boolean;
  };
  corpus: {
    id: string;
    name: string;
    eventCount: number;
    templateCount: number;
    partial: boolean;
  };
  summary: {
    overallScore: number;
    grade: LoggingQualityGrade;
    headline: string;
    dimensions: LoggingQualityDimensionScore[];
  };
  metrics: LoggingQualityMetrics;
  sources: LoggingQualitySourceMetrics[];
  findings: LoggingQualityFinding[];
  confidence: {
    level: LoggingQualityFindingConfidence;
    summary: string;
    nonClaims: string[];
  };
  limitations: string[];
};

/** Host response: assessment + Explorer bridge map. */
export type LoggingQualityAssessmentHostDto = {
  assessment: LoggingQualityAssessment;
  /** Opaque src_NNNN → portable relative source identity. */
  sourceKeyMap: Record<string, string>;
};

export type LoggingQualityExportStatus =
  | { status: "cancelled" }
  | { status: "written"; format: string; displayName: string }
  | { status: "failed"; reason: string };

export type LoggingQualityRunPhase =
  | "idle"
  | "running"
  | "ready"
  | "exporting"
  | "failed"
  | "cancelled";
