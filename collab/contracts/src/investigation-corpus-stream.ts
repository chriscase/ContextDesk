/**
 * Streamed corpus-intake session contract.
 *
 * The inline lane (`investigation-corpus-intake.ts`) carries a whole selection
 * as base64 inside one JSON body, which bounds it to what a runtime can turn
 * into a string. This contract describes the lane that carries a large corpus
 * instead: a preflight that states what will be checked before a byte moves, a
 * sequence of bounded binary parts that can be resumed after an interruption,
 * a server-side expansion whose progress is observable, and a commit that is
 * idempotent under retry.
 *
 * Pure JSON. No I/O. Deny-unknown via checkObject.
 */
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import {
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_ORIGINS,
  type CorpusIntakeLimitsV1,
  type CorpusIntakeOrigin,
} from "./investigation-corpus-intake.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const CORPUS_STREAM_PREFLIGHT_SCHEMA_ID =
  "cd-collab.corpus_intake_preflight.v1" as const;
export const CORPUS_STREAM_SESSION_SCHEMA_ID =
  "cd-collab.corpus_intake_session.v1" as const;
export const CORPUS_STREAM_COMMIT_SCHEMA_ID =
  "cd-collab.corpus_intake_session_commit.v1" as const;
export const CORPUS_INTAKE_ERROR_SCHEMA_ID =
  "cd-collab.corpus_intake_error.v1" as const;

/**
 * Every way an intake can refuse work, named for the thing the reader has to
 * change. A generic failure is not in this list on purpose: an operator who
 * cannot tell "your archive is 900 MiB" from "your archive has a `..` member"
 * cannot act on either.
 */
export const CORPUS_INTAKE_ERROR_CODES = [
  "request_too_large",
  "compressed_budget_exceeded",
  "expanded_budget_exceeded",
  "file_count_exceeded",
  "per_file_bytes_exceeded",
  "path_too_long",
  "path_depth_exceeded",
  "archive_depth_exceeded",
  "unsupported_encoding",
  "unsafe_archive_path",
  "archive_ratio_exceeded",
  "unsupported_archive_feature",
  "malformed_archive",
  "duplicate_path",
  "link_or_special_file",
  "privacy_gate_rejected",
  "session_not_found",
  "session_expired",
  "session_cancelled",
  "session_state_invalid",
  "part_offset_conflict",
  "part_bytes_conflict",
  "part_incomplete",
  "preflight_mismatch",
  "idempotency_conflict",
  "expansion_timeout",
  "storage_unavailable",
] as const;
export type CorpusIntakeErrorCode = (typeof CORPUS_INTAKE_ERROR_CODES)[number];

/** Validation work an intake performs, in the order a reader will see it. */
export const CORPUS_INTAKE_STAGES = [
  "preflight",
  "upload",
  "archive_index",
  "expand",
  "classify",
  "privacy_scan",
  "stage_evidence",
  "commit",
] as const;
export type CorpusIntakeStage = (typeof CORPUS_INTAKE_STAGES)[number];

/**
 * Facts a preflight genuinely cannot know yet. Naming them is the difference
 * between an honest estimate and a fabricated one: an archive's expanded size
 * is not knowable from the browser's file picker, and claiming otherwise turns
 * a progress bar into a guess.
 */
export const CORPUS_INTAKE_UNKNOWNS = [
  "expanded_bytes",
  "member_count",
  "member_paths",
  "member_encodings",
  "duplicate_digests",
] as const;
export type CorpusIntakeUnknown = (typeof CORPUS_INTAKE_UNKNOWNS)[number];

export const CORPUS_INTAKE_SESSION_STATES = [
  "awaiting_bytes",
  "expanding",
  "previewed",
  "committed",
  "cancelled",
  "failed",
] as const;
export type CorpusIntakeSessionState = (typeof CORPUS_INTAKE_SESSION_STATES)[number];

