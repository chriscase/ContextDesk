import { evidenceLabelEventShape, evidenceLabelMutationShape, parseEvidenceLabelEvent, parseEvidenceLabelMutation, projectEvidenceLabels, type EvidenceLabelEventV1, type EvidenceLabelMutationV1, type EvidenceLabelStateV1 } from "./evidence-labels.js";
import { isIsoInstant } from "./temporal.js";
import { PRIVACY_CLASSES } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

/** A standalone, append-only note attached to one evidence artifact. */
export const ARTIFACT_ANNOTATION_SCHEMA_ID =
  "cd-collab.artifact_annotation.v1" as const;
export const ARTIFACT_ANNOTATION_LIST_SCHEMA_ID =
  "cd-collab.artifact_annotation_list.v1" as const;
export const ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID =
  "cd-collab.artifact_annotation_bulk_request.v1" as const;
export const ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID =
  "cd-collab.artifact_annotation_bulk_result.v1" as const;
export const MAX_ARTIFACT_ANNOTATION_BULK_IDS = 64;

export interface ArtifactAnnotationV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_SCHEMA_ID;
  id: string;
  caseId: string;
  artifactId: string;
  body: string;
  contentHash: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  authorId: string;
  authorUsername: string;
  createdAt: string;
  sourceId: string;
  labelEvent?: EvidenceLabelEventV1;
}

const artifactAnnotationShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  artifactId: f.req(f.str),
  body: f.req(f.nstr),
  contentHash: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  authorId: f.req(f.str),
  authorUsername: f.req(f.str),
  createdAt: f.req(f.str),
  sourceId: f.req(f.str),
  labelEvent: f.opt(f.obj(evidenceLabelEventShape)),
};

export function parseArtifactAnnotation(raw: unknown): ArtifactAnnotationV1 {
  checkObject("$", artifactAnnotationShape, raw);
  const row = raw as ArtifactAnnotationV1;
  if (row.labelEvent !== undefined) {
    parseEvidenceLabelEvent(row.labelEvent);
    for (const id of [row.id, row.caseId, row.artifactId, row.sourceId]) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new ContractViolation("$.labelEvent", "invalid binding UUID");
    }
    if (!row.authorId.trim() || !row.authorUsername.trim() || !isIsoInstant(row.createdAt)
      || !/^[a-f0-9]{64}$/.test(row.contentHash)) throw new ContractViolation("$.labelEvent", "invalid attribution/time/hash");
  }
  return row;
}

export interface ArtifactAnnotationListV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_LIST_SCHEMA_ID;
  caseId: string;
  annotations: ArtifactAnnotationV1[];
  currentLabels?: EvidenceLabelStateV1[];
}

const artifactAnnotationListShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  annotations: f.req(f.arr(f.obj(artifactAnnotationShape))),
  currentLabels: f.opt(f.arr(f.obj({artifactId: f.req(f.nstr), label: f.req(f.nstr)}))),
};

/** Parse a strict annotation-list envelope and bind every row to its case. */
export function parseArtifactAnnotationList(
  raw: unknown,
): ArtifactAnnotationListV1 {
  checkObject("$", artifactAnnotationListShape, raw);
  const list = raw as ArtifactAnnotationListV1;
  for (let index = 0; index < list.annotations.length; index += 1) {
    const annotation = parseArtifactAnnotation(list.annotations[index]);
    if (annotation.caseId !== list.caseId) {
      throw new ContractViolation(
        `$.annotations[${index}].caseId`,
        "must match root caseId",
      );
    }
  }
  const sequences = list.annotations.flatMap(row => row.labelEvent ? [JSON.stringify([row.artifactId, row.privacyClass, row.labelEvent.sequence])] : []);
  if (new Set(sequences).size !== sequences.length) throw new ContractViolation("$.annotations", "label sequences must be unique within artifact/privacy lane");
  if (list.currentLabels !== undefined && JSON.stringify(list.currentLabels) !== JSON.stringify(projectEvidenceLabels(list.annotations))) {
    throw new ContractViolation("$.currentLabels", "must match visible append-only history");
  }
  return list;
}

export interface ArtifactAnnotationBulkRequestV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID;
  artifactIds: string[];
  body: string;
  privacyClass?: (typeof PRIVACY_CLASSES)[number];
  clientTime?: string;
  sourceId?: string;
  idempotencyKey: string;
  labelMutation?: EvidenceLabelMutationV1;
}

const artifactAnnotationBulkRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID)),
  artifactIds: f.req(f.arr(f.nstr)),
  body: f.req(f.nstr),
  privacyClass: f.opt(f.en(...PRIVACY_CLASSES)),
  clientTime: f.opt(f.str),
  sourceId: f.opt(f.nstr),
  idempotencyKey: f.req(f.nstr),
  labelMutation: f.opt(f.obj(evidenceLabelMutationShape)),
};

const RFC4122_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

