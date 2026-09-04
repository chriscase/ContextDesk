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
};

export function parseArtifactAnnotation(raw: unknown): ArtifactAnnotationV1 {
  checkObject("$", artifactAnnotationShape, raw);
  return raw as ArtifactAnnotationV1;
}

export interface ArtifactAnnotationListV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_LIST_SCHEMA_ID;
  caseId: string;
  annotations: ArtifactAnnotationV1[];
}

const artifactAnnotationListShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  annotations: f.req(f.arr(f.obj(artifactAnnotationShape))),
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
}

const artifactAnnotationBulkRequestShape: ObjectShape = {
  schemaId: f.req(f.en(ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID)),
  artifactIds: f.req(f.arr(f.nstr)),
  body: f.req(f.nstr),
  privacyClass: f.opt(f.en(...PRIVACY_CLASSES)),
  clientTime: f.opt(f.str),
  sourceId: f.opt(f.nstr),
  idempotencyKey: f.req(f.nstr),
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
  return request;
}

export const ARTIFACT_ANNOTATION_BULK_OUTCOMES = [
  "created",
  "replayed",
  "not_found",
] as const;
export type ArtifactAnnotationBulkOutcome =
  (typeof ARTIFACT_ANNOTATION_BULK_OUTCOMES)[number];

export type ArtifactAnnotationBulkItemV1 =
  | { artifactId: string; outcome: "created" | "replayed"; annotation: ArtifactAnnotationV1 }
  | { artifactId: string; outcome: "not_found" };

export interface ArtifactAnnotationBulkResultV1 {
  schemaId: typeof ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID;
  caseId: string;
  items: ArtifactAnnotationBulkItemV1[];
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
    if (item.outcome === "not_found") {
      if (annotation !== undefined) {
        throw new ContractViolation(`$.items[${index}].annotation`, "must be absent for not_found");
      }
      continue;
    }
    if (annotation === undefined) {
      throw new ContractViolation(`$.items[${index}].annotation`, `is required for ${item.outcome}`);
    }
    const parsed = parseArtifactAnnotation(annotation);
    if (parsed.caseId !== result.caseId || parsed.artifactId !== item.artifactId) {
      throw new ContractViolation(`$.items[${index}].annotation`, "must match result caseId and artifactId");
    }
  }
  return result;
}
