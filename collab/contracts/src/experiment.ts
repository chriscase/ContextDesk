import { checkObject, f, type ObjectShape, ContractViolation } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import {
  assertShareSafeAlias,
  assertShareSafePrivacy,
} from "./privacy.js";
import {
  GOLD_ALIGNMENT_NOT_CORRECTNESS,
  GOLD_ALIGNMENT_STATUSES,
  GOLD_IS_HUMAN_BENCHMARK,
  goldAlignmentShape,
  goldReferenceShape,
  parseGoldAlignment,
  parseGoldReference,
  type CandidateGoldAlignmentV1,
  type GoldReferenceV1,
} from "./gold.js";

export const EXPERIMENT_PACKAGE_SCHEMA_ID = "cd-collab.experiment_package.v1" as const;
export const EXPERIMENT_SUMMARY_SCHEMA_ID = "cd-collab.experiment_summary.v1" as const;
export const HELPFULNESS_OBSERVATION_SCHEMA_ID =
  "cd-collab.helpfulness_observation.v1" as const;
export const EXPERIMENT_DECISION_SCHEMA_ID = "cd-collab.experiment_decision.v1" as const;
export const EXPERIMENT_REVIEW_EXPORT_SCHEMA_ID =
  "cd-collab.experiment_review_export.v1" as const;
export const EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID =
  "cd-collab.experiment_review_export.v2" as const;

export const EXPERIMENT_SHARE_SAFE_CAVEATS = [
  "agreement_not_correctness",
  "gold_is_human_benchmark",
  "gold_alignment_not_correctness",
] as const;
export type ExperimentShareSafeCaveat = (typeof EXPERIMENT_SHARE_SAFE_CAVEATS)[number];

export const AGREEMENT_NOT_CORRECTNESS =
  "Agreement is not proof of correctness." as const;

function assertExactCaveats(
  path: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length) {
    throw new ContractViolation(path, "expected each required caveat exactly once");
  }
  for (const caveat of expected) {
    if (!actual.includes(caveat)) {
      throw new ContractViolation(path, `must include ${caveat}`);
    }
  }
}

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

export const PACKAGE_GOLD_STATES = ["unknown", "absent"] as const;
export const GOLD_STATES = ["unknown", "absent", "present"] as const;
export type PackageGoldState = (typeof PACKAGE_GOLD_STATES)[number];
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

/** @deprecated Read-only legacy shape; it cannot honestly express share-safe omissions. */
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
  gold: GoldReferenceV1 | null;
  alignments: CandidateGoldAlignmentV1[];
  notes: string[];
}

export interface ShareSafeExperimentCandidateV2 {
  candidateAlias: string;
  role: CandidateRole;
  runStatus: ExperimentRunStatus;
  observedLatency: UnknownMeasurement;
  cost: UnknownMeasurement;
  usage: UnknownMeasurement;
  helpfulnessState: HelpfulnessState;
  goldState: GoldState;
}

export interface ShareSafeEvidenceAnchorV2 {
  evidenceAlias: string;
  roleAlias: string;
  candidateAliases: string[];
}

export interface ShareSafeCandidateSpecificEvidenceV2 {
  candidateAlias: string;
  evidenceAliases: string[];
}

export interface ShareSafeRoleConflictV2 {
  evidenceAlias: string;
  assignments: { candidateAlias: string; roleAlias: string }[];
}

export interface ShareSafeExperimentAgreementV2 {
  sharedAnchors: ShareSafeEvidenceAnchorV2[];
  candidateSpecific: ShareSafeCandidateSpecificEvidenceV2[];
  roleConflicts: ShareSafeRoleConflictV2[];
}

export interface ShareSafeHelpfulnessObservationV2 {
  observationAlias: string;
  candidateAlias: string;
  dimension: HelpfulnessDimension;
  score: number;
  evidenceAliases: string[];
}

export interface ShareSafeExperimentDecisionV2 {
  decisionAlias: string;
  status: DecisionStatus;
  revision: number;
  predecessorRevision: number | null;
  evidenceAliases: string[];
}

export interface ShareSafeGoldReferenceV2 {
  goldAlias: string;
  version: number;
  predecessorGoldAlias: string | null;
  acceptedDecisionAlias: string;
  acceptedDecisionRevision: number;
  evidenceAliases: string[];
  expectedRelationships: { evidenceAlias: string; roleAlias: string }[];
  helpfulnessDimensions: HelpfulnessDimension[];
}

export interface ShareSafeCandidateGoldAlignmentV2 {
  candidateAlias: string;
  status: CandidateGoldAlignmentV1["status"];
  matchedEvidenceAliases: string[];
  missingEvidenceAliases: string[];
  extraEvidenceAliases: string[];
  roleMismatches: { evidenceAlias: string; roleAlias: string }[];
}

