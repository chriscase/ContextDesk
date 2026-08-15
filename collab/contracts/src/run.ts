import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";

/** Aligns with #878 completeness vocabulary. Collab copies the words only. */
export const COMPLETENESS = ["exact", "partial", "unknown"] as const;
export type Completeness = (typeof COMPLETENESS)[number];

export const EVIDENCE_VISIBILITY = ["unknown", "importer_described"] as const;
export type EvidenceVisibility = (typeof EVIDENCE_VISIBILITY)[number];

export const CORROBORATION_STATES = ["unverified", "corroborated", "contradicted"] as const;
export type CorroborationState = (typeof CORROBORATION_STATES)[number];

export const EXTERNAL_RUN_SCHEMA_ID = "cd-collab.external_run.v1" as const;

export interface ExternalRunV1 {
  schemaId: typeof EXTERNAL_RUN_SCHEMA_ID;
  id: string;
  caseId: string;
  contributionId: string;
  sourceId: string;
  outputHash: string;
  outputText: string;
  promptHash: string | null;
  promptText: string | null;
  promptCompleteness: Completeness;
  outputCompleteness: Completeness;
  workflowCompleteness: Completeness;
  evidenceVisibility: EvidenceVisibility;
  /** Content-addressed #888 package snapshot when one exists. Null until then. */
  snapshotBinding: string | null;
  visibilityNote: string | null;
  importerId: string;
  importerUsername: string;
  operatorId: string;
  operatorUsername: string;
  provider: string | null;
  model: string | null;
  version: string | null;
  claimedTraces: string[];
  uncertainty: string | null;
  timing: string | null;
  cost: string | null;
  redacted: boolean;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  corroborationState: CorroborationState;
  createdAt: string;
}

const runShape: ObjectShape = {
  schemaId: f.req(f.en(EXTERNAL_RUN_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  contributionId: f.req(f.str),
  sourceId: f.req(f.str),
  outputHash: f.req(f.str),
  outputText: f.req(f.str),
  promptHash: f.nul(f.str),
  promptText: f.nul(f.str),
  promptCompleteness: f.req(f.en(...COMPLETENESS)),
  outputCompleteness: f.req(f.en(...COMPLETENESS)),
  workflowCompleteness: f.req(f.en(...COMPLETENESS)),
  evidenceVisibility: f.req(f.en(...EVIDENCE_VISIBILITY)),
  snapshotBinding: f.nul(f.str),
  visibilityNote: f.nul(f.str),
  importerId: f.req(f.str),
  importerUsername: f.req(f.str),
  operatorId: f.req(f.str),
  operatorUsername: f.req(f.str),
  provider: f.nul(f.str),
  model: f.nul(f.str),
  version: f.nul(f.str),
  claimedTraces: f.req(f.arr(f.str)),
  uncertainty: f.nul(f.str),
  timing: f.nul(f.str),
  cost: f.nul(f.str),
  redacted: f.req(f.bool),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  corroborationState: f.req(f.en(...CORROBORATION_STATES)),
  createdAt: f.req(f.str),
};

export function parseExternalRun(raw: unknown): ExternalRunV1 {
  checkObject("$", runShape, raw);
  return raw as ExternalRunV1;
}
