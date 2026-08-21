import { checkObject, f, type ObjectShape, ContractViolation } from "./parse.js";

export const GOLD_REFERENCE_SCHEMA_ID = "cd-collab.gold_reference.v1" as const;
export const GOLD_ALIGNMENT_SCHEMA_ID = "cd-collab.gold_alignment.v1" as const;

export const GOLD_IS_HUMAN_BENCHMARK =
  "A gold reference is a human benchmark decision, not an infallible truth claim." as const;
export const GOLD_ALIGNMENT_NOT_CORRECTNESS =
  "Gold alignment is not a correctness verdict." as const;

export const GOLD_ALIGNMENT_STATUSES = [
  "aligned",
  "partial",
  "divergent",
  "unscored",
  "unknown",
  "absent",
] as const;
export type GoldAlignmentStatus = (typeof GOLD_ALIGNMENT_STATUSES)[number];

export const HUMAN_ACCEPTANCE_STATUSES = ["accepted", "unknown"] as const;
export type HumanAcceptanceStatus = (typeof HUMAN_ACCEPTANCE_STATUSES)[number];

const GOLD_HELPFULNESS_DIMENSIONS = [
  "evidence_support",
  "actionability",
  "uncertainty_calibration",
  "unsafe_unsupported_claims",
] as const;

export interface ExpectedRelationshipV1 {
  evidenceRef: string;
  role: string;
}

export interface GoldReferenceV1 {
  schemaId: typeof GOLD_REFERENCE_SCHEMA_ID;
  goldId: string;
  version: number;
  predecessorGoldId: string | null;
  caseId: string;
  experimentId: string;
  packageId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  acceptedDecisionId: string;
  acceptedDecisionRevision: number;
  auditRefs: string[];
  evidenceAnchors: string[];
  expectedRelationships?: ExpectedRelationshipV1[];
  helpfulnessDimensions?: string[];
  notes: string[];
  promotedById: string;
  promotedByUsername: string;
  createdAt: string;
}

export interface CandidateGoldAlignmentV1 {
  schemaId: typeof GOLD_ALIGNMENT_SCHEMA_ID;
  candidateId: string;
  status: GoldAlignmentStatus;
  matchedAnchors: string[];
  missingAnchors: string[];
  extraAnchors: string[];
  roleMismatches: ExpectedRelationshipV1[];
  notes: string[];
}

const relationshipShape: ObjectShape = {
  evidenceRef: f.req(f.str),
  role: f.req(f.str),
};

export const goldReferenceShape: ObjectShape = {
  schemaId: f.req(f.en(GOLD_REFERENCE_SCHEMA_ID)),
  goldId: f.req(f.str),
  version: f.req(f.u64),
  predecessorGoldId: f.nul(f.str),
  caseId: f.req(f.str),
  experimentId: f.req(f.str),
  packageId: f.req(f.str),
  taskFingerprint: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  acceptedDecisionId: f.req(f.str),
  acceptedDecisionRevision: f.req(f.u64),
  auditRefs: f.req(f.arr(f.str)),
  evidenceAnchors: f.req(f.arr(f.str)),
  expectedRelationships: f.opt(f.arr(f.obj(relationshipShape))),
  helpfulnessDimensions: f.opt(f.arr(f.en(...GOLD_HELPFULNESS_DIMENSIONS))),
  notes: f.req(f.arr(f.str)),
  promotedById: f.req(f.str),
  promotedByUsername: f.req(f.str),
  createdAt: f.req(f.str),
};

export const goldAlignmentShape: ObjectShape = {
  schemaId: f.req(f.en(GOLD_ALIGNMENT_SCHEMA_ID)),
  candidateId: f.req(f.str),
  status: f.req(f.en(...GOLD_ALIGNMENT_STATUSES)),
  matchedAnchors: f.req(f.arr(f.str)),
  missingAnchors: f.req(f.arr(f.str)),
  extraAnchors: f.req(f.arr(f.str)),
  roleMismatches: f.req(f.arr(f.obj(relationshipShape))),
  notes: f.req(f.arr(f.str)),
};

function uniqueSorted(values: string[], path: string): string[] {
  const seen = new Set<string>();
  for (const [i, value] of values.entries()) {
    if (!value.trim()) {
      throw new ContractViolation(`${path}[${i}]`, "must not be empty");
    }
    if (seen.has(value)) {
      throw new ContractViolation(`${path}[${i}]`, "duplicate value");
    }
    seen.add(value);
  }
  return [...values].sort();
}

export function goldPromotionFingerprint(input: {
  acceptedDecisionId: string;
  acceptedDecisionRevision: number;
  evidenceAnchors: string[];
  expectedRelationships?: ExpectedRelationshipV1[];
  helpfulnessDimensions?: string[];
}): string {
  const relationships = [...(input.expectedRelationships ?? [])]
    .map((row) => ({ evidenceRef: row.evidenceRef, role: row.role }))
    .sort(
      (a, b) =>
        a.evidenceRef.localeCompare(b.evidenceRef) || a.role.localeCompare(b.role),
    );
  return JSON.stringify({
    acceptedDecisionId: input.acceptedDecisionId,
    acceptedDecisionRevision: input.acceptedDecisionRevision,
    evidenceAnchors: [...input.evidenceAnchors].sort(),
    expectedRelationships: relationships,
    helpfulnessDimensions: [...(input.helpfulnessDimensions ?? [])].sort(),
  });
}