export interface ExperimentReviewExportV2 {
  schemaId: typeof EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID;
  privacyClass: "share_safe";
  packageAlias: string;
  taskAlias: string;
  snapshotAlias: string;
  candidates: ShareSafeExperimentCandidateV2[];
  agreement: ShareSafeExperimentAgreementV2;
  observations: ShareSafeHelpfulnessObservationV2[];
  decision: ShareSafeExperimentDecisionV2 | null;
  gold: ShareSafeGoldReferenceV2 | null;
  alignments: ShareSafeCandidateGoldAlignmentV2[];
  omissions: {
    modelLabelsIncluded: false;
    participantIdentitiesIncluded: false;
    freeTextIncluded: false;
    privateContentIncluded: false;
    correlatableMetadataIncluded: false;
  };
  caveats: ExperimentShareSafeCaveat[];
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

function assertImportedGoldState(path: string, candidates: ExperimentCandidateV1[]): void {
  for (const [i, c] of candidates.entries()) {
    if (c.goldState === "present") {
      throw new ContractViolation(
        `${path}[${i}].goldState`,
        "imported packages cannot claim a gold reference",
      );
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
  gold: f.nul(f.obj(goldReferenceShape)),
  alignments: f.req(f.arr(f.obj(goldAlignmentShape))),
  notes: f.req(f.arr(f.str)),
};

const shareSafeCandidateShape: ObjectShape = {
  candidateAlias: f.req(f.str),
  role: f.req(f.en(...CANDIDATE_ROLES)),
  runStatus: f.req(f.en(...RUN_STATUSES)),
  observedLatency: f.req(f.obj(unknownMeasurementShape)),
  cost: f.req(f.obj(unknownMeasurementShape)),
  usage: f.req(f.obj(unknownMeasurementShape)),
  helpfulnessState: f.req(f.en(...HELPFULNESS_STATES)),
  goldState: f.req(f.en(...GOLD_STATES)),
};

const shareSafeRoleAssignmentShape: ObjectShape = {
  candidateAlias: f.req(f.str),
  roleAlias: f.req(f.str),
};

const shareSafeAgreementShape: ObjectShape = {
  sharedAnchors: f.req(
    f.arr(
      f.obj({
        evidenceAlias: f.req(f.str),
        roleAlias: f.req(f.str),
        candidateAliases: f.req(f.arr(f.str)),
      }),
    ),
  ),
  candidateSpecific: f.req(
    f.arr(
      f.obj({
        candidateAlias: f.req(f.str),
        evidenceAliases: f.req(f.arr(f.str)),
      }),
    ),
  ),
  roleConflicts: f.req(
    f.arr(
      f.obj({
        evidenceAlias: f.req(f.str),
        assignments: f.req(f.arr(f.obj(shareSafeRoleAssignmentShape))),
      }),
    ),
  ),
};

const shareSafeObservationShape: ObjectShape = {
  observationAlias: f.req(f.str),
  candidateAlias: f.req(f.str),
  dimension: f.req(f.en(...HELPFULNESS_DIMENSIONS)),
  score: f.req(f.u64),
  evidenceAliases: f.req(f.arr(f.str)),
};

const shareSafeDecisionShape: ObjectShape = {
  decisionAlias: f.req(f.str),
  status: f.req(f.en(...DECISION_STATUSES)),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  evidenceAliases: f.req(f.arr(f.str)),
};

const shareSafeRelationshipShape: ObjectShape = {
  evidenceAlias: f.req(f.str),
  roleAlias: f.req(f.str),
};

const shareSafeGoldShape: ObjectShape = {
  goldAlias: f.req(f.str),
  version: f.req(f.u64),
  predecessorGoldAlias: f.nul(f.str),
  acceptedDecisionAlias: f.req(f.str),
  acceptedDecisionRevision: f.req(f.u64),
  evidenceAliases: f.req(f.arr(f.str)),
  expectedRelationships: f.req(f.arr(f.obj(shareSafeRelationshipShape))),
  helpfulnessDimensions: f.req(f.arr(f.en(...HELPFULNESS_DIMENSIONS))),
};

const shareSafeAlignmentShape: ObjectShape = {
  candidateAlias: f.req(f.str),
  status: f.req(f.en(...GOLD_ALIGNMENT_STATUSES)),
  matchedEvidenceAliases: f.req(f.arr(f.str)),
  missingEvidenceAliases: f.req(f.arr(f.str)),
  extraEvidenceAliases: f.req(f.arr(f.str)),
  roleMismatches: f.req(f.arr(f.obj(shareSafeRelationshipShape))),
};

export const experimentReviewExportV2Shape: ObjectShape = {
  schemaId: f.req(f.en(EXPERIMENT_REVIEW_EXPORT_V2_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  packageAlias: f.req(f.str),
  taskAlias: f.req(f.str),
  snapshotAlias: f.req(f.str),
  candidates: f.req(f.arr(f.obj(shareSafeCandidateShape))),
  agreement: f.req(f.obj(shareSafeAgreementShape)),
  observations: f.req(f.arr(f.obj(shareSafeObservationShape))),
  decision: f.nul(f.obj(shareSafeDecisionShape)),
  gold: f.nul(f.obj(shareSafeGoldShape)),
  alignments: f.req(f.arr(f.obj(shareSafeAlignmentShape))),
  omissions: f.req(
    f.obj({
      modelLabelsIncluded: f.req(f.bool),
      participantIdentitiesIncluded: f.req(f.bool),
      freeTextIncluded: f.req(f.bool),
      privateContentIncluded: f.req(f.bool),
      correlatableMetadataIncluded: f.req(f.bool),
    }),
  ),
  caveats: f.req(f.arr(f.en(...EXPERIMENT_SHARE_SAFE_CAVEATS))),
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
  assertImportedGoldState("$.candidates", pkg.candidates);
  assertAgreementNotes("$.agreement.notes", pkg.agreement.notes);
  return pkg;
}

export function parseExperimentSummary(raw: unknown): ExperimentSummaryV1 {
  checkObject("$", summaryShape, raw);
  const summary = raw as ExperimentSummaryV1;
  assertShareSafe("$.privacyClass", summary.privacyClass);
  assertCandidates("$.candidates", summary.candidates);
  assertImportedGoldState("$.candidates", summary.candidates);
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

/** @deprecated Parse legacy records only. New exports must use v2. */
export function parseExperimentReviewExport(raw: unknown): ExperimentReviewExportV1 {
  checkObject("$", reviewExportShape, raw);
  const row = raw as ExperimentReviewExportV1;
  assertCandidates("$.candidates", row.candidates);
  assertAgreementNotes("$.agreement.notes", row.agreement.notes);
  if (!row.notes.includes(AGREEMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "must include the agreement-is-not-correctness caveat");
  }
  if (!row.notes.includes(GOLD_IS_HUMAN_BENCHMARK)) {
    throw new ContractViolation("$.notes", "must include the human-benchmark caveat");
  }
  if (!row.notes.includes(GOLD_ALIGNMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "must include the alignment-is-not-correctness caveat");
  }
  if (row.gold) {
    parseGoldReference(row.gold);
  }
  for (const alignment of row.alignments) {
    parseGoldAlignment(alignment);
  }
  for (const [i, obs] of row.observations.entries()) {
    if (obs.score > 3) {
      throw new ContractViolation(`$.observations[${i}].score`, "score must be 0..=3");
    }
  }
  return row;
}

function assertAliasArray(path: string, values: string[], prefix: string): void {
  values.forEach((value, index) => assertShareSafeAlias(`${path}[${index}]`, value, prefix));
}

function assertReviewV2Aliases(row: ExperimentReviewExportV2): void {
  assertShareSafeAlias("$.packageAlias", row.packageAlias, "package");
  assertShareSafeAlias("$.taskAlias", row.taskAlias, "task");
  assertShareSafeAlias("$.snapshotAlias", row.snapshotAlias, "snapshot");
  const candidateAliases = new Set<string>();
  for (const [index, candidate] of row.candidates.entries()) {
    const path = `$.candidates[${index}]`;
    assertShareSafeAlias(`${path}.candidateAlias`, candidate.candidateAlias, "approach");
    if (candidateAliases.has(candidate.candidateAlias)) {
      throw new ContractViolation(`${path}.candidateAlias`, "duplicate candidate alias");
    }
    candidateAliases.add(candidate.candidateAlias);
  }
  if (candidateAliases.size === 0) {
    throw new ContractViolation("$.candidates", "at least one candidate is required");
  }
  for (const [index, anchor] of row.agreement.sharedAnchors.entries()) {
    const path = `$.agreement.sharedAnchors[${index}]`;
    assertShareSafeAlias(`${path}.evidenceAlias`, anchor.evidenceAlias, "evidence");
    assertShareSafeAlias(`${path}.roleAlias`, anchor.roleAlias, "role");
    assertAliasArray(`${path}.candidateAliases`, anchor.candidateAliases, "approach");
  }
  for (const [index, candidate] of row.agreement.candidateSpecific.entries()) {
    const path = `$.agreement.candidateSpecific[${index}]`;
    assertShareSafeAlias(`${path}.candidateAlias`, candidate.candidateAlias, "approach");
    assertAliasArray(`${path}.evidenceAliases`, candidate.evidenceAliases, "evidence");
  }
  for (const [index, conflict] of row.agreement.roleConflicts.entries()) {
    const path = `$.agreement.roleConflicts[${index}]`;
    assertShareSafeAlias(`${path}.evidenceAlias`, conflict.evidenceAlias, "evidence");
    for (const [assignmentIndex, assignment] of conflict.assignments.entries()) {
      const assignmentPath = `${path}.assignments[${assignmentIndex}]`;
      assertShareSafeAlias(`${assignmentPath}.candidateAlias`, assignment.candidateAlias, "approach");
      assertShareSafeAlias(`${assignmentPath}.roleAlias`, assignment.roleAlias, "role");
    }
  }
  for (const [index, observation] of row.observations.entries()) {
    const path = `$.observations[${index}]`;
    assertShareSafeAlias(`${path}.observationAlias`, observation.observationAlias, "observation");
    assertShareSafeAlias(`${path}.candidateAlias`, observation.candidateAlias, "approach");
    assertAliasArray(`${path}.evidenceAliases`, observation.evidenceAliases, "evidence");
    if (observation.score > 3) {
      throw new ContractViolation(`${path}.score`, "score must be 0..=3");
    }
  }
  if (row.decision) {
    assertShareSafeAlias("$.decision.decisionAlias", row.decision.decisionAlias, "decision");
    assertAliasArray("$.decision.evidenceAliases", row.decision.evidenceAliases, "evidence");
    if (row.decision.revision < 1) {
      throw new ContractViolation("$.decision.revision", "must be >= 1");
    }
  }
  if (row.gold) {
    assertShareSafeAlias("$.gold.goldAlias", row.gold.goldAlias, "gold");
    if (row.gold.predecessorGoldAlias) {
      assertShareSafeAlias(
        "$.gold.predecessorGoldAlias",
        row.gold.predecessorGoldAlias,
        "gold",
      );
    }
    assertShareSafeAlias(
      "$.gold.acceptedDecisionAlias",
      row.gold.acceptedDecisionAlias,
      "decision",
    );
    assertAliasArray("$.gold.evidenceAliases", row.gold.evidenceAliases, "evidence");
    for (const [index, relationship] of row.gold.expectedRelationships.entries()) {
      const path = `$.gold.expectedRelationships[${index}]`;
      assertShareSafeAlias(`${path}.evidenceAlias`, relationship.evidenceAlias, "evidence");
      assertShareSafeAlias(`${path}.roleAlias`, relationship.roleAlias, "role");
    }
    if (row.gold.version < 1 || row.gold.acceptedDecisionRevision < 1) {
      throw new ContractViolation("$.gold", "gold version and accepted revision must be >= 1");
    }
  }
  for (const [index, alignment] of row.alignments.entries()) {
    const path = `$.alignments[${index}]`;
    assertShareSafeAlias(`${path}.candidateAlias`, alignment.candidateAlias, "approach");
    assertAliasArray(`${path}.matchedEvidenceAliases`, alignment.matchedEvidenceAliases, "evidence");
    assertAliasArray(`${path}.missingEvidenceAliases`, alignment.missingEvidenceAliases, "evidence");
    assertAliasArray(`${path}.extraEvidenceAliases`, alignment.extraEvidenceAliases, "evidence");
    for (const [mismatchIndex, mismatch] of alignment.roleMismatches.entries()) {
      const mismatchPath = `${path}.roleMismatches[${mismatchIndex}]`;
      assertShareSafeAlias(`${mismatchPath}.evidenceAlias`, mismatch.evidenceAlias, "evidence");
      assertShareSafeAlias(`${mismatchPath}.roleAlias`, mismatch.roleAlias, "role");
    }
  }
}

export function parseExperimentReviewExportV2(raw: unknown): ExperimentReviewExportV2 {
  assertShareSafePrivacy(raw);
  checkObject("$", experimentReviewExportV2Shape, raw);
  const row = raw as ExperimentReviewExportV2;
  assertReviewV2Aliases(row);
  for (const [key, included] of Object.entries(row.omissions)) {
    if (included !== false) {
      throw new ContractViolation(`$.omissions.${key}`, "share-safe v2 requires explicit omission");
    }
  }
  assertExactCaveats("$.caveats", row.caveats, EXPERIMENT_SHARE_SAFE_CAVEATS);
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
