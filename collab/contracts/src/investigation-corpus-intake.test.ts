import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  CORPUS_INTAKE_BATCH_SCHEMA_ID,
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES,
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  CORPUS_INTAKE_REPORT_SCHEMA_ID,
  parseCorpusIntakeBatch,
  parseCorpusIntakeCommitRequest,
  parseCorpusIntakePreviewReport,
  parseCorpusIntakePreviewRequest,
  base64LengthForBytes,
  corpusIntakeJsonBodyLimitBytes,
  corpusIntakePeakResidentBytes,
  resolveCorpusIntakeLimits,
  V8_MAX_STRING_LENGTH,
  corpusAllowedExtension,
} from "./investigation-corpus-intake.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(schemasDir, name), "utf8")) as object;
}

function previewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
    origin: "files",
    sourceLabel: "fixture-operator-upload",
    privacyClass: "owner_only",
    idempotencyKey: "batch-syn-0001",
    files: [
      {
        relativePath: "mailer/shared-timeout.log",
        mediaType: "text/plain",
        contentBase64: Buffer.from("2026-08-15T00:00:00Z mailer timeout id=syn-1\n").toString(
          "base64",
        ),
      },
    ],
    archiveBase64: null,
    ...overrides,
  };
}

function commitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...previewBody(),
    schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
    previewToken: "c".repeat(64),
    ...overrides,
  };
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
    caseId: "11111111-1111-4111-8111-111111111111",
    origin: "files",
    previewToken: "d".repeat(64),
    accepted: [
      {
        relativePath: "mailer/shared-timeout.log",
        mediaType: "text/x-log",
        artifactKind: "log",
        byteLength: 44,
        digest: "a".repeat(64),
        duplicateDigest: false,
        encodingStatus: "utf8",
      },
    ],
    rejected: [],
    limits: { ...CORPUS_INTAKE_LIMITS },
    ...overrides,
  };
}

function batchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: CORPUS_INTAKE_BATCH_SCHEMA_ID,
    id: "22222222-2222-4222-8222-222222222222",
    caseId: "11111111-1111-4111-8111-111111111111",
    origin: "zip",
    sourceLabel: "fixture-zip",
    privacyClass: "share_safe",
    idempotencyKey: "batch-syn-0001",
    requestDigest: "e".repeat(64),
    replayed: false,
    createdAt: "2026-08-15T00:00:00.000Z",
    createdBy: "uid=alice,ou=people,dc=example,dc=test",
    items: [
      {
        artifactId: "33333333-3333-4333-8333-333333333333",
        relativePath: "mailer/shared-timeout.log",
        digest: "b".repeat(64),
        byteLength: 44,
        mediaType: "text/x-log",
        privacyClass: "share_safe",
        sourceId: "source-1",
        duplicateDigest: false,
        encodingStatus: "utf8",
      },
    ],
    rejected: [
      {
        relativePath: "mailer/payload.bin",
        reason: "unsupported_media",
        detail: "extension is not in the intake allowlist",
      },
    ],
    ...overrides,
  };
}

