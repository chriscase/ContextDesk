import { checkObject, f, type ObjectShape } from "./parse.js";
import { CASE_SEVERITIES, CASE_STATUSES, PRIVACY_CLASSES } from "./case.js";
import { HYPOTHESIS_STATUSES } from "./contribution.js";
import { CORROBORATION_STATES } from "./run.js";

export const BRIEF_SCHEMA_ID = "cd-collab.brief.v1" as const;
export const IMPORTED_RESPONSE_PRESENTATION = "imported_response" as const;

export interface BriefHeaderV1 {
  caseId: string;
  title: string;
  severity: string;
  status: string;
  legalHold: boolean;
  retentionClass: string;
}

export interface BriefTimelineEventV1 {
  seq: number;
  kind: string;
  actorLabel: string;
  targetId: string | null;
  payloadDigest: string;
}

export interface BriefLinkV1 {
  kind: string;
  id: string;
}

export interface BriefHypothesisV1 {
  id: string;
  status: string;
  body: string | null;
  contentHash: string;
  sourceLabel: string;
  supporting: BriefLinkV1[];
  contradicting: BriefLinkV1[];
}

export interface BriefActionV1 {
  id: string;
  body: string | null;
  contentHash: string;
  actorLabel: string;
  sourceLabel: string;
}

export interface BriefEvidenceV1 {
  id: string;
  kind: string;
  filename: string | null;
  contentHash: string | null;
  sourceLabel: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  verificationStatus: string | null;
  content: string | null;
  bytesIncluded: boolean;
}

export interface BriefAttributionV1 {
  actorLabel: string;
  action: string;
  targetKind: string;
  targetId: string | null;
}

export interface BriefImportedRunV1 {
  id: string;
  sourceLabel: string;
  corroborationState: string;
  snapshotBinding: string | null;
  presentation: typeof IMPORTED_RESPONSE_PRESENTATION;
  outputIncluded: boolean;
  outputText: string | null;
}

export interface BriefV1 {
  schemaId: typeof BRIEF_SCHEMA_ID;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  header: BriefHeaderV1;
  timeline: BriefTimelineEventV1[];
  hypotheses: BriefHypothesisV1[];
  actions: BriefActionV1[];
  evidence: BriefEvidenceV1[];
  attributions: BriefAttributionV1[];
  importedRuns: BriefImportedRunV1[];
}

const linkShape: ObjectShape = {
  kind: f.req(f.str),
  id: f.req(f.str),
};

const headerShape: ObjectShape = {
  caseId: f.req(f.str),
  title: f.req(f.str),
  severity: f.req(f.en(...CASE_SEVERITIES)),
  status: f.req(f.en(...CASE_STATUSES)),
  legalHold: f.req(f.bool),
  retentionClass: f.req(f.str),
};

const timelineShape: ObjectShape = {
  seq: f.req(f.u64),
  kind: f.req(f.str),
  actorLabel: f.req(f.str),
  targetId: f.nul(f.str),
  payloadDigest: f.req(f.str),
};

const hypothesisShape: ObjectShape = {
  id: f.req(f.str),
  status: f.req(f.en(...HYPOTHESIS_STATUSES)),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  sourceLabel: f.req(f.str),
  supporting: f.req(f.arr(f.obj(linkShape))),
  contradicting: f.req(f.arr(f.obj(linkShape))),
};

const actionShape: ObjectShape = {
  id: f.req(f.str),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  actorLabel: f.req(f.str),
  sourceLabel: f.req(f.str),
};

const evidenceShape: ObjectShape = {
  id: f.req(f.str),
  kind: f.req(f.str),
  filename: f.nul(f.str),
  contentHash: f.nul(f.str),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  verificationStatus: f.nul(f.str),
  content: f.nul(f.str),
  bytesIncluded: f.req(f.bool),
};

const attributionShape: ObjectShape = {
  actorLabel: f.req(f.str),
  action: f.req(f.str),
  targetKind: f.req(f.str),
  targetId: f.nul(f.str),
};

const importedRunShape: ObjectShape = {
  id: f.req(f.str),
  sourceLabel: f.req(f.str),
  corroborationState: f.req(f.en(...CORROBORATION_STATES)),
  snapshotBinding: f.nul(f.str),
  presentation: f.req(f.en(IMPORTED_RESPONSE_PRESENTATION)),
  outputIncluded: f.req(f.bool),
  outputText: f.nul(f.str),
};

export const briefShape: ObjectShape = {
  schemaId: f.req(f.en(BRIEF_SCHEMA_ID)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  header: f.req(f.obj(headerShape)),
  timeline: f.req(f.arr(f.obj(timelineShape))),
  hypotheses: f.req(f.arr(f.obj(hypothesisShape))),
  actions: f.req(f.arr(f.obj(actionShape))),
  evidence: f.req(f.arr(f.obj(evidenceShape))),
  attributions: f.req(f.arr(f.obj(attributionShape))),
  importedRuns: f.req(f.arr(f.obj(importedRunShape))),
};

export function parseBrief(raw: unknown): BriefV1 {
  checkObject("$", briefShape, raw);
  return raw as BriefV1;
}
