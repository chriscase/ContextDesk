import { describe, expect, it } from "vitest";
import {
  ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  parseArtifactAnnotation,
  parseArtifactAnnotationList,
  type ArtifactAnnotationV1,
} from "./artifact-annotation.js";

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
});
