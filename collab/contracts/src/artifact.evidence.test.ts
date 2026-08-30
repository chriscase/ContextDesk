import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  parseEvidenceList,
  parseEvidenceUploadSuccess,
  type ArtifactV1,
} from "./artifact.js";
import {
  CONTRIBUTION_SCHEMA_ID,
  type ContributionV1,
} from "./contribution.js";

function artifact(overrides: Partial<ArtifactV1> = {}): ArtifactV1 {
  return {
    schemaId: ARTIFACT_SCHEMA_ID,
    id: "artifact-1",
    caseId: "case-1",
    kind: "attachment",
    filename: "evidence.txt",
    uri: null,
    mediaType: "text/plain",
    byteLength: 8,
    contentHash: "sha256:observed",
    expectedHash: null,
    verificationStatus: "verified",
    privacyClass: "owner_only",
    summaryContributionId: "contribution-1",
    uploaderId: "operator-1",
    sourceId: "source-1",
    ...overrides,
  };
}

function summary(overrides: Partial<ContributionV1> = {}): ContributionV1 {
  return {
    schemaId: CONTRIBUTION_SCHEMA_ID,
    id: "contribution-1",
    caseId: "case-1",
    kind: "upload",
    revision: 1,
    predecessorRevision: null,
    body: "Uploaded evidence.txt",
    contentHash: "sha256:summary",
    privacyClass: "owner_only",
    tombstoned: false,
    authorId: "operator-1",
    authorUsername: "operator",
    createdAt: "2026-08-29T12:00:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: "source-1",
    ...overrides,
  };
}

describe("evidence transport contracts", () => {
  it("accepts an empty evidence list", () => {
    const parsed = parseEvidenceList({
      schemaId: EVIDENCE_LIST_SCHEMA_ID,
      caseId: "case-1",
      artifacts: [],
    });
    expect(parsed.artifacts).toEqual([]);
  });

  it("accepts populated evidence and upload-success payloads", () => {
    const item = artifact();
    expect(
      parseEvidenceList({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifacts: [item],
      }).artifacts,
    ).toEqual([item]);

    const uploadSummary = summary();
    expect(
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: item,
        summary: uploadSummary,
      }),
    ).toMatchObject({ artifact: item, summary: uploadSummary });
  });

  it("rejects malformed nested records and unknown keys", () => {
    expect(() =>
      parseEvidenceList({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifacts: [{ ...artifact(), byteLength: -1 }],
      }),
    ).toThrow(/byteLength/);
    expect(() =>
      parseEvidenceList({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifacts: [{ ...artifact(), unexpected: true }],
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
        summary: { ...summary(), unexpected: true },
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
        summary: summary(),
        unexpected: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: null,
        summary: summary(),
      }),
    ).toThrow(/expected object/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
      }),
    ).toThrow(/missing required key/);
  });

  it("rejects wrong envelope schemas", () => {
    expect(() =>
      parseEvidenceList({
        schemaId: "cd-collab.evidence_list.v2",
        caseId: "case-1",
        artifacts: [],
      }),
    ).toThrow(/schemaId/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
        summary: summary(),
      }),
    ).toThrow(/schemaId/);
    expect(() =>
      parseEvidenceList({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifacts: [{ ...artifact(), schemaId: "cd-collab.artifact.v2" }],
      }),
    ).toThrow(/schemaId/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
        summary: {
          ...summary(),
          schemaId: "cd-collab.contribution.v2",
        },
      }),
    ).toThrow(/schemaId/);
  });

  it("rejects evidence-list artifacts from another case", () => {
    expect(() =>
      parseEvidenceList({
        schemaId: EVIDENCE_LIST_SCHEMA_ID,
        caseId: "case-1",
        artifacts: [artifact({ caseId: "case-2" })],
      }),
    ).toThrow(/must match root caseId/);
  });

  it("rejects upload artifact, summary, and link identity mismatches", () => {
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact({ caseId: "case-2" }),
        summary: summary(),
      }),
    ).toThrow(/artifact\.caseId/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact(),
        summary: summary({ caseId: "case-2" }),
      }),
    ).toThrow(/summary\.caseId/);
    expect(() =>
      parseEvidenceUploadSuccess({
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: "case-1",
        artifact: artifact({ summaryContributionId: "contribution-2" }),
        summary: summary(),
      }),
    ).toThrow(/summaryContributionId/);
  });
});