export function parseGoldReference(raw: unknown): GoldReferenceV1 {
  checkObject("$", goldReferenceShape, raw);
  const row = raw as GoldReferenceV1;
  if (!row.goldId.trim()) {
    throw new ContractViolation("$.goldId", "must not be empty");
  }
  if (row.version < 1) {
    throw new ContractViolation("$.version", "version must be >= 1");
  }
  if (row.version === 1 && row.predecessorGoldId !== null) {
    throw new ContractViolation("$.predecessorGoldId", "version 1 must not name a predecessor");
  }
  if (row.version > 1 && !row.predecessorGoldId) {
    throw new ContractViolation("$.predecessorGoldId", "version > 1 requires a predecessor");
  }
  if (!row.acceptedDecisionId.trim()) {
    throw new ContractViolation("$.acceptedDecisionId", "must not be empty");
  }
  if (row.acceptedDecisionRevision < 1) {
    throw new ContractViolation("$.acceptedDecisionRevision", "must be >= 1");
  }
  if (row.evidenceAnchors.length === 0) {
    throw new ContractViolation("$.evidenceAnchors", "at least one evidence anchor is required");
  }
  uniqueSorted(row.evidenceAnchors, "$.evidenceAnchors");
  if (row.expectedRelationships) {
    const seen = new Set<string>();
    for (const [i, rel] of row.expectedRelationships.entries()) {
      if (!rel.evidenceRef.trim() || !rel.role.trim()) {
        throw new ContractViolation(`$.expectedRelationships[${i}]`, "evidenceRef and role are required");
      }
      if (seen.has(rel.evidenceRef)) {
        throw new ContractViolation(`$.expectedRelationships[${i}].evidenceRef`, "duplicate evidenceRef");
      }
      seen.add(rel.evidenceRef);
      if (!row.evidenceAnchors.includes(rel.evidenceRef)) {
        throw new ContractViolation(
          `$.expectedRelationships[${i}].evidenceRef`,
          "must be one of the selected evidence anchors",
        );
      }
    }
  }
  if (row.helpfulnessDimensions) {
    uniqueSorted(row.helpfulnessDimensions, "$.helpfulnessDimensions");
  }
  if (!row.notes.includes(GOLD_IS_HUMAN_BENCHMARK)) {
    throw new ContractViolation("$.notes", "must include the human-benchmark caveat");
  }
  if (!row.promotedById.trim() || !row.promotedByUsername.trim()) {
    throw new ContractViolation("$", "promoter identity is required");
  }
  return row;
}

export function parseGoldAlignment(raw: unknown): CandidateGoldAlignmentV1 {
  checkObject("$", goldAlignmentShape, raw);
  const row = raw as CandidateGoldAlignmentV1;
  if (!row.candidateId.trim()) {
    throw new ContractViolation("$.candidateId", "must not be empty");
  }
  if (!row.notes.includes(GOLD_ALIGNMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "must include the alignment-is-not-correctness caveat");
  }
  return row;
}

export function alignCitedEvidence(input: {
  candidateId: string;
  cited: Iterable<string>;
  observedRoles?: ReadonlyMap<string, string>;
  gold: GoldReferenceV1 | null;
  goldState?: "unknown" | "absent" | "present";
}): CandidateGoldAlignmentV1 {
  const notes: string[] = [GOLD_ALIGNMENT_NOT_CORRECTNESS];
  if (!input.gold) {
    const status: GoldAlignmentStatus = input.goldState === "absent" ? "absent" : "unknown";
    return parseGoldAlignment({
      schemaId: GOLD_ALIGNMENT_SCHEMA_ID,
      candidateId: input.candidateId,
      status,
      matchedAnchors: [],
      missingAnchors: [],
      extraAnchors: [],
      roleMismatches: [],
      notes,
    });
  }
  const cited = [...new Set(input.cited)].filter((id) => id.trim()).sort();
  const goldSet = new Set(input.gold.evidenceAnchors);
  const matchedAnchors = cited.filter((id) => goldSet.has(id));
  const missingAnchors = input.gold.evidenceAnchors.filter((id) => !cited.includes(id)).sort();
  const extraAnchors = cited.filter((id) => !goldSet.has(id));
  const roleMismatches: ExpectedRelationshipV1[] = [];
  for (const rel of input.gold.expectedRelationships ?? []) {
    const observed = input.observedRoles?.get(rel.evidenceRef);
    if (!observed) {
      if (!notes.includes("expected role relationships were not fully observed")) {
        notes.push("expected role relationships were not fully observed");
      }
      continue;
    }
    if (observed !== rel.role) {
      roleMismatches.push({ evidenceRef: rel.evidenceRef, role: observed });
    }
  }
  let status: GoldAlignmentStatus;
  if (cited.length === 0) {
    status = "unscored";
  } else if (matchedAnchors.length === 0) {
    status = "divergent";
  } else if (missingAnchors.length > 0 || roleMismatches.length > 0) {
    status = "partial";
  } else {
    status = "aligned";
  }
  if (extraAnchors.length > 0 && status === "aligned") {
    notes.push("Candidate cited additional evidence beyond the gold selection.");
  }
  return parseGoldAlignment({
    schemaId: GOLD_ALIGNMENT_SCHEMA_ID,
    candidateId: input.candidateId,
    status,
    matchedAnchors,
    missingAnchors,
    extraAnchors,
    roleMismatches,
    notes,
  });
}
