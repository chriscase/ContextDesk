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
  "unsupported_encoding",
  "line_too_long",
  "structured_too_large",
  "archive_depth_exceeded",
  "unsafe_archive_path",
] as const;
export type CorpusRejectionReason = (typeof CORPUS_REJECTION_REASONS)[number];

/**
 * Longest string V8 can materialize on 64-bit builds (`String::kMaxLength`,
 * 2**29 - 24 as of V8 12.x / Node 22). Every JSON transport ceiling this
 * contract advertises must stay strictly below it: a body larger than this
 * cannot be turned into a string at all, so a limit above it is a promise the
 * runtime can never keep. See `corpusIntakeJsonBodyLimitBytes`.
 */
export const V8_MAX_STRING_LENGTH = 536_870_888;

export const CORPUS_TEXT_ENCODINGS = [
  "utf-8",
  "us-ascii",
  "utf-8-lossy",
  "utf-16le",
  "utf-16be",
] as const;
export type CorpusTextEncoding = (typeof CORPUS_TEXT_ENCODINGS)[number];

export interface CorpusIntakeLimitsV1 {
  /**
   * Hard ceiling on a single intake HTTP request body — the inline JSON
   * envelope or one streamed binary chunk. This is the only number the
   * transport layer enforces, and it is what keeps every larger allowance
   * below executable end to end: a corpus larger than this is carried by many
   * bounded requests, never one unmaterializable body.
   */
  maxRequestBytes: number;
  /** Compressed bytes accepted for one archive. */
  maxArchiveBytes: number;
  /** Total expanded bytes accepted for one intake. */
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxFileCount: number;
  /** Directory nesting depth inside a normalized member path. */
  maxPathDepth: number;
  /** Archive-inside-archive depth. 0 rejects every nested archive. */
  maxArchiveDepth: number;
  maxPathLength: number;
  maxFileBytes: number;
  /** Wall clock for the inline lane, which expands inside one request. */
  maxProcessingMs: number;
  /** Wall clock for a streamed session expansion. */
  maxExpansionMs: number;
  /** Longest single line a line-oriented member may contain. */
  maxLineBytes: number;
  /**
   * Largest member whose whole text is materialized for structured validation
   * (JSON documents, share-safe scanning). Members above it are refused with a
   * specific reason rather than silently accepted unvalidated, because whole
   * text is what bounds peak resident memory.
   */
  maxStructuredParseBytes: number;
  /** Text encodings an owner accepts; anything else is `unsupported_encoding`. */
  supportedEncodings: readonly CorpusTextEncoding[];
}

/**
 * Conservative defaults. Every one of these is enforced somewhere executable:
 * see `corpus-intake/limits.ts` (numeric gates), `zip-walk.ts` (archive gates),
 * and `classify-stream.ts` (per-member gates).
 */
export const CORPUS_INTAKE_LIMITS: CorpusIntakeLimitsV1 = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 256,
  maxFileCount: 4_096,
  maxPathDepth: 8,
  maxArchiveDepth: 0,
  maxPathLength: 240,
  maxFileBytes: 64 * 1024 * 1024,
  maxProcessingMs: 60_000,
  maxExpansionMs: 600_000,
  maxLineBytes: 8 * 1024 * 1024,
  maxStructuredParseBytes: 16 * 1024 * 1024,
  supportedEncodings: ["utf-8", "us-ascii", "utf-8-lossy"],
};

/**
 * Hard ceilings an owner-local override may not exceed. These are not taste:
 * each one keeps a promise the runtime can actually execute — request bytes
 * stay materializable, per-file bytes stay decodable, and archive depth stays
 * finite.
 */
export const CORPUS_INTAKE_LIMIT_CEILINGS = {
  maxRequestBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxExpandedBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 4_096,
  maxFileCount: 100_000,
  maxPathDepth: 64,
  maxArchiveDepth: 2,
  maxPathLength: 1_024,
  maxFileBytes: 128 * 1024 * 1024,
  maxProcessingMs: 600_000,
  maxExpansionMs: 3_600_000,
  maxLineBytes: 64 * 1024 * 1024,
  maxStructuredParseBytes: 128 * 1024 * 1024,
} as const;

const NUMERIC_LIMIT_KEYS = Object.keys(
  CORPUS_INTAKE_LIMIT_CEILINGS,
) as Array<keyof typeof CORPUS_INTAKE_LIMIT_CEILINGS>;

