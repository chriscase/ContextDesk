import { PRIVACY_CLASSES } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

/** A standalone, append-only note attached to one evidence artifact. */
export const ARTIFACT_ANNOTATION_SCHEMA_ID =
  "cd-collab.artifact_annotation.v1" as const;
export const ARTIFACT_ANNOTATION_LIST_SCHEMA_ID =
  "cd-collab.artifact_annotation_list.v1" as const;

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
  annotations: f.req(f.arr(f.str)),
};

const nestedContractMarker = "__validated_by_nested_contract__";

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function annotationListEnvelope(raw: unknown): unknown {
  if (!isPlainRecord(raw) || !Array.isArray(raw.annotations)) return raw;
  return {
    ...raw,
    annotations: Array.from(raw.annotations, () => nestedContractMarker),
  };
}

/** Parse a strict annotation-list envelope and bind every row to its case. */
export function parseArtifactAnnotationList(
  raw: unknown,
): ArtifactAnnotationListV1 {
  checkObject("$", artifactAnnotationListShape, annotationListEnvelope(raw));
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
