/**
 * Bounded investigation-scoped corpus intake contract (files, ZIP, directory).
 * Pure JSON. No I/O. Deny-unknown via checkObject.
 */
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifact.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const CORPUS_INTAKE_PREVIEW_SCHEMA_ID =
  "cd-collab.corpus_intake_preview.v1" as const;
export const CORPUS_INTAKE_COMMIT_SCHEMA_ID =
  "cd-collab.corpus_intake_commit.v1" as const;
export const CORPUS_INTAKE_BATCH_SCHEMA_ID =
  "cd-collab.corpus_intake_batch.v1" as const;
export const CORPUS_INTAKE_REPORT_SCHEMA_ID =
  "cd-collab.corpus_intake_report.v1" as const;

export const CORPUS_INTAKE_ORIGINS = ["files", "zip", "directory"] as const;
export type CorpusIntakeOrigin = (typeof CORPUS_INTAKE_ORIGINS)[number];

export const CORPUS_REJECTION_REASONS = [
  "absolute_path",
  "path_traversal",
  "drive_or_unc_path",
  "symlink_or_hardlink",
  "device_entry",
  "duplicate_normalized_path",
  "nested_archive",
  "encrypted_archive",
  "malformed_zip",
  "unsupported_zip64",
  "oversized_archive",
  "oversized_expanded",
  "extreme_ratio",
  "too_many_files",
  "path_too_deep",
  "path_too_long",
  "file_too_large",
  "processing_timeout",
  "unsupported_media",
  "binary_or_unknown",
  "redaction_failed",
  "empty_path",
  "nul_in_path",
  "invalid_encoding",
] as const;
export type CorpusRejectionReason = (typeof CORPUS_REJECTION_REASONS)[number];

export const CORPUS_INTAKE_LIMITS = {
  // Keep the archive and per-file ceilings aligned with the total expanded
  // budget so realistic support bundles are not rejected before their
  // bounded contents can be reviewed. The aggregate, count, ratio, path,
  // and processing-time limits remain authoritative safeguards.
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 256,
  maxFileCount: 4_096,
  maxArchiveDepth: 3,
  maxPathDepth: 8,
  maxPathLength: 240,
  maxFileBytes: 512 * 1024 * 1024,
  maxProcessingMs: 60_000,
} as const;

export function base64LengthForBytes(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Fastify receives intake as JSON with base64 payloads. This transport ceiling
 * admits the full expanded-byte allowance plus worst-case escaped paths and
 * bounded per-entry JSON metadata; semantic intake limits still reject excess.
 */
export const CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES =
  base64LengthForBytes(CORPUS_INTAKE_LIMITS.maxExpandedBytes)
  + CORPUS_INTAKE_LIMITS.maxFileCount * (
    CORPUS_INTAKE_LIMITS.maxPathLength * 6
    + 512
  )
  + 4_096;

export const CORPUS_ALLOWED_MEDIA = [
  "text/plain",
  "text/x-log",
  "text/csv",
  "text/markdown",
  "text/xml",
  "application/json",
  "application/xml",
  "message/rfc822",
] as const;
export type CorpusAllowedMedia = (typeof CORPUS_ALLOWED_MEDIA)[number];

export const CORPUS_TEXT_ENCODING_STATUSES = ["utf8", "normalized_non_utf8"] as const;
export type CorpusTextEncodingStatus = (typeof CORPUS_TEXT_ENCODING_STATUSES)[number];

export const CORPUS_ALLOWED_EXTENSIONS = [
  ".log",
  ".txt",
  ".json",
  ".jsonl",
  ".ndjson",
  ".csv",
  ".xml",
  ".eml",
  ".md",
] as const;
export type CorpusAllowedExtension = (typeof CORPUS_ALLOWED_EXTENSIONS)[number];

/**
 * Return the allowlisted content extension represented by a corpus path.
 * Log rotation commonly appends a generation or date after `.log` instead of
 * before it (`service.log.1`, `service.log-2026-08-25`). Byte classification
 * remains authoritative and still rejects binary or archive data.
 */
export function corpusAllowedExtension(path: string): CorpusAllowedExtension | null {
  const base = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  for (const extension of CORPUS_ALLOWED_EXTENSIONS) {
    if (base.endsWith(extension)) return extension;
  }
  if (/\.log(?:[.-](?:\d[\d._-]*|old|previous|bak))$/.test(base)) return ".log";
  return null;
}

const fileEntryShape: ObjectShape = {
  relativePath: f.req(f.str),
  mediaType: f.req(f.str),
  contentBase64: f.req(f.str),
};

const previewRequestShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_INTAKE_PREVIEW_SCHEMA_ID)),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.str),
  files: f.req(f.arr(f.obj(fileEntryShape))),
  archiveBase64: f.nul(f.str),
};

const commitRequestShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_INTAKE_COMMIT_SCHEMA_ID)),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.str),
  previewToken: f.req(f.str),
  files: f.req(f.arr(f.obj(fileEntryShape))),
  archiveBase64: f.nul(f.str),
};

export interface CorpusIntakeFileEntryV1 {
  relativePath: string;
  mediaType: string;
  contentBase64: string;
}

export interface CorpusIntakePreviewRequestV1 {
  schemaId: typeof CORPUS_INTAKE_PREVIEW_SCHEMA_ID;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  files: CorpusIntakeFileEntryV1[];
  archiveBase64: string | null;
}

export interface CorpusIntakeCommitRequestV1 {
  schemaId: typeof CORPUS_INTAKE_COMMIT_SCHEMA_ID;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  previewToken: string;
  files: CorpusIntakeFileEntryV1[];
  archiveBase64: string | null;
}

export interface CorpusRejectedFileV1 {
  relativePath: string;
  reason: CorpusRejectionReason;
  detail: string;
}

export interface CorpusAcceptedFileV1 {
  relativePath: string;
  mediaType: CorpusAllowedMedia;
  artifactKind: ArtifactKind;
  byteLength: number;
  digest: string;
  duplicateDigest: boolean;
  /** Added compatibly to v1; absent historical reports mean UTF-8 status was not recorded. */
  encodingStatus?: CorpusTextEncodingStatus;
}

export interface CorpusIntakePreviewReportV1 {
  schemaId: typeof CORPUS_INTAKE_REPORT_SCHEMA_ID;
  caseId: string;
  origin: CorpusIntakeOrigin;
  previewToken: string;
  accepted: CorpusAcceptedFileV1[];
  rejected: CorpusRejectedFileV1[];
  limits: typeof CORPUS_INTAKE_LIMITS;
}

export interface CorpusIntakeCommittedItemV1 {
  artifactId: string;
  relativePath: string;
  digest: string;
  byteLength: number;
  mediaType: string;
  privacyClass: PrivacyClass;
  sourceId: string;
  duplicateDigest: boolean;
  /** Added compatibly to v1; absent historical batches mean encoding status was not recorded. */
  encodingStatus?: CorpusTextEncodingStatus;
}

export interface CorpusIntakeBatchV1 {
  schemaId: typeof CORPUS_INTAKE_BATCH_SCHEMA_ID;
  id: string;
  caseId: string;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  requestDigest: string;
  replayed: boolean;
  createdAt: string;
  createdBy: string;
  items: CorpusIntakeCommittedItemV1[];
  rejected: CorpusRejectedFileV1[];
}

function requireNonEmpty(path: string, value: string): string {
  if (!value.trim()) throw new ContractViolation(path, "must not be empty");
  if (value.length > CORPUS_INTAKE_LIMITS.maxPathLength) {
    throw new ContractViolation(path, "is too long");
  }
  return value;
}

function requireKey(path: string, value: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(value)) {
    throw new ContractViolation(path, "idempotency key is not a bounded token");
  }
}

function requireDigest(path: string, value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ContractViolation(path, "must be a lowercase SHA-256 digest");
  }
}

function assertOriginRepresentation(
  body: Pick<CorpusIntakePreviewRequestV1, "origin" | "files" | "archiveBase64">,
): void {
  if (body.origin === "zip") {
    if (!body.archiveBase64) {
      throw new ContractViolation("$.archiveBase64", "zip origin requires archiveBase64");
    }
    if (body.files.length !== 0) {
      throw new ContractViolation("$.files", "zip origin does not accept direct files");
    }
    if (body.archiveBase64.length > base64LengthForBytes(CORPUS_INTAKE_LIMITS.maxArchiveBytes)) {
      throw new ContractViolation("$.archiveBase64", "encoded archive exceeds cap");
    }
    return;
  }
  if (body.archiveBase64 !== null) {
    throw new ContractViolation("$.archiveBase64", "non-zip origin requires a null archive");
  }
  if (body.files.length === 0) {
    throw new ContractViolation("$.files", "at least one file is required");
  }
  if (body.files.length > CORPUS_INTAKE_LIMITS.maxFileCount) {
    throw new ContractViolation("$.files", "file count exceeds cap");
  }
  for (const [index, file] of body.files.entries()) {
    if (file.relativePath.length > CORPUS_INTAKE_LIMITS.maxPathLength) {
      throw new ContractViolation(`$.files[${index}].relativePath`, "is too long");
    }
    if (file.mediaType.length > 128) {
      throw new ContractViolation(`$.files[${index}].mediaType`, "is too long");
    }
    if (file.contentBase64.length > base64LengthForBytes(CORPUS_INTAKE_LIMITS.maxFileBytes)) {
      throw new ContractViolation(`$.files[${index}].contentBase64`, "encoded file exceeds cap");
    }
  }
}

