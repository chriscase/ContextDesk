import {
  ContractViolation,
  checkObject,
  f,
  type ObjectShape,
} from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";
import {
  parseContribution,
  type ContributionV1,
} from "./contribution.js";

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
  relativePath?: string | null;
  intakeBatchId?: string | null;
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
  relativePath: f.optNul(f.str),
  intakeBatchId: f.optNul(f.str),
};

export function parseArtifact(raw: unknown): ArtifactV1 {
  checkObject("$", artifactShape, raw);
  return raw as ArtifactV1;
}

export const EVIDENCE_LIST_SCHEMA_ID = "cd-collab.evidence_list.v1" as const;

export interface EvidenceListV1 {
  schemaId: typeof EVIDENCE_LIST_SCHEMA_ID;
  caseId: string;
  artifacts: ArtifactV1[];
}

const evidenceListEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(EVIDENCE_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  artifacts: f.req(f.arr(f.str)),
};

export const EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID =
  "cd-collab.evidence_upload_success.v1" as const;

export interface EvidenceUploadSuccessV1 {
  schemaId: typeof EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID;
  caseId: string;
  artifact: ArtifactV1;
  summary: ContributionV1;
}

const evidenceUploadSuccessEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID)),
  caseId: f.req(f.str),
  artifact: f.req(f.str),
  summary: f.req(f.str),
};

const nestedContractMarker = "__validated_by_nested_contract__";

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function evidenceListEnvelope(raw: unknown): unknown {
  if (!isPlainRecord(raw) || !Array.isArray(raw.artifacts)) return raw;
  return {
    ...raw,
    artifacts: Array.from(raw.artifacts, () => nestedContractMarker),
  };
}

function evidenceUploadSuccessEnvelope(raw: unknown): unknown {
  if (!isPlainRecord(raw)) return raw;
  const envelope = { ...raw };
  if (Object.prototype.hasOwnProperty.call(raw, "artifact")) {
    envelope.artifact = nestedContractMarker;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "summary")) {
    envelope.summary = nestedContractMarker;
  }
  return envelope;
}

/** Parse a strict evidence-list envelope and its authoritative artifact records. */
export function parseEvidenceList(raw: unknown): EvidenceListV1 {
  checkObject("$", evidenceListEnvelopeShape, evidenceListEnvelope(raw));
  const evidence = raw as EvidenceListV1;
  for (let index = 0; index < evidence.artifacts.length; index += 1) {
    const artifact = parseArtifact(evidence.artifacts[index]);
    if (artifact.caseId !== evidence.caseId) {
      throw new ContractViolation(
        `$.artifacts[${index}].caseId`,
        "must match root caseId",
      );
    }
  }
  return evidence;
}

/** Parse an upload result without weakening artifact or contribution validation. */
export function parseEvidenceUploadSuccess(
  raw: unknown,
): EvidenceUploadSuccessV1 {
  checkObject(
    "$",
    evidenceUploadSuccessEnvelopeShape,
    evidenceUploadSuccessEnvelope(raw),
  );
  const result = raw as EvidenceUploadSuccessV1;
  parseArtifact(result.artifact);
  parseContribution(result.summary);
  if (result.artifact.caseId !== result.caseId) {
    throw new ContractViolation("$.artifact.caseId", "must match root caseId");
  }
  if (result.summary.caseId !== result.caseId) {
    throw new ContractViolation("$.summary.caseId", "must match root caseId");
  }
  if (result.artifact.summaryContributionId !== result.summary.id) {
    throw new ContractViolation(
      "$.artifact.summaryContributionId",
      "must match summary.id",
    );
  }
  return result;
}