export interface CorpusIntakeErrorV1 {
  schemaId: typeof CORPUS_INTAKE_ERROR_SCHEMA_ID;
  code: CorpusIntakeErrorCode;
  /** Wire-only echo of `code`, for clients written against `{ error }`. */
  error?: string;
  /** One sentence a non-specialist can act on. */
  message: string;
  /** Technical detail; safe to show, never a stack or a path outside intake. */
  detail: string;
  /** The configured limit that was exceeded, when the code names one. */
  limit: number | null;
  /** What was actually observed, when it is knowable. */
  observed: number | null;
  /** Member path this refers to, when it is a per-member refusal. */
  path: string | null;
  /** True when repeating the same request unchanged could succeed. */
  retryable: boolean;
}

export interface CorpusIntakePartDeclarationV1 {
  index: number;
  relativePath: string;
  declaredBytes: number;
  declaredMediaType: string;
}

export interface CorpusIntakePartStatusV1 extends CorpusIntakePartDeclarationV1 {
  receivedBytes: number;
  complete: boolean;
  /** SHA-256 of the received bytes once the part is complete. */
  digest: string | null;
}

export interface CorpusIntakeProgressV1 {
  stage: CorpusIntakeStage;
  /**
   * False when the total is not knowable yet — an archive before its index is
   * read. A determinate bar drawn from an unknown total is a lie the operator
   * cannot detect.
   */
  determinate: boolean;
  uploadedBytes: number;
  declaredBytes: number | null;
  expandedBytes: number;
  expectedExpandedBytes: number | null;
  filesSeen: number;
  filesAccepted: number;
  filesRejected: number;
  updatedAt: string;
}

export interface CorpusIntakeSelectionV1 {
  partCount: number;
  /** Bytes the client declared it will send. */
  declaredBytes: number;
  /** Compressed bytes for an archive origin; null for loose files. */
  compressedBytes: number | null;
  /** Known only after an archive index is read; null while unknown. */
  expandedBytes: number | null;
}

export interface CorpusIntakeSessionV1 {
  schemaId: typeof CORPUS_STREAM_SESSION_SCHEMA_ID;
  sessionId: string;
  caseId: string;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  state: CorpusIntakeSessionState;
  createdAt: string;
  expiresAt: string;
  limits: CorpusIntakeLimitsV1;
  selection: CorpusIntakeSelectionV1;
  stages: CorpusIntakeStage[];
  unknowns: CorpusIntakeUnknown[];
  parts: CorpusIntakePartStatusV1[];
  progress: CorpusIntakeProgressV1;
  previewToken: string | null;
  batchId: string | null;
  /** Set when the session failed; null otherwise. */
  failure: CorpusIntakeErrorV1 | null;
}

export interface CorpusIntakePreflightRequestV1 {
  schemaId: typeof CORPUS_STREAM_PREFLIGHT_SCHEMA_ID;
  origin: CorpusIntakeOrigin;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  parts: CorpusIntakePartDeclarationV1[];
}

export interface CorpusIntakeSessionCommitRequestV1 {
  schemaId: typeof CORPUS_STREAM_COMMIT_SCHEMA_ID;
  previewToken: string;
  idempotencyKey: string;
}

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_INTAKE_ERROR_SCHEMA_ID)),
  /**
   * The code echoed as a bare string. Present on the wire so a client written
   * against the original `{ error }` intake responses keeps working; absent
   * from a stored or forwarded error, where the code alone is the contract.
   */
  error: f.opt(f.str),
  code: f.req(f.en(...CORPUS_INTAKE_ERROR_CODES)),
  message: f.req(f.nstr),
  detail: f.req(f.str),
  limit: f.nul(f.u64),
  observed: f.nul(f.u64),
  path: f.nul(f.str),
  retryable: f.req(f.bool),
};

const partDeclarationShape: ObjectShape = {
  index: f.req(f.u64),
  relativePath: f.req(f.nstr),
  declaredBytes: f.req(f.u64),
  declaredMediaType: f.req(f.str),
};

const partStatusShape: ObjectShape = {
  ...partDeclarationShape,
  receivedBytes: f.req(f.u64),
  complete: f.req(f.bool),
  digest: f.nul(f.str),
};

