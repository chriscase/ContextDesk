import { checkObject, f, type ObjectShape } from "./parse.js";
import {
  OCCURRED_AT_PRECISIONS,
  OCCURRED_AT_ZONES,
  assertOccurrenceFields,
  type OccurredAtPrecision,
  type OccurredAtZone,
} from "./temporal.js";

export const PRIVACY_CLASSES = ["owner_only", "share_safe"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const CASE_STATUSES = ["open", "monitoring", "resolved", "archived"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export const CASE_SCHEMA_ID = "cd-collab.case.v1" as const;

export interface CaseParticipantV1 {
  identityId: string;
  username: string;
}

export interface CaseV1 {
  schemaId: typeof CASE_SCHEMA_ID;
  id: string;
  title: string;
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  openQuestions: string[];
  situationVersion: number;
  /**
   * When the investigated work happened, as recorded — literal text, so an
   * unknown time zone stays unknown. `createdAt` below is the recording clock
   * and is never moved by a backfill.
   */
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  severity: CaseSeverity;
  status: CaseStatus;
  legalHold: boolean;
  retentionClass: string;
  participants: CaseParticipantV1[];
  createdAt: string;
  createdBy: string;
}

const participantShape: ObjectShape = {
  identityId: f.req(f.str),
  username: f.req(f.str),
};

const caseShape: ObjectShape = {
  schemaId: f.req(f.en(CASE_SCHEMA_ID)),
  id: f.req(f.str),
  title: f.req(f.str),
  problemStatement: f.opt(f.str),
  affectedParties: f.opt(f.str),
  impact: f.opt(f.str),
  scope: f.opt(f.str),
  openQuestions: f.opt(f.arr(f.str)),
  situationVersion: f.opt(f.u64),
  // Optional on the wire so a case written before the occurred-at clock
  // existed still parses; absent means nobody recorded when it happened.
  occurredAt: f.optNul(f.str),
  occurredAtPrecision: f.opt(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.opt(f.en(...OCCURRED_AT_ZONES)),
  severity: f.req(f.en(...CASE_SEVERITIES)),
  status: f.req(f.en(...CASE_STATUSES)),
  legalHold: f.req(f.bool),
  retentionClass: f.req(f.str),
  participants: f.req(f.arr(f.obj(participantShape))),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
};

export function parseCase(raw: unknown): CaseV1 {
  checkObject("$", caseShape, raw);
  const parsed = raw as CaseV1;
  if (parsed.occurredAt !== undefined && parsed.occurredAt !== null) {
    assertOccurrenceFields(
      {
        occurredAt: parsed.occurredAt,
        occurredAtPrecision: parsed.occurredAtPrecision ?? "unknown",
        occurredAtZone: parsed.occurredAtZone ?? "unspecified",
      },
      "$",
    );
  }
  return {
    ...parsed,
    problemStatement: parsed.problemStatement ?? "",
    affectedParties: parsed.affectedParties ?? "",
    impact: parsed.impact ?? "",
    scope: parsed.scope ?? "",
    openQuestions: parsed.openQuestions ? [...parsed.openQuestions] : [],
    situationVersion: parsed.situationVersion ?? 0,
    occurredAt: parsed.occurredAt ?? null,
    occurredAtPrecision: parsed.occurredAtPrecision ?? "unknown",
    occurredAtZone: parsed.occurredAtZone ?? "unspecified",
  };
}

export const CASE_LIST_SCHEMA_ID = "cd-collab.case_list.v1" as const;

export interface CaseListV1 {
  schemaId: typeof CASE_LIST_SCHEMA_ID;
  cases: CaseV1[];
}

const caseListShape: ObjectShape = {
  schemaId: f.req(f.en(CASE_LIST_SCHEMA_ID)),
  cases: f.req(f.arr(f.obj(caseShape))),
};

export function parseCaseList(raw: unknown): CaseListV1 {
  checkObject("$", caseListShape, raw);
  const parsed = raw as CaseListV1;
  return { ...parsed, cases: parsed.cases.map((row) => parseCase(row)) };
}
