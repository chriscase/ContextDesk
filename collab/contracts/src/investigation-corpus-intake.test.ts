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
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  CORPUS_INTAKE_REPORT_SCHEMA_ID,
  parseCorpusIntakeBatch,
  parseCorpusIntakeCommitRequest,
  parseCorpusIntakePreviewReport,
  parseCorpusIntakePreviewRequest,
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
    idempotencyKey: "batch-syn-0001",
    ...overrides,
  };
}

function reportBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
    caseId: "11111111-1111-4111-8111-111111111111",
    origin: "files",
    accepted: [
      {
        relativePath: "mailer/shared-timeout.log",
        mediaType: "text/x-log",
        artifactKind: "log",
        byteLength: 44,
        digest: "a".repeat(64),
        duplicateDigest: false,
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
  it("publishes the bounded limits used by preview and commit", () => {
    expect(CORPUS_INTAKE_LIMITS).toEqual({
      maxArchiveBytes: 8_388_608,
      maxExpandedBytes: 12_582_912,
      maxCompressionRatio: 20,
      maxFileCount: 64,
      maxPathDepth: 8,
      maxPathLength: 240,
      maxFileBytes: 1_000_000,
      maxProcessingMs: 5_000,
    });
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
    expect(() => parseCorpusIntakePreviewReport(reportBody({ leaked: "nope" }))).toThrow(/unknown key/);
    const batch = parseCorpusIntakeBatch(batchBody());
    expect(batch.items).toHaveLength(1);
    expect(batch.rejected[0]?.reason).toBe("unsupported_media");
    expect(() => parseCorpusIntakeBatch(batchBody({ extra: 1 }))).toThrow(/unknown key/);
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
