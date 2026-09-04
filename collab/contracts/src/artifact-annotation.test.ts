import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
  ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  parseArtifactAnnotation,
  parseArtifactAnnotationBulkRequest,
  parseArtifactAnnotationBulkResult,
  parseArtifactAnnotationList,
  type ArtifactAnnotationV1,
} from "./artifact-annotation.js";

const Ajv2020 = (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const loadSchema = (name: string): object =>
  JSON.parse(readFileSync(join(schemasDir, name), "utf8")) as object;
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_A = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_B = "33333333-3333-4333-8333-333333333333";

function annotation(overrides: Partial<ArtifactAnnotationV1> = {}): ArtifactAnnotationV1 {
  return {
    schemaId: ARTIFACT_ANNOTATION_SCHEMA_ID,
    id: "annotation-1",
    caseId: "case-1",
    artifactId: "artifact-1",
    body: "The timeout begins after the retry boundary.",
    contentHash: "a".repeat(64),
    privacyClass: "owner_only",
    authorId: "operator-1",
    authorUsername: "operator",
    createdAt: "2026-09-01T12:00:00.000Z",
    sourceId: "source-1",
    ...overrides,
  };
}

describe("artifact annotation contracts", () => {
  it("accepts one immutable annotation and a case-scoped list", () => {
    const item = annotation();
    expect(parseArtifactAnnotation(item)).toEqual(item);
    expect(
      parseArtifactAnnotationList({
        schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
        caseId: "case-1",
        annotations: [item],
      }),
    ).toEqual({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: "case-1",
      annotations: [item],
    });
  });

  it("accepts an empty list and share-safe annotations", () => {
    expect(
      parseArtifactAnnotationList({
        schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
        caseId: "case-1",
        annotations: [],
      }).annotations,
    ).toEqual([]);
    expect(parseArtifactAnnotation(annotation({ privacyClass: "share_safe" }))).toMatchObject({
      privacyClass: "share_safe",
    });
  });

  it("rejects unknown keys, malformed values, and cross-case rows", () => {
    expect(() => parseArtifactAnnotation({ ...annotation(), extra: true })).toThrow(/unknown key/);
    expect(() => parseArtifactAnnotation({ ...annotation(), body: "" })).toThrow(/body/);
    expect(() => parseArtifactAnnotation({ ...annotation(), privacyClass: "private" })).toThrow(/privacyClass/);
    expect(() => parseArtifactAnnotation({ ...annotation(), schemaId: "cd-collab.artifact_annotation.v2" })).toThrow(/schemaId/);
    expect(() => parseArtifactAnnotationList({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: "case-1",
      annotations: [{ ...annotation(), caseId: "case-2" }],
    })).toThrow(/must match root caseId/);
    expect(() => parseArtifactAnnotationList({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: "case-1",
      annotations: [{ ...annotation(), unexpected: true }],
    })).toThrow(/unknown key/);
  });

  it("rejects malformed envelopes and nested annotation records", () => {
    expect(() => parseArtifactAnnotationList({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: "case-1",
      annotations: "not-an-array",
    })).toThrow(/annotations/);
    expect(() => parseArtifactAnnotationList({
      schemaId: "cd-collab.artifact_annotation_list.v2",
      caseId: "case-1",
      annotations: [],
    })).toThrow(/schemaId/);
    expect(() => parseArtifactAnnotationList({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: "case-1",
      annotations: [null],
    })).toThrow(/expected object/);
  });

  it("parses a strict, bounded, unique bulk request", () => {
    const request = {
      schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
      artifactIds: [ARTIFACT_B, ARTIFACT_A],
      body: "Apply the same observation to this target set.",
      idempotencyKey: "bulk-request-0001",
    };
    expect(parseArtifactAnnotationBulkRequest(request)).toEqual(request);
    expect(() => parseArtifactAnnotationBulkRequest({ ...request, artifactIds: [ARTIFACT_A, ARTIFACT_A] }))
      .toThrow(/unique/);
    expect(() => parseArtifactAnnotationBulkRequest({ ...request, artifactIds: ["not-a-uuid"] }))
      .toThrow(/RFC 4122/);
    expect(() => parseArtifactAnnotationBulkRequest({ ...request, artifactIds: [] }))
      .toThrow(/1\.\.=64/);
    expect(() => parseArtifactAnnotationBulkRequest({
      ...request,
      artifactIds: Array.from(
        { length: 65 },
        (_, index) => `40000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      ),
    })).toThrow(/1\.\.=64/);
    expect(() => parseArtifactAnnotationBulkRequest({ ...request, extra: true })).toThrow(/unknown key/);
  });

  it("keeps runtime and JSON Schema aligned for valid payloads and malformed UUIDs", () => {
    const ajv = new (Ajv2020 as new (options?: object) => {
      addSchema(schema: object): void;
      compile(schema: object): (value: unknown) => boolean;
    })({ strict: true });
    ajv.addSchema(loadSchema("artifact-annotation.v1.json"));
    const validateRequest = ajv.compile(loadSchema("artifact-annotation-bulk-request.v1.json"));
    const validateResult = ajv.compile(loadSchema("artifact-annotation-bulk-result.v1.json"));
    const validRequest = {
      schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
      artifactIds: [ARTIFACT_A, ARTIFACT_B],
      body: "Valid target set",
      idempotencyKey: "bulk-request-0002",
    };
    expect(validateRequest(validRequest)).toBe(true);
    expect(parseArtifactAnnotationBulkRequest(validRequest)).toEqual(validRequest);
    const malformedRequest = { ...validRequest, artifactIds: [ARTIFACT_A, "not-a-uuid"] };
    expect(validateRequest(malformedRequest)).toBe(false);
    expect(() => parseArtifactAnnotationBulkRequest(malformedRequest)).toThrow(/RFC 4122/);

    const validResult = {
      schemaId: ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
      caseId: CASE_ID,
      items: [{ artifactId: ARTIFACT_A, outcome: "not_found" }],
    } as const;
    expect(validateResult(validResult)).toBe(true);
    expect(parseArtifactAnnotationBulkResult(validResult)).toEqual(validResult);
    const malformedResult = {
      ...validResult,
      items: [{ artifactId: "not-a-uuid", outcome: "not_found" }],
    } as const;
    expect(validateResult(malformedResult)).toBe(false);
    expect(() => parseArtifactAnnotationBulkResult(malformedResult)).toThrow(/RFC 4122/);
  });

  it("documents whole-object schema uniqueness and enforces unique artifactId in the parser", () => {
    const ajv = new (Ajv2020 as new (options?: object) => {
      addSchema(schema: object): void;
      compile(schema: object): (value: unknown) => boolean;
    })({ strict: true });
    ajv.addSchema(loadSchema("artifact-annotation.v1.json"));
    const validateResult = ajv.compile(loadSchema("artifact-annotation-bulk-result.v1.json"));
    const missingItem = {
      artifactId: ARTIFACT_A,
      outcome: "not_found",
    } as const;
    const createdItem = {
      artifactId: ARTIFACT_A,
      outcome: "created",
      annotation: annotation({ caseId: CASE_ID, artifactId: ARTIFACT_A }),
    } as const;
    const result = {
      schemaId: ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
      caseId: CASE_ID,
      items: [missingItem, createdItem],
    };
    // Draft 2020-12 `uniqueItems` compares complete values. It cannot express
    // uniqueness by one object property without a non-portable extension.
    expect(validateResult(result)).toBe(true);
    expect(() => parseArtifactAnnotationBulkResult(result)).toThrow(/unique/);
  });

  it("binds created bulk items to their case and artifact", () => {
    const item = annotation({ caseId: CASE_ID, artifactId: ARTIFACT_A });
    const result = {
      schemaId: ARTIFACT_ANNOTATION_BULK_RESULT_SCHEMA_ID,
      caseId: CASE_ID,
      items: [{ artifactId: ARTIFACT_A, outcome: "created", annotation: item }],
    } as const;
    expect(parseArtifactAnnotationBulkResult(result)).toEqual(result);
    expect(() => parseArtifactAnnotationBulkResult({
      ...result,
      items: [{ ...result.items[0], artifactId: ARTIFACT_B }],
    })).toThrow(/must match/);
    expect(() => parseArtifactAnnotationBulkResult({
      ...result,
      items: [{ artifactId: ARTIFACT_A, outcome: "not_found", annotation: item }],
    })).toThrow(/must be absent/);
  });
});
