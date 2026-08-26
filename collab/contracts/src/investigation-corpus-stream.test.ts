import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  CORPUS_INTAKE_LIMITS,
  resolveCorpusIntakeLimits,
} from "./investigation-corpus-intake.js";
import {
  CORPUS_INTAKE_ERROR_CODES,
  CORPUS_INTAKE_ERROR_SCHEMA_ID,
  CORPUS_STREAM_COMMIT_SCHEMA_ID,
  CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
  CORPUS_STREAM_SESSION_SCHEMA_ID,
  corpusIntakeError,
  corpusIntakeStagesFor,
  corpusIntakeUnknownsFor,
  parseCorpusIntakeError,
  parseCorpusIntakePreflightRequest,
  parseCorpusIntakeSession,
  parseCorpusIntakeSessionCommitRequest,
} from "./investigation-corpus-stream.js";

function preflight(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
    origin: "files",
    sourceLabel: "streamed upload",
    privacyClass: "owner_only",
    idempotencyKey: "batch-stream-0001",
    parts: [
      { index: 0, relativePath: "mailer/a.log", declaredBytes: 128, declaredMediaType: "text/plain" },
    ],
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: CORPUS_STREAM_SESSION_SCHEMA_ID,
    sessionId: "5b6a5b0f-6b0a-4f0a-8a0a-0a0a0a0a0a0a",
    caseId: "case-1",
    origin: "files",
    sourceLabel: "streamed upload",
    privacyClass: "owner_only",
    idempotencyKey: "batch-stream-0001",
    state: "awaiting_bytes",
    createdAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-08-25T06:00:00.000Z",
    limits: { ...CORPUS_INTAKE_LIMITS },
    selection: { partCount: 1, declaredBytes: 128, compressedBytes: null, expandedBytes: 128 },
    stages: corpusIntakeStagesFor("files"),
    unknowns: corpusIntakeUnknownsFor("files"),
    parts: [{
      index: 0,
      relativePath: "mailer/a.log",
      declaredBytes: 128,
      declaredMediaType: "text/plain",
      receivedBytes: 0,
      complete: false,
      digest: null,
    }],
    progress: {
      stage: "preflight",
      determinate: true,
      uploadedBytes: 0,
      declaredBytes: 128,
      expandedBytes: 0,
      expectedExpandedBytes: null,
      filesSeen: 0,
      filesAccepted: 0,
      filesRejected: 0,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
    previewToken: null,
    batchId: null,
    failure: null,
    ...overrides,
  };
}