export function base64LengthForBytes(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Executable Fastify `bodyLimit` for the inline JSON lane.
 *
 * Fastify hands the JSON parser a string, so this ceiling is bounded by what
 * V8 can materialize, not by what the intake budget allows. It is derived from
 * `maxRequestBytes` alone — the total expanded allowance is carried by the
 * streamed session lane, one bounded request at a time.
 */
export function corpusIntakeJsonBodyLimitBytes(
  limits: Pick<CorpusIntakeLimitsV1, "maxRequestBytes">,
): number {
  return limits.maxRequestBytes;
}

/**
 * Largest decoded payload the inline lane can carry, after base64 expansion
 * and a fixed allowance for the JSON envelope around it. Selections above this
 * belong to the streamed session lane.
 */
export function corpusIntakeInlineDecodedBytes(
  limits: Pick<CorpusIntakeLimitsV1, "maxRequestBytes">,
): number {
  const envelope = 64 * 1024;
  return Math.max(0, Math.floor(((limits.maxRequestBytes - envelope) / 4) * 3));
}

/**
 * Peak resident bytes one intake may hold, independent of corpus size.
 *
 * Transport never buffers more than one request; expansion never holds more
 * than one window plus one line; structured validation is the only whole-text
 * step and is itself capped. A JS string costs up to two bytes per source
 * byte, which is why the structured term is doubled.
 */
export function corpusIntakePeakResidentBytes(limits: CorpusIntakeLimitsV1): number {
  return limits.maxRequestBytes
    + limits.maxLineBytes
    + limits.maxStructuredParseBytes * 2
    + CORPUS_INTAKE_EXPANSION_WINDOW_BYTES * 4;
}

/** Window the streamed expander reads with; fixed so the bound is inspectable. */
export const CORPUS_INTAKE_EXPANSION_WINDOW_BYTES = 256 * 1024;

/**
 * Transport ceiling for the inline lane. Named for its historical consumers;
 * the value is now the executable per-request limit rather than a derived
 * whole-corpus figure that no runtime could materialize.
 */
export const CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES =
  corpusIntakeJsonBodyLimitBytes(CORPUS_INTAKE_LIMITS);

if (CORPUS_INTAKE_HTTP_BODY_LIMIT_BYTES >= V8_MAX_STRING_LENGTH) {
  throw new Error(
    "corpus intake advertises a JSON body limit larger than V8 can materialize",
  );
}

export class CorpusIntakeLimitError extends Error {
  constructor(
    readonly key: string,
    readonly detail: string,
  ) {
    super(`corpus intake limit ${key} ${detail}`);
    this.name = "CorpusIntakeLimitError";
  }
}

/**
 * Apply an owner-local override on top of the conservative defaults.
 *
 * Overrides are clamped by nothing and validated by everything: an out-of-range
 * value is refused with the key that caused it, so a deployment cannot quietly
 * advertise a limit the runtime will not honour.
 */
export function resolveCorpusIntakeLimits(
  overrides: Partial<CorpusIntakeLimitsV1> = {},
): CorpusIntakeLimitsV1 {
  const merged: CorpusIntakeLimitsV1 = { ...CORPUS_INTAKE_LIMITS, ...overrides };
  for (const key of NUMERIC_LIMIT_KEYS) {
    const value = merged[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new CorpusIntakeLimitError(key, "must be a safe integer");
    }
    const floor = key === "maxArchiveDepth" ? 0 : 1;
    if (value < floor) {
      throw new CorpusIntakeLimitError(key, `must be at least ${floor}`);
    }
    if (value > CORPUS_INTAKE_LIMIT_CEILINGS[key]) {
      throw new CorpusIntakeLimitError(
        key,
        `exceeds the ceiling ${CORPUS_INTAKE_LIMIT_CEILINGS[key]}`,
      );
    }
  }
  if (merged.maxFileBytes > merged.maxExpandedBytes) {
    throw new CorpusIntakeLimitError(
      "maxFileBytes",
      "cannot exceed maxExpandedBytes",
    );
  }
  if (merged.maxStructuredParseBytes > merged.maxFileBytes) {
    throw new CorpusIntakeLimitError(
      "maxStructuredParseBytes",
      "cannot exceed maxFileBytes",
    );
  }
  if (merged.maxLineBytes > merged.maxFileBytes) {
    throw new CorpusIntakeLimitError("maxLineBytes", "cannot exceed maxFileBytes");
  }
  if (corpusIntakeJsonBodyLimitBytes(merged) >= V8_MAX_STRING_LENGTH) {
    throw new CorpusIntakeLimitError(
      "maxRequestBytes",
      "would advertise a JSON body larger than V8 can materialize",
    );
  }
  const encodings = merged.supportedEncodings;
  if (!Array.isArray(encodings) || encodings.length === 0) {
    throw new CorpusIntakeLimitError("supportedEncodings", "must list at least one encoding");
  }
  for (const encoding of encodings) {
    if (!(CORPUS_TEXT_ENCODINGS as readonly string[]).includes(encoding)) {
      throw new CorpusIntakeLimitError("supportedEncodings", `does not know ${encoding}`);
    }
  }
  if (!encodings.includes("utf-8")) {
    throw new CorpusIntakeLimitError("supportedEncodings", "must include utf-8");
  }
  return { ...merged, supportedEncodings: [...new Set(encodings)] };
}

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
  limits: CorpusIntakeLimitsV1;
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

function requireNonEmpty(
  path: string,
  value: string,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): string {
  if (!value.trim()) throw new ContractViolation(path, "must not be empty");
  if (value.length > limits.maxPathLength) {
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

/**
 * The inline lane carries base64 inside one JSON request, so its ceiling is
 * `maxRequestBytes`, not the whole-corpus allowance. A selection larger than
 * this belongs to the streamed session lane; refusing it here — before any
 * decode — is what makes `request_too_large` truthful instead of a body the
 * server accepts and then cannot turn into a string.
 */
function assertOriginRepresentation(
  body: Pick<CorpusIntakePreviewRequestV1, "origin" | "files" | "archiveBase64">,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): void {
  const inlineDecodedCap = Math.min(
    corpusIntakeInlineDecodedBytes(limits),
    limits.maxExpandedBytes,
  );
  const inlineEncodedCap = base64LengthForBytes(inlineDecodedCap);
  if (body.origin === "zip") {
    if (!body.archiveBase64) {
      throw new ContractViolation("$.archiveBase64", "zip origin requires archiveBase64");
    }
    if (body.files.length !== 0) {
      throw new ContractViolation("$.files", "zip origin does not accept direct files");
    }
    if (body.archiveBase64.length > Math.min(
      inlineEncodedCap,
      base64LengthForBytes(limits.maxArchiveBytes),
    )) {
      throw new ContractViolation(
        "$.archiveBase64",
        "request_too_large: use the streamed intake session for archives above the inline request limit",
      );
    }
    return;
  }
  if (body.archiveBase64 !== null) {
    throw new ContractViolation("$.archiveBase64", "non-zip origin requires a null archive");
  }
  if (body.files.length === 0) {
    throw new ContractViolation("$.files", "at least one file is required");
  }
  if (body.files.length > limits.maxFileCount) {
    throw new ContractViolation("$.files", "file_count_exceeded: file count exceeds cap");
  }
  let encodedTotal = 0;
  for (const [index, file] of body.files.entries()) {
    if (file.relativePath.length > limits.maxPathLength) {
      throw new ContractViolation(`$.files[${index}].relativePath`, "is too long");
    }
    if (file.mediaType.length > 128) {
      throw new ContractViolation(`$.files[${index}].mediaType`, "is too long");
    }
    if (file.contentBase64.length > base64LengthForBytes(limits.maxFileBytes)) {
      throw new ContractViolation(
        `$.files[${index}].contentBase64`,
        "per_file_bytes_exceeded: encoded file exceeds cap",
      );
    }
    encodedTotal += file.contentBase64.length;
    if (encodedTotal > inlineEncodedCap) {
      throw new ContractViolation(
        `$.files[${index}].contentBase64`,
        "request_too_large: use the streamed intake session for selections above the inline request limit",
      );
    }
  }
}

export function parseCorpusIntakePreviewRequest(
  raw: unknown,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): CorpusIntakePreviewRequestV1 {
  checkObject("$", previewRequestShape, raw);
  const body = raw as CorpusIntakePreviewRequestV1;
  requireNonEmpty("$.sourceLabel", body.sourceLabel, limits);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  assertOriginRepresentation(body, limits);
  return body;
}

export function parseCorpusIntakeCommitRequest(
  raw: unknown,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): CorpusIntakeCommitRequestV1 {
  checkObject("$", commitRequestShape, raw);
  const body = raw as CorpusIntakeCommitRequestV1;
  requireNonEmpty("$.sourceLabel", body.sourceLabel, limits);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  requireDigest("$.previewToken", body.previewToken);
  assertOriginRepresentation(body, limits);
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
  maxRequestBytes: f.req(f.u64),
  maxArchiveBytes: f.req(f.u64),
  maxExpandedBytes: f.req(f.u64),
  maxCompressionRatio: f.req(f.u64),
  maxFileCount: f.req(f.u64),
  maxPathDepth: f.req(f.u64),
  maxArchiveDepth: f.req(f.u64),
  maxPathLength: f.req(f.u64),
  maxFileBytes: f.req(f.u64),
  maxProcessingMs: f.req(f.u64),
  maxExpansionMs: f.req(f.u64),
  maxLineBytes: f.req(f.u64),
  maxStructuredParseBytes: f.req(f.u64),
  supportedEncodings: f.req(f.arr(f.en(...CORPUS_TEXT_ENCODINGS))),
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

/**
 * A report advertises the limits its server actually enforced, which an owner
 * may have narrowed or widened locally. Equality with the built-in defaults
 * would make any override unreadable, so validate that the advertised set is a
 * configuration this contract would itself resolve.
 */
function assertResolvableLimits(path: string, limits: CorpusIntakeLimitsV1): void {
  try {
    resolveCorpusIntakeLimits(limits);
  } catch (error) {
    const key = error instanceof CorpusIntakeLimitError ? error.key : "limits";
    const detail = error instanceof CorpusIntakeLimitError ? error.detail : "is not resolvable";
    throw new ContractViolation(`${path}.${key}`, detail);
  }
}

export function parseCorpusIntakePreviewReport(raw: unknown): CorpusIntakePreviewReportV1 {
  checkObject("$", previewReportShape, raw);
  const body = raw as CorpusIntakePreviewReportV1;
  requireDigest("$.previewToken", body.previewToken);
  assertResolvableLimits("$.limits", body.limits);
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
