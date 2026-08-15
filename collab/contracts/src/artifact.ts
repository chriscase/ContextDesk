import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";

export const ARTIFACT_KINDS = ["log", "email", "attachment", "file_server_ref"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_SCHEMA_ID = "cd-collab.artifact.v1" as const;

export interface ArtifactV1 {
  schemaId: typeof ARTIFACT_SCHEMA_ID;
  id: string;
  caseId: string;
  kind: ArtifactKind;
  filename: string | null;
  uri: string | null;
  mediaType: string | null;
  byteLength: number | null;
  contentHash: string | null;
  expectedHash: string | null;
  verificationStatus: string | null;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  summaryContributionId: string | null;
  uploaderId: string;
  sourceId: string;
}

const artifactShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  kind: f.req(f.en(...ARTIFACT_KINDS)),
  filename: f.nul(f.str),
  uri: f.nul(f.str),
  mediaType: f.nul(f.str),
  byteLength: f.nul(f.u64),
  contentHash: f.nul(f.str),
  expectedHash: f.nul(f.str),
  verificationStatus: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  summaryContributionId: f.nul(f.str),
  uploaderId: f.req(f.str),
  sourceId: f.req(f.str),
};

export function parseArtifact(raw: unknown): ArtifactV1 {
  checkObject("$", artifactShape, raw);
  return raw as ArtifactV1;
}