/** Parse a bounded request whose target ids form a set, not an ordered work queue. */
export function parseArtifactAnnotationBulkRequest(raw: unknown): ArtifactAnnotationBulkRequestV1 {
  checkObject("$", artifactAnnotationBulkRequestShape, raw);
  const request = raw as ArtifactAnnotationBulkRequestV1;
  if (request.body.trim().length === 0) {
    throw new ContractViolation("$.body", "must contain non-whitespace text");
  }
  if (request.artifactIds.length < 1 || request.artifactIds.length > MAX_ARTIFACT_ANNOTATION_BULK_IDS) {
    throw new ContractViolation(
      "$.artifactIds",
      `must contain 1..=${MAX_ARTIFACT_ANNOTATION_BULK_IDS} ids`,
    );
  }
  if (new Set(request.artifactIds).size !== request.artifactIds.length) {
    throw new ContractViolation("$.artifactIds", "must contain unique ids");
  }
  for (const [index, artifactId] of request.artifactIds.entries()) {
    if (!RFC4122_UUID_RE.test(artifactId)) {
      throw new ContractViolation(`$.artifactIds[${index}]`, "must be an RFC 4122 UUID");
    }
  }
  if (request.sourceId !== undefined && !RFC4122_UUID_RE.test(request.sourceId)) {
    throw new ContractViolation("$.sourceId", "must be an RFC 4122 UUID");
  }
  if (!IDEMPOTENCY_KEY_RE.test(request.idempotencyKey)) {
    throw new ContractViolation("$.idempotencyKey", "must be 8..128 safe characters");
  }
  if (request.labelMutation !== undefined) {
    parseEvidenceLabelMutation(request.labelMutation);
    if (request.body !== `${request.labelMutation.operation}: ${request.labelMutation.label}`) {
      throw new ContractViolation("$.body", "must match the explicit label intent");
    }
    if (request.privacyClass === undefined) throw new ContractViolation("$.privacyClass", "required for label mutation");
  }
  return request;
}

export const ARTIFACT_ANNOTATION_BULK_OUTCOMES = [
  "created",
  "replayed",
  "not_found",
  "applied",
  "already_desired",
] as const;
export type ArtifactAnnotationBulkOutcome =
  (typeof ARTIFACT_ANNOTATION_BULK_OUTCOMES)[number];

export type ArtifactAnnotationBulkItemV1 =
  | { artifactId: string; outcome: "created" | "replayed" | "applied"; annotation: ArtifactAnnotationV1 }
  | { artifactId: string; outcome: "not_found" }
  | { artifactId: string; outcome: "already_desired" };

export interface ArtifactAnnotationBulkResultV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID;
  caseId: string;
  items: ArtifactAnnotationBulkItemV1[];
  labelMutation?: EvidenceLabelMutationV1;
  privacyClass?: (typeof PRIVACY_CLASSES)[number];
  idempotencyKey?: string;
}

const artifactAnnotationBulkItemShape: ObjectShape = {
  artifactId: f.req(f.nstr),
  outcome: f.req(f.en(...ARTIFACT_ANNOTATION_BULK_OUTCOMES)),
  annotation: f.opt(f.obj(artifactAnnotationShape)),
};

const artifactAnnotationBulkResultShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  items: f.req(f.arr(f.obj(artifactAnnotationBulkItemShape))),
  labelMutation: f.opt(f.obj(evidenceLabelMutationShape)),
  privacyClass: f.opt(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.opt(f.nstr),
};

/** Parse a strict result and enforce item/annotation case and target binding. */
export function parseArtifactAnnotationBulkResult(raw: unknown): ArtifactAnnotationBulkResultV1 {
  checkObject("$", artifactAnnotationBulkResultShape, raw);
  const result = raw as ArtifactAnnotationBulkResultV1;
  if (!RFC4122_UUID_RE.test(result.caseId)) {
    throw new ContractViolation("$.caseId", "must be an RFC 4122 UUID");
  }
  if (result.items.length < 1 || result.items.length > MAX_ARTIFACT_ANNOTATION_BULK_IDS) {
    throw new ContractViolation("$.items", `must contain 1..=${MAX_ARTIFACT_ANNOTATION_BULK_IDS} items`);
  }
  if (result.labelMutation !== undefined) {
    parseEvidenceLabelMutation(result.labelMutation);
    if (result.privacyClass === undefined || result.idempotencyKey === undefined || !IDEMPOTENCY_KEY_RE.test(result.idempotencyKey)) {
      throw new ContractViolation("$.labelMutation", "requires privacy and intent identity");
    }
  } else if (result.privacyClass !== undefined || result.idempotencyKey !== undefined) throw new ContractViolation("$", "unexpected label intent fields");
  const ids = new Set<string>();
  for (const [index, item] of result.items.entries()) {
    if (!RFC4122_UUID_RE.test(item.artifactId)) {
      throw new ContractViolation(`$.items[${index}].artifactId`, "must be an RFC 4122 UUID");
    }
    if (ids.has(item.artifactId)) {
      throw new ContractViolation("$.items", "must contain unique artifactId values");
    }
    ids.add(item.artifactId);
    const annotation = "annotation" in item ? item.annotation : undefined;
    if (item.outcome === "already_desired" && result.labelMutation === undefined) throw new ContractViolation("$.items", "label intent required");
    if (item.outcome === "not_found" || item.outcome === "already_desired") {
      if (annotation !== undefined) {
        throw new ContractViolation(`$.items[${index}].annotation`, "must be absent for not_found");
      }
      continue;
    }
    if (annotation === undefined) {
      throw new ContractViolation(`$.items[${index}].annotation`, `is required for ${item.outcome}`);
    }
    const parsed = parseArtifactAnnotation(annotation);
    if (result.labelMutation !== undefined) {
      if (item.outcome === "created" || parsed.labelEvent?.label !== result.labelMutation.label
        || parsed.labelEvent.operation !== result.labelMutation.operation || parsed.labelEvent.intentKey !== result.idempotencyKey
        || parsed.privacyClass !== result.privacyClass) throw new ContractViolation("$.items", "label result must bind frozen intent");
    } else if (parsed.labelEvent !== undefined || item.outcome === "applied") throw new ContractViolation("$.items", "unexpected label event");
    if (parsed.caseId !== result.caseId || parsed.artifactId !== item.artifactId) {
      throw new ContractViolation(`$.items[${index}].annotation`, "must match result caseId and artifactId");
    }
  }
  return result;
}