export function parseCorpusIntakePreviewRequest(raw: unknown): CorpusIntakePreviewRequestV1 {
  checkObject("$", previewRequestShape, raw);
  const body = raw as CorpusIntakePreviewRequestV1;
  requireNonEmpty("$.sourceLabel", body.sourceLabel);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  assertOriginRepresentation(body);
  return body;
}

export function parseCorpusIntakeCommitRequest(raw: unknown): CorpusIntakeCommitRequestV1 {
  checkObject("$", commitRequestShape, raw);
  const body = raw as CorpusIntakeCommitRequestV1;
  requireNonEmpty("$.sourceLabel", body.sourceLabel);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  requireDigest("$.previewToken", body.previewToken);
  assertOriginRepresentation(body);
  return body;
}

const rejectedShape: ObjectShape = {
  relativePath: f.req(f.str),
  reason: f.req(f.en(...CORPUS_REJECTION_REASONS)),
  detail: f.req(f.str),
};

const acceptedShape: ObjectShape = {
  relativePath: f.req(f.str),
  mediaType: f.req(f.en(...CORPUS_ALLOWED_MEDIA)),
  artifactKind: f.req(f.en(...ARTIFACT_KINDS)),
  byteLength: f.req(f.u64),
  digest: f.req(f.str),
  duplicateDigest: f.req(f.bool),
  encodingStatus: f.opt(f.en(...CORPUS_TEXT_ENCODING_STATUSES)),
};

const limitsShape: ObjectShape = {
  maxArchiveBytes: f.req(f.u64),
  maxExpandedBytes: f.req(f.u64),
  maxCompressionRatio: f.req(f.u64),
  maxFileCount: f.req(f.u64),
  maxArchiveDepth: f.req(f.u64),
  maxPathDepth: f.req(f.u64),
  maxPathLength: f.req(f.u64),
  maxFileBytes: f.req(f.u64),
  maxProcessingMs: f.req(f.u64),
};

const previewReportShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_INTAKE_REPORT_SCHEMA_ID)),
  caseId: f.req(f.str),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  previewToken: f.req(f.str),
  accepted: f.req(f.arr(f.obj(acceptedShape))),
  rejected: f.req(f.arr(f.obj(rejectedShape))),
  limits: f.req(f.obj(limitsShape)),
};

const committedItemShape: ObjectShape = {
  artifactId: f.req(f.str),
  relativePath: f.req(f.str),
  digest: f.req(f.str),
  byteLength: f.req(f.u64),
  mediaType: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  sourceId: f.req(f.str),
  duplicateDigest: f.req(f.bool),
  encodingStatus: f.opt(f.en(...CORPUS_TEXT_ENCODING_STATUSES)),
};

const batchShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_INTAKE_BATCH_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.str),
  requestDigest: f.req(f.str),
  replayed: f.req(f.bool),
  createdAt: f.req(f.str),
  createdBy: f.req(f.str),
  items: f.req(f.arr(f.obj(committedItemShape))),
  rejected: f.req(f.arr(f.obj(rejectedShape))),
};

export function parseCorpusIntakePreviewReport(raw: unknown): CorpusIntakePreviewReportV1 {
  checkObject("$", previewReportShape, raw);
  const body = raw as CorpusIntakePreviewReportV1;
  requireDigest("$.previewToken", body.previewToken);
  for (const key of Object.keys(CORPUS_INTAKE_LIMITS) as Array<keyof typeof CORPUS_INTAKE_LIMITS>) {
    if (body.limits[key] !== CORPUS_INTAKE_LIMITS[key]) {
      throw new ContractViolation(`$.limits.${key}`, "does not match the corpus intake contract");
    }
  }
  return body;
}

export function parseCorpusIntakeBatch(raw: unknown): CorpusIntakeBatchV1 {
  checkObject("$", batchShape, raw);
  const body = raw as CorpusIntakeBatchV1;
  requireNonEmpty("$.sourceLabel", body.sourceLabel);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  requireDigest("$.requestDigest", body.requestDigest);
  return body;
}
