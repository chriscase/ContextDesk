import { checkObject, f, type ObjectShape } from "./parse.js";

export const CASE_BOARD_SCHEMA_ID = "cd-collab.case_board.v1" as const;
export const CASE_BOARD_BUCKETS = [
  "known",
  "unknown",
  "agreed",
  "disputed",
  "newly_concluded",
] as const;
export type CaseBoardBucket = (typeof CASE_BOARD_BUCKETS)[number];

export const CASE_BOARD_AGREEMENT = ["unknown", "shared", "conflicted"] as const;
export type CaseBoardAgreement = (typeof CASE_BOARD_AGREEMENT)[number];

export const CASE_BOARD_CONFIDENCE = ["unknown", "low", "medium", "high"] as const;
export type CaseBoardConfidence = (typeof CASE_BOARD_CONFIDENCE)[number];

export const CASE_BOARD_BASES = [
  "evidence",
  "hypothesis",
  "accepted_decision",
  "unknown",
] as const;
export type CaseBoardBasis = (typeof CASE_BOARD_BASES)[number];

export const CASE_BOARD_GOLD_STATUS = ["unknown", "absent", "present"] as const;
export type CaseBoardGoldStatus = (typeof CASE_BOARD_GOLD_STATUS)[number];

export interface CaseBoardFindingV1 {
  id: string;
  bucket: CaseBoardBucket;
  statement: string;
  evidenceRefs: string[];
  contributionRefs: string[];
  agreement: CaseBoardAgreement;
  confidence: CaseBoardConfidence;
  basis: CaseBoardBasis;
}

export interface CaseBoardV1 {
  schemaId: typeof CASE_BOARD_SCHEMA_ID;
  caseId: string;
  snapshotId: string | null;
  generatedAt: string;
  goldStatus: CaseBoardGoldStatus;
  findings: CaseBoardFindingV1[];
  notice: "Agreement is not proof of correctness.";
}

const findingShape: ObjectShape = {
  id: f.req(f.str),
  bucket: f.req(f.en(...CASE_BOARD_BUCKETS)),
  statement: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  contributionRefs: f.req(f.arr(f.str)),
  agreement: f.req(f.en(...CASE_BOARD_AGREEMENT)),
  confidence: f.req(f.en(...CASE_BOARD_CONFIDENCE)),
  basis: f.req(f.en(...CASE_BOARD_BASES)),
};

const boardShape: ObjectShape = {
  schemaId: f.req(f.en(CASE_BOARD_SCHEMA_ID)),
  caseId: f.req(f.str),
  snapshotId: f.nul(f.str),
  generatedAt: f.req(f.str),
  goldStatus: f.req(f.en(...CASE_BOARD_GOLD_STATUS)),
  findings: f.req(f.arr(f.obj(findingShape))),
  notice: f.req(f.en("Agreement is not proof of correctness.")),
};

export function parseCaseBoard(raw: unknown): CaseBoardV1 {
  checkObject("$", boardShape, raw);
  return raw as CaseBoardV1;
}

