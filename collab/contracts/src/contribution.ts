import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";

export const CONTRIBUTION_KINDS = [
  "message",
  "note",
  "hypothesis",
  "action",
  "upload",
  "external_run",
  "handoff",
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const HYPOTHESIS_STATUSES = [
  "proposed",
  "supported",
  "contradicted",
  "superseded",
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const CONTRIBUTION_SCHEMA_ID = "cd-collab.contribution.v1" as const;

export interface ContributionV1 {
  schemaId: typeof CONTRIBUTION_SCHEMA_ID;
  id: string;
  caseId: string;
  kind: ContributionKind;
  revision: number;
  predecessorRevision: number | null;
  body: string | null;
  contentHash: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  tombstoned: boolean;
  authorId: string;
  authorUsername: string;
  createdAt: string;
  hypothesisStatus: HypothesisStatus | null;
  hypothesisLinks: { kind: "artifact" | "contribution"; id: string }[] | null;
  sourceId: string;
}

const contributionShape: ObjectShape = {
  schemaId: f.req(f.en(CONTRIBUTION_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  kind: f.req(f.en(...CONTRIBUTION_KINDS)),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  tombstoned: f.req(f.bool),
  authorId: f.req(f.str),
  authorUsername: f.req(f.str),
  createdAt: f.req(f.str),
  hypothesisStatus: f.nul(f.en(...HYPOTHESIS_STATUSES)),
  hypothesisLinks: f.nul(
    f.arr(
      f.obj({
        kind: f.req(f.en("artifact", "contribution")),
        id: f.req(f.str),
      }),
    ),
  ),
  sourceId: f.req(f.str),
};

const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;

/** Bounded retry token for an authorized contribution create. */
export function isContributionIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value);
}

export function parseContribution(raw: unknown): ContributionV1 {
  checkObject("$", contributionShape, raw);
  return raw as ContributionV1;
}

export const CONTRIBUTION_LIST_SCHEMA_ID = "cd-collab.contribution_list.v1" as const;

export interface ContributionListV1 {
  schemaId: typeof CONTRIBUTION_LIST_SCHEMA_ID;
  caseId: string;
  contributions: ContributionV1[];
}

const contributionListShape: ObjectShape = {
  schemaId: f.req(f.en(CONTRIBUTION_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  contributions: f.req(f.arr(f.obj(contributionShape))),
};

export function parseContributionList(raw: unknown): ContributionListV1 {
  checkObject("$", contributionListShape, raw);
  return raw as ContributionListV1;
}

export const PROVENANCE_SCHEMA_ID = "cd-collab.provenance.v1" as const;

export interface ProvenanceV1 {
  schemaId: typeof PROVENANCE_SCHEMA_ID;
  contributionId: string;
  revisions: ContributionV1[];
}

const provenanceShape: ObjectShape = {
  schemaId: f.req(f.en(PROVENANCE_SCHEMA_ID)),
  contributionId: f.req(f.str),
  revisions: f.req(f.arr(f.obj(contributionShape))),
};

export function parseProvenance(raw: unknown): ProvenanceV1 {
  checkObject("$", provenanceShape, raw);
  return raw as ProvenanceV1;
}