const progressShape: ObjectShape = {
  stage: f.req(f.en(...CORPUS_INTAKE_STAGES)),
  determinate: f.req(f.bool),
  uploadedBytes: f.req(f.u64),
  declaredBytes: f.nul(f.u64),
  expandedBytes: f.req(f.u64),
  expectedExpandedBytes: f.nul(f.u64),
  filesSeen: f.req(f.u64),
  filesAccepted: f.req(f.u64),
  filesRejected: f.req(f.u64),
  updatedAt: f.req(f.nstr),
};

const selectionShape: ObjectShape = {
  partCount: f.req(f.u64),
  declaredBytes: f.req(f.u64),
  compressedBytes: f.nul(f.u64),
  expandedBytes: f.nul(f.u64),
};

const preflightRequestShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_STREAM_PREFLIGHT_SCHEMA_ID)),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.nstr),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.nstr),
  parts: f.req(f.arr(f.obj(partDeclarationShape))),
};

const sessionCommitShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_STREAM_COMMIT_SCHEMA_ID)),
  previewToken: f.req(f.nstr),
  idempotencyKey: f.req(f.nstr),
};

export function corpusIntakeError(
  code: CorpusIntakeErrorCode,
  message: string,
  extra: Partial<Omit<CorpusIntakeErrorV1, "schemaId" | "code" | "message">> = {},
): CorpusIntakeErrorV1 {
  return {
    schemaId: CORPUS_INTAKE_ERROR_SCHEMA_ID,
    code,
    message,
    detail: extra.detail ?? message,
    limit: extra.limit ?? null,
    observed: extra.observed ?? null,
    path: extra.path ?? null,
    retryable: extra.retryable ?? false,
  };
}

export function parseCorpusIntakeError(raw: unknown): CorpusIntakeErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as CorpusIntakeErrorV1;
}

function requireKey(path: string, value: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(value)) {
    throw new ContractViolation(path, "idempotency key is not a bounded token");
  }
}

/**
 * A preflight is refused on the manifest alone, before any content byte is
 * accepted. Every ceiling checked here is checked again while bytes arrive and
 * again while they expand — a client-declared size is a claim, not a fact.
 */
export function parseCorpusIntakePreflightRequest(
  raw: unknown,
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): CorpusIntakePreflightRequestV1 {
  checkObject("$", preflightRequestShape, raw);
  const body = raw as CorpusIntakePreflightRequestV1;
  requireKey("$.idempotencyKey", body.idempotencyKey);
  if (body.sourceLabel.length > limits.maxPathLength) {
    throw new ContractViolation("$.sourceLabel", "is too long");
  }
  if (body.parts.length === 0) {
    throw new ContractViolation("$.parts", "at least one part is required");
  }
  if (body.origin === "zip" && body.parts.length !== 1) {
    throw new ContractViolation("$.parts", "a zip session carries exactly one archive part");
  }
  if (body.parts.length > limits.maxFileCount) {
    throw new ContractViolation("$.parts", "file_count_exceeded: part count exceeds cap");
  }
  const seen = new Set<number>();
  let declaredTotal = 0;
  for (const [position, part] of body.parts.entries()) {
    if (part.index !== position) {
      throw new ContractViolation(`$.parts[${position}].index`, "parts must be densely indexed from 0");
    }
    if (seen.has(part.index)) {
      throw new ContractViolation(`$.parts[${position}].index`, "duplicate_path: duplicate part index");
    }
    seen.add(part.index);
    if (part.relativePath.length > limits.maxPathLength) {
      throw new ContractViolation(`$.parts[${position}].relativePath`, "path_too_long");
    }
    if (part.declaredMediaType.length > 128) {
      throw new ContractViolation(`$.parts[${position}].declaredMediaType`, "is too long");
    }
    const perPartCap = body.origin === "zip" ? limits.maxArchiveBytes : limits.maxFileBytes;
    if (part.declaredBytes > perPartCap) {
      throw new ContractViolation(
        `$.parts[${position}].declaredBytes`,
        body.origin === "zip"
          ? "compressed_budget_exceeded: archive exceeds the compressed cap"
          : "per_file_bytes_exceeded: file exceeds the per-file cap",
      );
    }
    declaredTotal += part.declaredBytes;
    // Loose parts are the corpus, so their declared total is an expanded-byte
    // claim. An archive's declared total is compressed bytes; its expansion is
    // unknown until the index is read and is checked there instead.
    if (body.origin !== "zip" && declaredTotal > limits.maxExpandedBytes) {
      throw new ContractViolation(
        `$.parts[${position}].declaredBytes`,
        "expanded_budget_exceeded: declared selection exceeds the expanded cap",
      );
    }
  }
  return body;
}

