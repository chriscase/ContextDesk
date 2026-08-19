import { checkObject, f, type ObjectShape, ContractViolation } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";

export const EXPERIMENT_PACKAGE_SCHEMA_ID = "cd-collab.experiment_package.v1" as const;
export const EXPERIMENT_SUMMARY_SCHEMA_ID = "cd-collab.experiment_summary.v1" as const;
export const HELPFULNESS_OBSERVATION_SCHEMA_ID =
  "cd-collab.helpfulness_observation.v1" as const;
export const EXPERIMENT_DECISION_SCHEMA_ID = "cd-collab.experiment_decision.v1" as const;
export const EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID =
  "cd-collab.experiment_review_export.v1" as const;

export const AGREEMENT_NOT_CORRECTNESS =
  "Agreement is not proof of correctness." as const;

export const CANDIDATE_ROLES = [
  "contributor",
  "finalizer",
  "reviewer",
  "single",
] as const;
export type CandidateRole = (typeof CANDIDATE_ROLES)[number];

export const RUN_STATUSES = ["completed", "failed", "partial", "timeout"] as const;
export type ExperimentRunStatus = (typeof RUN_STATUSES)[number];

export const HELPFULNESS_STATES = ["unreviewed", "observed"] as const;
export type HelpfulnessState = (typeof HELPFULNESS_STATES)[number];

export const GOLD_STATES = ["unknown", "absent"] as const;
export type GoldState = (typeof GOLD_STATES)[number];

export const HELPFULNESS_DIMENSIONS = [
  "evidence_support",
  "actionability",
  "uncertainty_calibration",
  "unsafe_unsupported_claims",
] as const;
export type HelpfulnessDimension = (typeof HELPFULNESS_DIMENSIONS)[number];

