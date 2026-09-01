import { ContractViolation } from "@cd-collab/contracts/investigation-runtime";
import type {
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "@cd-collab/contracts";

export type { ArtifactAnnotationListV1, ArtifactAnnotationV1 } from "@cd-collab/contracts";

/**
 * Browser-local projection of the artifact annotation contract.
 *
 * The server contract is authoritative.  The browser package's intentionally
 * narrow `investigation-runtime` entry has not yet exported the annotation
 * module, so this adapter keeps the runtime bundle browser-safe while applying
 * the same strict shape and nested identity checks.  Once that entry exports
 * the shared parser, this file can be reduced to a re-export without changing
 * the gateway/controller surface.
 */
export const ARTIFACT_ANNOTATION_SCHEMA_ID =
  "cd-collab.artifact_annotation.v1" as const;
export const ARTIFACT_ANNOTATION_LIST_SCHEMA_ID =
  "cd-collab.artifact_annotation_list.v1" as const;

const PRIVACY_CLASSES = ["owner_only", "share_safe"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function expectRecord(path: string, value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new ContractViolation(path, `expected object, got ${describe(value)}`);
  }
  return value;
}

function expectExactKeys(
  path: string,
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractViolation(`${path}.${key}`, "unknown key (contract drift)");
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ContractViolation(`${path}.${key}`, "missing required key");
    }
  }
}

function expectString(
  path: string,
  value: unknown,
  nonEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new ContractViolation(path, `expected string, got ${describe(value)}`);
  }
  if (nonEmpty && value.length === 0) {
    throw new ContractViolation(path, "expected non-empty string");
  }
  return value;
}

function parseAnnotationRecord(
  path: string,
  raw: unknown,
): ArtifactAnnotationV1 {
  const value = expectRecord(path, raw);
  expectExactKeys(path, value, [
    "schemaId",
    "id",
    "caseId",
    "artifactId",
    "body",
    "contentHash",
    "privacyClass",
    "authorId",
    "authorUsername",
    "createdAt",
    "sourceId",
  ]);
  if (value.schemaId !== ARTIFACT_ANNOTATION_SCHEMA_ID) {
    throw new ContractViolation(`${path}.schemaId`, "unexpected schema id");
  }
  const privacyClass = value.privacyClass;
  if (
    typeof privacyClass !== "string"
    || !(PRIVACY_CLASSES as readonly string[]).includes(privacyClass)
  ) {
    throw new ContractViolation(`${path}.privacyClass`, "unexpected privacy class");
  }
  return {
    schemaId: ARTIFACT_ANNOTATION_SCHEMA_ID,
    id: expectString(`${path}.id`, value.id),
    caseId: expectString(`${path}.caseId`, value.caseId),
    artifactId: expectString(`${path}.artifactId`, value.artifactId),
    body: expectString(`${path}.body`, value.body, true),
    contentHash: expectString(`${path}.contentHash`, value.contentHash),
    privacyClass: privacyClass as "owner_only" | "share_safe",
    authorId: expectString(`${path}.authorId`, value.authorId),
    authorUsername: expectString(`${path}.authorUsername`, value.authorUsername),
    createdAt: expectString(`${path}.createdAt`, value.createdAt),
    sourceId: expectString(`${path}.sourceId`, value.sourceId),
  };
}

export function parseArtifactAnnotation(raw: unknown): ArtifactAnnotationV1 {
  return parseAnnotationRecord("$", raw);
}

/** Parse a strict case-scoped annotation list and bind every row to its case. */
export function parseArtifactAnnotationList(
  raw: unknown,
): ArtifactAnnotationListV1 {
  const value = expectRecord("$", raw);
  expectExactKeys("$", value, ["schemaId", "caseId", "annotations"]);
  if (value.schemaId !== ARTIFACT_ANNOTATION_LIST_SCHEMA_ID) {
    throw new ContractViolation("$.schemaId", "unexpected schema id");
  }
  const caseId = expectString("$.caseId", value.caseId);
  if (!Array.isArray(value.annotations)) {
    throw new ContractViolation("$.annotations", "expected array");
  }
  const annotations = value.annotations.map((annotation, index) => {
    const parsed = parseAnnotationRecord(`$.annotations[${index}]`, annotation);
    if (parsed.caseId !== caseId) {
      throw new ContractViolation(`$.annotations[${index}].caseId`, "must match root caseId");
    }
    return parsed;
  });
  return {
    schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
    caseId,
    annotations,
  };
}