export function parseCorpusIntakeSessionCommitRequest(
  raw: unknown,
): CorpusIntakeSessionCommitRequestV1 {
  checkObject("$", sessionCommitShape, raw);
  const body = raw as CorpusIntakeSessionCommitRequestV1;
  requireKey("$.idempotencyKey", body.idempotencyKey);
  if (!/^[a-f0-9]{64}$/.test(body.previewToken)) {
    throw new ContractViolation("$.previewToken", "must be a lowercase SHA-256 digest");
  }
  return body;
}

export function parseCorpusIntakeSession(raw: unknown): CorpusIntakeSessionV1 {
  checkObject("$", sessionShape, raw);
  const body = raw as CorpusIntakeSessionV1;
  if (body.parts.length !== body.selection.partCount) {
    throw new ContractViolation("$.selection.partCount", "does not match the part list");
  }
  for (const [position, part] of body.parts.entries()) {
    if (part.receivedBytes > part.declaredBytes) {
      throw new ContractViolation(
        `$.parts[${position}].receivedBytes`,
        "cannot exceed the declared size",
      );
    }
    if (part.complete && part.receivedBytes !== part.declaredBytes) {
      throw new ContractViolation(
        `$.parts[${position}].complete`,
        "a complete part has received every declared byte",
      );
    }
  }
  if (body.progress.determinate && body.progress.declaredBytes === null) {
    throw new ContractViolation(
      "$.progress.determinate",
      "determinate progress requires a known total",
    );
  }
  return body;
}

const sessionShape: ObjectShape = {
  schemaId: f.req(f.en(CORPUS_STREAM_SESSION_SCHEMA_ID)),
  sessionId: f.req(f.nstr),
  caseId: f.req(f.nstr),
  origin: f.req(f.en(...CORPUS_INTAKE_ORIGINS)),
  sourceLabel: f.req(f.nstr),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.nstr),
  state: f.req(f.en(...CORPUS_INTAKE_SESSION_STATES)),
  createdAt: f.req(f.nstr),
  expiresAt: f.req(f.nstr),
  limits: f.req(f.obj({
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
    supportedEncodings: f.req(f.arr(f.str)),
  })),
  selection: f.req(f.obj(selectionShape)),
  stages: f.req(f.arr(f.en(...CORPUS_INTAKE_STAGES))),
  unknowns: f.req(f.arr(f.en(...CORPUS_INTAKE_UNKNOWNS))),
  parts: f.req(f.arr(f.obj(partStatusShape))),
  progress: f.req(f.obj(progressShape)),
  previewToken: f.nul(f.str),
  batchId: f.nul(f.str),
  failure: f.nul(f.obj(errorShape)),
};

/**
 * Stages a session will run, given its origin. Shown before any byte moves so
 * the operator knows what the wait is buying.
 */
export function corpusIntakeStagesFor(origin: CorpusIntakeOrigin): CorpusIntakeStage[] {
  const archive: CorpusIntakeStage[] = origin === "zip" ? ["archive_index", "expand"] : [];
  return [
    "preflight",
    "upload",
    ...archive,
    "classify",
    "privacy_scan",
    "stage_evidence",
    "commit",
  ];
}

/** What a preflight honestly cannot know yet, given its origin. */
export function corpusIntakeUnknownsFor(origin: CorpusIntakeOrigin): CorpusIntakeUnknown[] {
  if (origin === "zip") {
    return ["expanded_bytes", "member_count", "member_paths", "member_encodings", "duplicate_digests"];
  }
  return ["member_encodings", "duplicate_digests"];
}