export const DECISION_STATUSES = ["proposed", "accepted"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const UNKNOWN_MEASUREMENT = { status: "unknown" } as const;
export type UnknownMeasurement = typeof UNKNOWN_MEASUREMENT;

export type ObservedLatencyV1 =
  | UnknownMeasurement
  | { status: "observed"; milliseconds: number };

const unknownMeasurementShape: ObjectShape = {
  status: f.req(f.en("unknown")),
};

export interface ExperimentCandidateV1 {
  candidateId: string;
  modelLabel: string;
  role: CandidateRole;
  runStatus: ExperimentRunStatus;
  observedLatency: ObservedLatencyV1;
  cost: UnknownMeasurement;
  usage: UnknownMeasurement;
  helpfulnessState: HelpfulnessState;
  goldState: GoldState;
}

const candidateShape: ObjectShape = {
  candidateId: f.req(f.str),
  modelLabel: f.req(f.str),
  role: f.req(f.en(...CANDIDATE_ROLES)),
  runStatus: f.req(f.en(...RUN_STATUSES)),
  observedLatency: f.req(
    f.obj({
      status: f.req(f.en("unknown", "observed")),
      milliseconds: f.opt(f.u64),
    }),
  ),
  cost: f.req(f.obj(unknownMeasurementShape)),
  usage: f.req(f.obj(unknownMeasurementShape)),
  helpfulnessState: f.req(f.en(...HELPFULNESS_STATES)),
  goldState: f.req(f.en(...GOLD_STATES)),
};

export interface EvidenceAnchorV1 {
  evidenceRef: string;
  role: string;
  candidateIds: string[];
}

const anchorShape: ObjectShape = {
  evidenceRef: f.req(f.str),
  role: f.req(f.str),
  candidateIds: f.req(f.arr(f.str)),
};

export interface CandidateSpecificEvidenceV1 {
  candidateId: string;
  evidenceRefs: string[];
}

const candidateSpecificShape: ObjectShape = {
  candidateId: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
};

export interface RoleConflictAssignmentV1 {
  candidateId: string;
  role: string;
}

export interface RoleConflictV1 {
  evidenceRef: string;
  assignments: RoleConflictAssignmentV1[];
}

const roleConflictShape: ObjectShape = {
  evidenceRef: f.req(f.str),
  assignments: f.req(
    f.arr(
      f.obj({
        candidateId: f.req(f.str),
        role: f.req(f.str),
      }),
    ),
  ),
};

export interface ExperimentAgreementV1 {
  sharedAnchors: EvidenceAnchorV1[];
  candidateSpecific: CandidateSpecificEvidenceV1[];
  roleConflicts: RoleConflictV1[];
  notes: string[];
}

const agreementShape: ObjectShape = {
  sharedAnchors: f.req(f.arr(f.obj(anchorShape))),
  candidateSpecific: f.req(f.arr(f.obj(candidateSpecificShape))),
  roleConflicts: f.req(f.arr(f.obj(roleConflictShape))),
  notes: f.req(f.arr(f.str)),
};

export interface ExperimentPackageV1 {
  schemaId: typeof EXPERIMENT_PACKAGE_SCHEMA_ID;
  packageId: string;
  privacyClass: PrivacyClass;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
}

export interface ExperimentSummaryV1 {
  schemaId: typeof EXPERIMENT_SUMMARY_SCHEMA_ID;
  packageId: string;
  privacyClass: PrivacyClass;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1 | null;
}

export interface HelpfulnessObservationV1 {
  schemaId: typeof HELPFULNESS_OBSERVATION_SCHEMA_ID;
  id: string;
  experimentId: string;
  candidateId: string;
  dimension: HelpfulnessDimension;
  score: number;
  rationale: string;
  evidenceRefs: string[];
  reviewerId: string;
  reviewerUsername: string;
  createdAt: string;
}

export interface ExperimentDecisionV1 {
  schemaId: typeof EXPERIMENT_DECISION_SCHEMA_ID;
  id: string;
  experimentId: string;
  status: DecisionStatus;
  revision: number;
  predecessorRevision: number | null;
  text: string;
  rationale: string;
  evidenceRefs: string[];
  packageId: string;
  authorId: string;
  authorUsername: string;
  createdAt: string;
}

export interface ExperimentReviewExportV1 {
  schemaId: typeof EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID;
  privacyClass: "share_safe";
  packageId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: ExperimentCandidateV1[];
  agreement: ExperimentAgreementV1;
  observations: HelpfulnessObservationV1[];
  decision: ExperimentDecisionV1 | null;
  notes: string[];
}

function assertLatency(path: string, value: ObservedLatencyV1): void {
  if (value.status === "unknown") {
    if ("milliseconds" in value) {
      throw new ContractViolation(`${path}.milliseconds`, "unknown latency must omit milliseconds");
    }
    return;
  }
  if (typeof value.milliseconds !== "number") {
    throw new ContractViolation(`${path}.milliseconds`, "observed latency requires milliseconds");
  }
}

function assertCandidates(path: string, candidates: ExperimentCandidateV1[]): void {
  if (candidates.length === 0) {
    throw new ContractViolation(path, "at least one candidate is required");
  }
  const ids = new Set<string>();
  for (const [i, c] of candidates.entries()) {
    if (ids.has(c.candidateId)) {
      throw new ContractViolation(`${path}[${i}].candidateId`, "duplicate candidateId");
    }
    ids.add(c.candidateId);
    assertLatency(`${path}[${i}].observedLatency`, c.observedLatency);
    if (c.cost.status !== "unknown") {
      throw new ContractViolation(`${path}[${i}].cost`, "cost must remain unknown");
    }
    if (c.usage.status !== "unknown") {
      throw new ContractViolation(`${path}[${i}].usage`, "usage must remain unknown");
    }
  }
}

function assertAgreementNotes(path: string, notes: string[]): void {
  if (!notes.includes(AGREEMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation(path, "must include the agreement-is-not-correctness caveat");
  }
}

const packageShape: ObjectShape = {
  schemaId: f.req(f.en(EXPERIMENT_PACKAGE_SCHEMA_ID)),
  packageId: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  taskFingerprint: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  candidates: f.req(f.arr(f.obj(candidateShape))),
  agreement: f.req(f.obj(agreementShape)),
};

const summaryShape: ObjectShape = {
  schemaId: f.req(f.en(EXPERIMENT_SUMMARY_SCHEMA_ID)),
  packageId: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  taskFingerprint: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  candidates: f.req(f.arr(f.obj(candidateShape))),
  agreement: f.nul(f.obj(agreementShape)),
};

const observationShape: ObjectShape = {
  schemaId: f.req(f.en(HELPFULNESS_OBSERVATION_SCHEMA_ID)),
  id: f.req(f.str),
  experimentId: f.req(f.str),
  candidateId: f.req(f.str),
  dimension: f.req(f.en(...HELPFULNESS_DIMENSIONS)),
  score: f.req(f.u64),
  rationale: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  reviewerId: f.req(f.str),
  reviewerUsername: f.req(f.str),
  createdAt: f.req(f.str),
};

const decisionShape: ObjectShape = {
  schemaId: f.req(f.en(EXPERIMENT_DECISION_SCHEMA_ID)),
  id: f.req(f.str),
  experimentId: f.req(f.str),
  status: f.req(f.en(...DECISION_STATUSES)),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  text: f.req(f.str),
  rationale: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  packageId: f.req(f.str),
  authorId: f.req(f.str),
  authorUsername: f.req(f.str),
  createdAt: f.req(f.str),
};

const reviewExportShape: ObjectShape = {
  schemaId: f.req(f.en(EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  packageId: f.req(f.str),
  taskFingerprint: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  candidates: f.req(f.arr(f.obj(candidateShape))),
  agreement: f.req(f.obj(agreementShape)),
  observations: f.req(f.arr(f.obj(observationShape))),
  decision: f.nul(f.obj(decisionShape)),
  notes: f.req(f.arr(f.str)),
};

function assertShareSafe(path: string, privacy: PrivacyClass): void {
  if (privacy !== "share_safe") {
    throw new ContractViolation(path, "experiment packages must be share_safe");
  }
}

export function parseExperimentPackage(raw: unknown): ExperimentPackageV1 {
  checkObject("$", packageShape, raw);
  const pkg = raw as ExperimentPackageV1;
  assertShareSafe("$.privacyClass", pkg.privacyClass);
  assertCandidates("$.candidates", pkg.candidates);
  assertAgreementNotes("$.agreement.notes", pkg.agreement.notes);
  return pkg;
}

export function parseExperimentSummary(raw: unknown): ExperimentSummaryV1 {
  checkObject("$", summaryShape, raw);
  const summary = raw as ExperimentSummaryV1;
  assertShareSafe("$.privacyClass", summary.privacyClass);
  assertCandidates("$.candidates", summary.candidates);
  if (summary.agreement) {
    assertAgreementNotes("$.agreement.notes", summary.agreement.notes);
  }
  return summary;
}

export function parseHelpfulnessObservation(raw: unknown): HelpfulnessObservationV1 {
  checkObject("$", observationShape, raw);
  const row = raw as HelpfulnessObservationV1;
  if (row.score > 3) {
    throw new ContractViolation("$.score", "score must be 0..=3");
  }
  if (!row.rationale.trim()) {
    throw new ContractViolation("$.rationale", "rationale must not be empty");
  }
  return row;
}

export function parseExperimentDecision(raw: unknown): ExperimentDecisionV1 {
  checkObject("$", decisionShape, raw);
  const row = raw as ExperimentDecisionV1;
  if (!row.text.trim()) {
    throw new ContractViolation("$.text", "decision text must not be empty");
  }
  if (!row.rationale.trim()) {
    throw new ContractViolation("$.rationale", "rationale must not be empty");
  }
  return row;
}

export function parseExperimentReviewExport(raw: unknown): ExperimentReviewExportV1 {
  checkObject("$", reviewExportShape, raw);
  const row = raw as ExperimentReviewExportV1;
  assertCandidates("$.candidates", row.candidates);
  assertAgreementNotes("$.agreement.notes", row.agreement.notes);
  if (!row.notes.includes(AGREEMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "must include the agreement-is-not-correctness caveat");
  }
  for (const [i, obs] of row.observations.entries()) {
    if (obs.score > 3) {
      throw new ContractViolation(`$.observations[${i}].score`, "score must be 0..=3");
    }
  }
  return row;
}

export function isExperimentEnvelope(raw: unknown): raw is { schemaId: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "schemaId" in raw &&
    typeof (raw as { schemaId: unknown }).schemaId === "string"
  );
}

export function parseExperimentImport(raw: unknown): ExperimentPackageV1 | ExperimentSummaryV1 {
  if (!isExperimentEnvelope(raw)) {
    throw new ContractViolation("$", "expected experiment package or summary object");
  }
  if (raw.schemaId === EXPERIMENT_PACKAGE_SCHEMA_ID) {
    return parseExperimentPackage(raw);
  }
  if (raw.schemaId === EXPERIMENT_SUMMARY_SCHEMA_ID) {
    return parseExperimentSummary(raw);
  }
  throw new ContractViolation(
    "$.schemaId",
    `expected ${EXPERIMENT_PACKAGE_SCHEMA_ID} or ${EXPERIMENT_SUMMARY_SCHEMA_ID}`,
  );
}
