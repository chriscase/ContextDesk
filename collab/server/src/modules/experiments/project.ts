import {
  AGREEMENT_NOT_CORRECTNESS,
  EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID,
  parseExperimentReviewExport,
  type ExperimentAgreementV1,
  type ExperimentCandidateV1,
  type ExperimentDecisionV1,
  type ExperimentReviewExportV1,
  type HelpfulnessObservationV1,
} from "@cd-collab/contracts";
import { assertShareSafeClean } from "../export/index.js";

export interface ReviewExportSource {
  packageId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
  observations: HelpfulnessObservationV1[];
  decisions: ExperimentDecisionV1[];
}

const FORBIDDEN_EXPORT_KEYS = [
  "rawModelCapture",
  "prompt",
  "prompts",
  "apiKey",
  "api_key",
  "endpoint",
  "baseUrl",
  "base_url",
  "requestId",
  "request_id",
  "x-request-id",
  "authorization",
  "credential",
];

export function projectCandidateMatrix(candidates: ExperimentCandidateV1[]): ExperimentCandidateV1[] {
  return candidates.map((c) => ({
    candidateId: c.candidateId,
    modelLabel: c.modelLabel,
    role: c.role,
    runStatus: c.runStatus,
    observedLatency: c.observedLatency,
    cost: { status: "unknown" },
    usage: { status: "unknown" },
    helpfulnessState: c.helpfulnessState,
    goldState: c.goldState === "absent" ? "absent" : "unknown",
  }));
}

function shareSafeObservation(row: HelpfulnessObservationV1): HelpfulnessObservationV1 {
  return {
    ...row,
    reviewerId: "participant",
    evidenceRefs: [...row.evidenceRefs],
  };
}

function shareSafeDecision(row: ExperimentDecisionV1): ExperimentDecisionV1 {
  return {
    ...row,
    authorId: "participant",
    evidenceRefs: [...row.evidenceRefs],
  };
}

export function projectReviewExport(view: ReviewExportSource): ExperimentReviewExportV1 {
  const accepted = [...view.decisions].reverse().find((d) => d.status === "accepted") ?? null;
  const payload = parseExperimentReviewExport({
    schemaId: EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID,
    privacyClass: "share_safe",
    packageId: view.packageId,
    taskFingerprint: view.taskFingerprint,
    snapshotFingerprint: view.snapshotFingerprint,
    candidates: projectCandidateMatrix(view.candidates),
    agreement: view.agreement,
    observations: view.observations.map(shareSafeObservation),
    decision: accepted ? shareSafeDecision(accepted) : null,
    notes: view.agreement.notes.includes(AGREEMENT_NOT_CORRECTNESS)
      ? [...view.agreement.notes]
      : [AGREEMENT_NOT_CORRECTNESS, ...view.agreement.notes],
  });
  assertNoForbiddenKeys(payload);
  assertShareSafeClean(payload, JSON.stringify(payload), []);
  return payload;
}

function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EXPORT_KEYS.includes(key)) {
      throw new Error(`share-safe export forbids ${path}.${key}`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}