describe("streamed corpus intake contract", () => {
  it("names every refusal a reader could have to act on", () => {
    for (const required of [
      "request_too_large",
      "expanded_budget_exceeded",
      "file_count_exceeded",
      "unsupported_encoding",
      "unsafe_archive_path",
    ]) {
      expect(CORPUS_INTAKE_ERROR_CODES).toContain(required);
    }
    const error = parseCorpusIntakeError(corpusIntakeError(
      "expanded_budget_exceeded",
      "The expanded corpus is larger than this investigation accepts.",
      { limit: 512, observed: 513, path: "mailer/a.log" },
    ));
    expect(error.schemaId).toBe(CORPUS_INTAKE_ERROR_SCHEMA_ID);
    expect(error.limit).toBe(512);
    expect(error.observed).toBe(513);
    expect(error.retryable).toBe(false);
    expect(() => parseCorpusIntakeError({ ...error, code: "kaput" })).toThrow(ContractViolation);
  });

  it("lists the stages and the unknowns each origin genuinely has", () => {
    expect(corpusIntakeStagesFor("zip")).toEqual([
      "preflight",
      "upload",
      "archive_index",
      "expand",
      "classify",
      "privacy_scan",
      "stage_evidence",
      "commit",
    ]);
    expect(corpusIntakeStagesFor("directory")).not.toContain("archive_index");
    // A browser's file picker knows a ZIP's compressed size and nothing else
    // about it, so a preflight that claimed otherwise would be fabricating.
    expect(corpusIntakeUnknownsFor("zip")).toContain("expanded_bytes");
    expect(corpusIntakeUnknownsFor("files")).not.toContain("expanded_bytes");
  });

  it("refuses an inadmissible preflight on the manifest alone", () => {
    expect(parseCorpusIntakePreflightRequest(preflight()).parts).toHaveLength(1);
    expect(() => parseCorpusIntakePreflightRequest(preflight({ parts: [] })))
      .toThrow(/at least one part/);
    expect(() => parseCorpusIntakePreflightRequest(preflight({ extra: true })))
      .toThrow(/unknown key/);
    expect(() => parseCorpusIntakePreflightRequest(preflight({ idempotencyKey: "short" })))
      .toThrow(/bounded token/);
    expect(() => parseCorpusIntakePreflightRequest(preflight({
      origin: "zip",
      parts: [
        { index: 0, relativePath: "a.zip", declaredBytes: 8, declaredMediaType: "application/zip" },
        { index: 1, relativePath: "b.zip", declaredBytes: 8, declaredMediaType: "application/zip" },
      ],
    }))).toThrow(/exactly one archive part/);
    expect(() => parseCorpusIntakePreflightRequest(preflight({
      parts: [{
        index: 0,
        relativePath: "mailer/a.log",
        declaredBytes: CORPUS_INTAKE_LIMITS.maxFileBytes + 1,
        declaredMediaType: "text/plain",
      }],
    }))).toThrow(/per_file_bytes_exceeded/);
    expect(() => parseCorpusIntakePreflightRequest(preflight({
      parts: [
        { index: 0, relativePath: "a.log", declaredBytes: 1, declaredMediaType: "text/plain" },
        { index: 2, relativePath: "b.log", declaredBytes: 1, declaredMediaType: "text/plain" },
      ],
    }))).toThrow(/densely indexed/);
  });

  it("checks an archive's declared bytes against the compressed cap, not the expanded one", () => {
    const limits = resolveCorpusIntakeLimits({
      maxExpandedBytes: 2 * 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxLineBytes: 1024 * 1024,
      maxStructuredParseBytes: 1024 * 1024,
      maxArchiveBytes: 8 * 1024 * 1024,
    });
    // A 4 MiB archive is admissible even though the expanded budget is 2 MiB:
    // what it expands to is unknown until its index is read.
    expect(parseCorpusIntakePreflightRequest(preflight({
      origin: "zip",
      parts: [{
        index: 0,
        relativePath: "diagnostics.zip",
        declaredBytes: 4 * 1024 * 1024,
        declaredMediaType: "application/zip",
      }],
    }), limits).origin).toBe("zip");
    expect(() => parseCorpusIntakePreflightRequest(preflight({
      parts: [
        { index: 0, relativePath: "a.log", declaredBytes: 1024 * 1024, declaredMediaType: "text/plain" },
        { index: 1, relativePath: "b.log", declaredBytes: 1024 * 1024, declaredMediaType: "text/plain" },
        { index: 2, relativePath: "c.log", declaredBytes: 1, declaredMediaType: "text/plain" },
      ],
    }), limits)).toThrow(/expanded_budget_exceeded/);
  });

  it("refuses a session record whose progress contradicts its parts", () => {
    expect(parseCorpusIntakeSession(session()).state).toBe("awaiting_bytes");
    expect(() => parseCorpusIntakeSession(session({
      selection: { partCount: 2, declaredBytes: 128, compressedBytes: null, expandedBytes: 128 },
    }))).toThrow(/does not match the part list/);
    expect(() => parseCorpusIntakeSession(session({
      parts: [{
        index: 0,
        relativePath: "mailer/a.log",
        declaredBytes: 128,
        declaredMediaType: "text/plain",
        receivedBytes: 200,
        complete: false,
        digest: null,
      }],
    }))).toThrow(/cannot exceed the declared size/);
    expect(() => parseCorpusIntakeSession(session({
      parts: [{
        index: 0,
        relativePath: "mailer/a.log",
        declaredBytes: 128,
        declaredMediaType: "text/plain",
        receivedBytes: 64,
        complete: true,
        digest: null,
      }],
    }))).toThrow(/received every declared byte/);
    // Determinate progress drawn from an unknown total is the lie this check
    // exists to prevent.
    expect(() => parseCorpusIntakeSession(session({
      progress: { ...session().progress, determinate: true, declaredBytes: null },
    }))).toThrow(/determinate progress requires a known total/);
  });

  it("requires a bounded key and a real digest to commit a session", () => {
    const body = {
      schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
      previewToken: "a".repeat(64),
      idempotencyKey: "batch-stream-0001",
    };
    expect(parseCorpusIntakeSessionCommitRequest(body).previewToken).toBe("a".repeat(64));
    expect(() => parseCorpusIntakeSessionCommitRequest({ ...body, previewToken: "nope" }))
      .toThrow(/SHA-256 digest/);
    expect(() => parseCorpusIntakeSessionCommitRequest({ ...body, idempotencyKey: "x" }))
      .toThrow(/bounded token/);
  });
});