describe("corpus intake contract", () => {
  it("recognizes JSON Lines and bounded rotated logs without accepting arbitrary suffixes", () => {
    expect(corpusAllowedExtension("logs/service.log")).toBe(".log");
    expect(corpusAllowedExtension("logs/events.jsonl")).toBe(".jsonl");
    expect(corpusAllowedExtension("logs/events.NDJSON")).toBe(".ndjson");
    expect(corpusAllowedExtension("logs/service.log.1")).toBe(".log");
    expect(corpusAllowedExtension("logs/service.log-2026-08-25")).toBe(".log");
    expect(corpusAllowedExtension("logs/service.log.previous")).toBe(".log");
    expect(corpusAllowedExtension("logs/service.log.exe")).toBeNull();
    expect(corpusAllowedExtension("logs/service.log.1.gz")).toBeNull();
    expect(corpusAllowedExtension("logs/events.jsonl.1")).toBeNull();
    expect(corpusAllowedExtension("logs/events.ndjson.gz")).toBeNull();
  });

  it("publishes the bounded limits used by preview and commit", () => {
    expect(CORPUS_INTAKE_LIMITS).toEqual({
      maxRequestBytes: 8_388_608,
      maxArchiveBytes: 67_108_864,
      maxExpandedBytes: 536_870_912,
      maxCompressionRatio: 256,
      maxFileCount: 4_096,
      maxPathDepth: 8,
      maxArchiveDepth: 0,
      maxPathLength: 240,
      maxFileBytes: 67_108_864,
      maxProcessingMs: 60_000,
      maxExpansionMs: 600_000,
      maxLineBytes: 8_388_608,
      maxStructuredParseBytes: 16_777_216,
      supportedEncodings: ["utf-8", "us-ascii", "utf-8-lossy"],
    });
  });

  it("advertises a JSON body limit the runtime can actually materialize", () => {
    // The pre-streaming ceiling was derived from the whole expanded allowance
    // (4 * ceil(512 MiB / 3) + per-file JSON metadata = 723,827,372 bytes) and
    // handed straight to Fastify, which parses JSON from a string. V8 cannot
    // build a string that long, so every body between the string ceiling and
    // the advertised limit failed with an allocation error rather than a
    // reviewable intake decision.
    const preStreamingCeiling =
      base64LengthForBytes(CORPUS_INTAKE_LIMITS.maxExpandedBytes)
      + CORPUS_INTAKE_LIMITS.maxFileCount * (CORPUS_INTAKE_LIMITS.maxPathLength * 6 + 512)
      + 4_096;
    expect(preStreamingCeiling).toBe(723_827_372);
    expect(preStreamingCeiling).toBeGreaterThan(V8_MAX_STRING_LENGTH);
    expect(CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES).toBe(CORPUS_INTAKE_LIMITS.maxRequestBytes);
    expect(CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES).toBeLessThan(V8_MAX_STRING_LENGTH);
    expect(() => Buffer.alloc(CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES).toString("latin1"))
      .not.toThrow();
  });

  it("resolves owner-local limit overrides and refuses ones the runtime cannot keep", () => {
    const narrowed = resolveCorpusIntakeLimits({
      maxExpandedBytes: 128 * 1024 * 1024,
      maxFileCount: 512,
      supportedEncodings: ["utf-8"],
    });
    expect(narrowed.maxExpandedBytes).toBe(134_217_728);
    expect(narrowed.maxFileCount).toBe(512);
    expect(narrowed.supportedEncodings).toEqual(["utf-8"]);
    expect(narrowed.maxArchiveBytes).toBe(CORPUS_INTAKE_LIMITS.maxArchiveBytes);

    const widened = resolveCorpusIntakeLimits({
      maxRequestBytes: 32 * 1024 * 1024,
      maxArchiveDepth: 1,
      supportedEncodings: ["utf-8", "utf-16le"],
    });
    expect(corpusIntakeJsonBodyLimitBytes(widened)).toBe(33_554_432);
    expect(corpusIntakeJsonBodyLimitBytes(widened)).toBeLessThan(V8_MAX_STRING_LENGTH);

    expect(() => resolveCorpusIntakeLimits({ maxRequestBytes: 600_000_000 }))
      .toThrow(/maxRequestBytes exceeds the ceiling/);
    expect(() => resolveCorpusIntakeLimits({ maxArchiveDepth: 3 }))
      .toThrow(/maxArchiveDepth exceeds the ceiling/);
    expect(() => resolveCorpusIntakeLimits({ maxFileBytes: 0 }))
      .toThrow(/maxFileBytes must be at least 1/);
    expect(() => resolveCorpusIntakeLimits({
      maxFileBytes: 4 * 1024 * 1024,
      maxStructuredParseBytes: 1024,
    })).toThrow(/maxLineBytes cannot exceed maxFileBytes/);
    expect(() => resolveCorpusIntakeLimits({ supportedEncodings: ["us-ascii"] }))
      .toThrow(/must include utf-8/);
  });

  it("states a peak resident bound that does not grow with the corpus", () => {
    const small = resolveCorpusIntakeLimits({ maxExpandedBytes: 64 * 1024 * 1024 });
    const large = resolveCorpusIntakeLimits({ maxExpandedBytes: 4 * 1024 * 1024 * 1024 });
    expect(corpusIntakePeakResidentBytes(small)).toBe(corpusIntakePeakResidentBytes(large));
    expect(corpusIntakePeakResidentBytes(CORPUS_INTAKE_LIMITS)).toBeLessThan(64 * 1024 * 1024);
  });

  it("accepts the exact file-count boundary and rejects one file over it", () => {
    const file = previewBody().files as unknown[];
    const exact = Array.from({ length: CORPUS_INTAKE_LIMITS.maxFileCount }, () => file[0]);
    expect(parseCorpusIntakePreviewRequest(previewBody({ files: exact })).files).toHaveLength(4_096);
    expect(() => parseCorpusIntakePreviewRequest(previewBody({ files: [...exact, file[0]] })))
      .toThrow(/file count exceeds cap/);
  });

  it("accepts file, zip, and directory preview requests and rejects unknown fields", () => {
    expect(parseCorpusIntakePreviewRequest(previewBody()).origin).toBe("files");
    expect(
      parseCorpusIntakePreviewRequest(
        previewBody({ origin: "directory", files: previewBody().files }),
      ).origin,
    ).toBe("directory");
    expect(
      parseCorpusIntakePreviewRequest(
        previewBody({
          origin: "zip",
          files: [],
          archiveBase64: Buffer.from("PK").toString("base64"),
        }),
      ).origin,
    ).toBe("zip");
    expect(() => parseCorpusIntakePreviewRequest(previewBody({ extra: true }))).toThrow(
      /unknown key/,
    );
    expect(() => parseCorpusIntakePreviewRequest(previewBody({ sourceLabel: "  " }))).toThrow(
      ContractViolation,
    );
    expect(() => parseCorpusIntakePreviewRequest(previewBody({ files: [] }))).toThrow(/at least one file/);
    expect(() =>
      parseCorpusIntakePreviewRequest(previewBody({ origin: "zip", files: [], archiveBase64: null })),
    ).toThrow(/archiveBase64/);
    expect(() =>
      parseCorpusIntakePreviewRequest(
        previewBody({ origin: "zip", files: previewBody().files, archiveBase64: "UEs=" }),
      ),
    ).toThrow(/does not accept direct files/);
    expect(() =>
      parseCorpusIntakePreviewRequest(previewBody({ archiveBase64: "UEs=" })),
    ).toThrow(/requires a null archive/);
  });

  it("requires a bounded idempotency key on commit", () => {
    expect(parseCorpusIntakeCommitRequest(commitBody()).idempotencyKey).toBe("batch-syn-0001");
    expect(() => parseCorpusIntakeCommitRequest(commitBody({ idempotencyKey: "short" }))).toThrow(
      /bounded token/,
    );
    expect(() =>
      parseCorpusIntakeCommitRequest(commitBody({ idempotencyKey: "<script>alert(1)</script>" })),
    ).toThrow(/bounded token/);
  });

  it("parses preview reports and committed batches without unknown fields", () => {
    const report = parseCorpusIntakePreviewReport(reportBody());
    expect(report.accepted[0]?.relativePath).toBe("mailer/shared-timeout.log");
    // An owner-local override is readable; an unresolvable one is not.
    expect(parseCorpusIntakePreviewReport(reportBody({
      limits: { ...CORPUS_INTAKE_LIMITS, maxFileCount: CORPUS_INTAKE_LIMITS.maxFileCount - 1 },
    })).limits.maxFileCount).toBe(CORPUS_INTAKE_LIMITS.maxFileCount - 1);
    expect(() => parseCorpusIntakePreviewReport(reportBody({
      limits: { ...CORPUS_INTAKE_LIMITS, maxRequestBytes: 600_000_000 },
    }))).toThrow(/exceeds the ceiling/);
    expect(() => parseCorpusIntakePreviewReport(reportBody({ leaked: "nope" }))).toThrow(/unknown key/);
    const batch = parseCorpusIntakeBatch(batchBody());
    expect(batch.items).toHaveLength(1);
    expect(batch.rejected[0]?.reason).toBe("unsupported_media");
    expect(
      parseCorpusIntakeBatch(
        batchBody({
          rejected: [
            {
              relativePath: "<invalid-encoding>",
              reason: "invalid_encoding",
              detail: "ZIP UTF-8 language bit is set but the name is not valid UTF-8",
            },
          ],
        }),
      ).rejected[0]?.reason,
    ).toBe("invalid_encoding");
    expect(() => parseCorpusIntakeBatch(batchBody({ extra: 1 }))).toThrow(/unknown key/);
  });

  it("keeps historical v1 reports parseable when encoding status was not recorded", () => {
    const historicalReport = reportBody();
    delete (historicalReport.accepted as Array<Record<string, unknown>>)[0]?.encodingStatus;
    expect(parseCorpusIntakePreviewReport(historicalReport).accepted[0]?.encodingStatus).toBeUndefined();

    const historicalBatch = batchBody();
    delete (historicalBatch.items as Array<Record<string, unknown>>)[0]?.encodingStatus;
    expect(parseCorpusIntakeBatch(historicalBatch).items[0]?.encodingStatus).toBeUndefined();
  });

  it("matches the JSON Schemas", () => {
    const ajv = new (Ajv2020 as new (opts: object) => { compile: (schema: object) => (data: unknown) => boolean })({
      strict: true,
      allErrors: true,
    });
    (addFormats as (instance: unknown) => void)(ajv);
    const preview = ajv.compile(loadSchema("corpus-intake-preview.v1.json"));
    const commit = ajv.compile(loadSchema("corpus-intake-commit.v1.json"));
    const report = ajv.compile(loadSchema("corpus-intake-report.v1.json"));
    const batch = ajv.compile(loadSchema("corpus-intake-batch.v1.json"));
    expect(preview(previewBody())).toBe(true);
    expect(commit(commitBody())).toBe(true);
    expect(report(reportBody())).toBe(true);
    expect(batch(batchBody())).toBe(true);
    expect(preview(previewBody({ extra: true }))).toBe(false);
  });
});
