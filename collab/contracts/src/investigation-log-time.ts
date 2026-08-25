/**
 * Case-bound log corpus time review.
 *
 * The War Room never guesses a timezone. Zone-less local timestamps stay
 * order-only until a person explicitly declares an IANA zone for one source,
 * and every declaration carries the corpus revision and preview fingerprint it
 * was decided against. Clearing or undoing a declaration returns the affected
 * events to the order-only evidence they came in as — nothing is discarded.
 *
 * These shapes mirror `cd_core::log_analysis::timezone_resolution` and
 * `::timezone_application` exactly so the shipped desktop pipeline stays the
 * one implementation of timestamp math. Pure JSON. No I/O. Deny-unknown.
 */
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const LOG_CORPUS_STATE_SCHEMA_ID = "cd-collab.log_corpus_state.v1" as const;
export const LOG_TIME_PREVIEW_REQUEST_SCHEMA_ID =
  "cd-collab.log_time_preview_request.v1" as const;
export const LOG_TIME_PREVIEW_SCHEMA_ID = "cd-collab.log_time_preview.v1" as const;
export const LOG_TIME_APPLY_REQUEST_SCHEMA_ID =
  "cd-collab.log_time_apply_request.v1" as const;
export const LOG_TIME_CLEAR_REQUEST_SCHEMA_ID =
  "cd-collab.log_time_clear_request.v1" as const;
export const LOG_TIME_UNDO_REQUEST_SCHEMA_ID =
  "cd-collab.log_time_undo_request.v1" as const;
export const LOG_TIME_OUTCOME_SCHEMA_ID = "cd-collab.log_time_outcome.v1" as const;

/**
 * How a declaration became authoritative. Mirrors
 * `TimezoneDeclarationBasis`. The War Room only ever writes `user_declared`;
 * `configured_default` exists so a corpus imported on the desktop under a
 * saved default is never re-presented as an in-the-moment human choice.
 */
export const LOG_TIME_DECLARATION_BASES = [
  "user_declared",
  "configured_default",
] as const;
export type LogTimeDeclarationBasis = (typeof LOG_TIME_DECLARATION_BASES)[number];

/** The four review operations. `preview` never mutates a corpus. */
export const LOG_TIME_OPERATIONS = ["preview", "apply", "clear", "undo"] as const;
export type LogTimeOperation = (typeof LOG_TIME_OPERATIONS)[number];

/**
 * Why one parser-recognized local timestamp could not become a single exact
 * instant. Mirrors `UnresolvedTimestampReason` one-for-one.
 */
export const LOG_TIME_UNRESOLVED_REASONS = [
  "no_recognized_local_timestamp",
  "unsupported_local_timestamp_shape",
  "ambiguous_dst_fold",
  "nonexistent_dst_gap",
  "zone_abbreviation_mismatch",
  "resolved_instant_out_of_range",
] as const;
export type LogTimeUnresolvedReason = (typeof LOG_TIME_UNRESOLVED_REASONS)[number];

/** Per-sample outcome shown side by side with the log line it came from. */
export const LOG_TIME_SAMPLE_OUTCOMES = [
  "resolved",
  "unresolved",
  "existing_wall_clock",
] as const;
export type LogTimeSampleOutcome = (typeof LOG_TIME_SAMPLE_OUTCOMES)[number];

/**
 * What a time change did to work that was already produced.
 *
 * `unknown_basis` is deliberate: a snapshot or run that predates this corpus
 * has no recorded time basis, and the War Room says so instead of guessing
 * that it is still current.
 */
export const LOG_TIME_DEPENDENT_DISPOSITIONS = [
  "unaffected",
  "revised",
  "invalidated",
  "unknown_basis",
] as const;
export type LogTimeDependentDisposition =
  (typeof LOG_TIME_DEPENDENT_DISPOSITIONS)[number];

export const LOG_TIME_DEPENDENT_KINDS = ["snapshot", "triage_run"] as const;
export type LogTimeDependentKind = (typeof LOG_TIME_DEPENDENT_KINDS)[number];

export const LOG_TIME_LIMITS = {
  /** Bounded sample rows returned with one preview. */
  maxPreviewSamples: 24,
  /** Bounded log-line excerpt length for side-by-side context. */
  maxExcerptChars: 240,
  /** `MAX_TIMEZONE_SOURCE_BYTES` in the Rust resolver. */
  maxSourceChars: 4_096,
  /** `MAX_IANA_TIMEZONE_BYTES` in the Rust resolver. */
  maxIanaTimezoneChars: 128,
  /** Sources the review surface will enumerate for one corpus. */
  maxSources: 512,
} as const;

/**
 * A conservative IANA zone-id shape check. It rejects obvious junk before it
 * reaches the host; the authoritative answer is the Rust `Tz::from_str` parse,
 * which is the only thing allowed to declare a zone valid.
 *
 * A zone must be written `Area/Location`. Bare abbreviations are refused even
 * where a legacy IANA link exists for them, because they are exactly the trap
 * this feature is built to close: `CST` is US Central *and* China Standard,
 * `IST` is India, Ireland, and Israel. Accepting one would mean picking for the
 * reviewer. `UTC` is the single exception — it is unambiguous.
 */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+._-]+){1,2}$/;
const UNAMBIGUOUS_BARE_ZONE = "UTC";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// --------------------------------------------------------------------------
// Durable case-bound corpus state
// --------------------------------------------------------------------------

/** Retained counts for one source. Order-only evidence is never dropped. */
export interface LogTimeSourceStatusV1 {
  /** Portable source identity, relative to the corpus import root. */
  source: string;
  /** Local timestamps still carried as ingest order, awaiting a declaration. */
  unresolvedLocalRecords: number;
  /** Local timestamps an explicit declaration resolved to exact instants. */
  resolvedLocalRecords: number;
  /** Parser-proven wall-clock records a declaration never rewrites. */
  explicitWallClockRecords: number;
  /** Records with no resolvable local calendar evidence at all. */
  otherOrderOnlyRecords: number;
  /** The declaration in force for this source, or null when undeclared. */
  declaration: LogTimeDeclarationV1 | null;
}

/** A persisted declaration with its full provenance. */
export interface LogTimeDeclarationV1 {
  source: string;
  ianaTimezone: string;
  basis: LogTimeDeclarationBasis;
  /** Unix whole seconds when the person applied it. */
  declaredAt: number;
  /** Corpus event revision this declaration published. */
  appliedRevision: number;
  /** Fingerprint of the preview the person actually saw before applying. */
  declarationFingerprint: string;
  /** War Room identity that applied it. */
  declaredBy: string;
}

export interface LogCorpusStateV1 {
  schemaId: typeof LOG_CORPUS_STATE_SCHEMA_ID;
  caseId: string;
  /** Host corpus identity. Null until the case corpus has been built. */
  corpusId: string | null;
  /** Durable event revision. 0 when no corpus exists yet. */
  corpusRevision: number;
  /** ISO-8601 UTC instant the corpus was built, or null when absent. */
  builtAt: string | null;
  /** Privacy class inherited from the intake that produced the corpus. */
  privacyClass: PrivacyClass;
  /** Every source carrying local-time evidence or a saved declaration. */
  sources: LogTimeSourceStatusV1[];
  /** True while at least one source still has undeclared local timestamps. */
  reviewOutstanding: boolean;
  /** One-step undo target, or null when the corpus has never been revised. */
  undoableRevision: number | null;
}

// --------------------------------------------------------------------------
// Preview
// --------------------------------------------------------------------------

/** One log line shown with its raw and normalized timestamp side by side. */
export interface LogTimeSampleV1 {
  /** Stable ingest ordinal, so the UI can show ordering without a clock. */
  ordinal: number;
  outcome: LogTimeSampleOutcome;
  /** Exactly the text the parser recognized in the line. Never rewritten. */
  rawTimestamp: string | null;
  /** ISO-8601 UTC instant this declaration would produce, or null. */
  normalizedInstant: string | null;
  /** UTC offset the IANA rules select at this local instant, or null. */
  utcOffsetSeconds: number | null;
  /** Why this line stays order-only, when it does. */
  unresolvedReason: LogTimeUnresolvedReason | null;
  /** Bounded, already-redacted message text for side-by-side context. */
  excerpt: string;
}

export interface LogTimePreviewRequestV1 {
  schemaId: typeof LOG_TIME_PREVIEW_REQUEST_SCHEMA_ID;
  source: string;
  ianaTimezone: string;
  /** Revision the caller believes is current. Mismatch fails closed. */
  expectedRevision: number;
}

export interface LogTimePreviewV1 {
  schemaId: typeof LOG_TIME_PREVIEW_SCHEMA_ID;
  caseId: string;
  corpusId: string;
  /** Revision this preview was computed against. */
  corpusRevision: number;
  /** Binding the apply step recomputes and must match exactly. */
  declarationFingerprint: string;
  source: string;
  ianaTimezone: string;
  /** Records that would gain an exact instant. */
  affectedRecords: number;
  /** Wall-clock records that stay authoritative and untouched. */
  existingWallClockRecords: number;
  /** Records that stay order-only. Preserved, never dropped. */
  unchangedOrderOnlyRecords: number;
  /** ISO-8601 UTC first resolved instant, or null. */
  firstResolvedInstant: string | null;
  /** ISO-8601 UTC last resolved instant, or null. */
  lastResolvedInstant: string | null;
  /** Local times that do not exist because clocks moved forward. */
  dstGapCount: number;
  /** Local times that happen twice because clocks moved back. */
  dstFoldCount: number;
  /** Recognized prefixes too imprecise to place on a calendar. */
  unsupportedTimestampCount: number;
  /** Lines whose own zone abbreviation contradicts the declared zone. */
  zoneAbbreviationMismatchCount: number;
  /** Instants outside the event store's supported range. */
  outOfRangeCount: number;
  /** Bounded evidence rows backing the numbers above. */
  samples: LogTimeSampleV1[];
}

// --------------------------------------------------------------------------
// Apply / clear / undo
// --------------------------------------------------------------------------

export interface LogTimeApplyRequestV1 {
  schemaId: typeof LOG_TIME_APPLY_REQUEST_SCHEMA_ID;
  source: string;
  ianaTimezone: string;
  expectedRevision: number;
  /** Fingerprint of the preview the person saw. Recomputed before writing. */
  declarationFingerprint: string;
  idempotencyKey: string;
}

export interface LogTimeClearRequestV1 {
  schemaId: typeof LOG_TIME_CLEAR_REQUEST_SCHEMA_ID;
  source: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface LogTimeUndoRequestV1 {
  schemaId: typeof LOG_TIME_UNDO_REQUEST_SCHEMA_ID;
  /** Revision to step back from. Mismatch fails closed. */
  expectedRevision: number;
  idempotencyKey: string;
}

/** What one time change did to a snapshot or a run that already existed. */
export interface LogTimeDependentV1 {
  kind: LogTimeDependentKind;
  id: string;
  disposition: LogTimeDependentDisposition;
  /** Plain-language reason shown directly in the War Room. */
  reason: string;
  /** Corpus revision this dependent observed, or null when unrecorded. */
  observedRevision: number | null;
}

export interface LogTimeOutcomeV1 {
  schemaId: typeof LOG_TIME_OUTCOME_SCHEMA_ID;
  caseId: string;
  corpusId: string;
  operation: LogTimeOperation;
  /** Source the operation targeted; null for a whole-corpus undo. */
  source: string | null;
  /** Revision before the operation. */
  previousRevision: number;
  /**
   * Revision now in force. Every durable operation advances this, undo
   * included: the pipeline publishes a new revision carrying the earlier
   * content rather than deleting history.
   */
  appliedRevision: number;
  /**
   * For `undo`, the earlier revision whose content is now back in force.
   * Null for `apply` and `clear`.
   */
  restoredRevision: number | null;
  /** Exact number of timestamps rewritten. */
  changedRecords: number;
  /** True when an identical authorized retry replayed a stored result. */
  replayed: boolean;
  /** Declarations in force after the operation. */
  declarations: LogTimeDeclarationV1[];
  /** Honest impact on work produced under the superseded time basis. */
  dependents: LogTimeDependentV1[];
  createdAt: string;
  createdBy: string;
}

// --------------------------------------------------------------------------
// Shapes
// --------------------------------------------------------------------------

const declarationShape: ObjectShape = {
  source: f.req(f.nstr),
  ianaTimezone: f.req(f.nstr),
  basis: f.req(f.en(...LOG_TIME_DECLARATION_BASES)),
  declaredAt: f.req(f.u64),
  appliedRevision: f.req(f.u64),
  declarationFingerprint: f.req(f.nstr),
  declaredBy: f.req(f.nstr),
};

const sourceStatusShape: ObjectShape = {
  source: f.req(f.nstr),
  unresolvedLocalRecords: f.req(f.u64),
  resolvedLocalRecords: f.req(f.u64),
  explicitWallClockRecords: f.req(f.u64),
  otherOrderOnlyRecords: f.req(f.u64),
  declaration: f.nul(f.obj(declarationShape)),
};

const corpusStateShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_CORPUS_STATE_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  corpusId: f.nul(f.nstr),
  corpusRevision: f.req(f.u64),
  builtAt: f.nul(f.nstr),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  sources: f.req(f.arr(f.obj(sourceStatusShape))),
  reviewOutstanding: f.req(f.bool),
  undoableRevision: f.nul(f.u64),
};

const sampleShape: ObjectShape = {
  ordinal: f.req(f.u64),
  outcome: f.req(f.en(...LOG_TIME_SAMPLE_OUTCOMES)),
  rawTimestamp: f.nul(f.str),
  normalizedInstant: f.nul(f.str),
  utcOffsetSeconds: f.nul(f.i64),
  unresolvedReason: f.nul(f.en(...LOG_TIME_UNRESOLVED_REASONS)),
  excerpt: f.req(f.str),
};

const previewRequestShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_PREVIEW_REQUEST_SCHEMA_ID)),
  source: f.req(f.nstr),
  ianaTimezone: f.req(f.nstr),
  expectedRevision: f.req(f.u64),
};

const previewShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_PREVIEW_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  corpusId: f.req(f.nstr),
  corpusRevision: f.req(f.u64),
  declarationFingerprint: f.req(f.nstr),
  source: f.req(f.nstr),
  ianaTimezone: f.req(f.nstr),
  affectedRecords: f.req(f.u64),
  existingWallClockRecords: f.req(f.u64),
  unchangedOrderOnlyRecords: f.req(f.u64),
  firstResolvedInstant: f.nul(f.nstr),
  lastResolvedInstant: f.nul(f.nstr),
  dstGapCount: f.req(f.u64),
  dstFoldCount: f.req(f.u64),
  unsupportedTimestampCount: f.req(f.u64),
  zoneAbbreviationMismatchCount: f.req(f.u64),
  outOfRangeCount: f.req(f.u64),
  samples: f.req(f.arr(f.obj(sampleShape))),
};

const applyRequestShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_APPLY_REQUEST_SCHEMA_ID)),
  source: f.req(f.nstr),
  ianaTimezone: f.req(f.nstr),
  expectedRevision: f.req(f.u64),
  declarationFingerprint: f.req(f.nstr),
  idempotencyKey: f.req(f.nstr),
};

const clearRequestShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_CLEAR_REQUEST_SCHEMA_ID)),
  source: f.req(f.nstr),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const undoRequestShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_UNDO_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const dependentShape: ObjectShape = {
  kind: f.req(f.en(...LOG_TIME_DEPENDENT_KINDS)),
  id: f.req(f.nstr),
  disposition: f.req(f.en(...LOG_TIME_DEPENDENT_DISPOSITIONS)),
  reason: f.req(f.nstr),
  observedRevision: f.nul(f.u64),
};

const outcomeShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_TIME_OUTCOME_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  corpusId: f.req(f.nstr),
  operation: f.req(f.en(...LOG_TIME_OPERATIONS)),
  source: f.nul(f.nstr),
  previousRevision: f.req(f.u64),
  appliedRevision: f.req(f.u64),
  restoredRevision: f.nul(f.u64),
  changedRecords: f.req(f.u64),
  replayed: f.req(f.bool),
  declarations: f.req(f.arr(f.obj(declarationShape))),
  dependents: f.req(f.arr(f.obj(dependentShape))),
  createdAt: f.req(f.nstr),
  createdBy: f.req(f.nstr),
};

// --------------------------------------------------------------------------
// Field-level guards
// --------------------------------------------------------------------------

/**
 * Shape-check an IANA zone id. Deliberately never maps, normalizes, or
 * substitutes a zone: an unrecognized id is refused, not repaired into a
 * guess.
 */
export function assertIanaTimezone(path: string, value: string): void {
  if (value.length > LOG_TIME_LIMITS.maxIanaTimezoneChars) {
    throw new ContractViolation(path, "IANA timezone id is too long");
  }
  if (value === UNAMBIGUOUS_BARE_ZONE) return;
  if (!IANA_ZONE.test(value)) {
    throw new ContractViolation(
      path,
      "expected an IANA zone id such as America/Chicago, or UTC. " +
        "Bare abbreviations are ambiguous and are not accepted.",
    );
  }
}

function assertSource(path: string, value: string): void {
  if (value.length > LOG_TIME_LIMITS.maxSourceChars) {
    throw new ContractViolation(path, "source identity is too long");
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ContractViolation(path, "source identity must stay corpus-relative");
  }
  if (value.split("/").some((part) => part === "..")) {
    throw new ContractViolation(path, "source identity must not traverse upward");
  }
  if (value.includes("\0")) {
    throw new ContractViolation(path, "source identity must not contain NUL");
  }
}

function assertFingerprint(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest");
  }
}

function assertIdempotencyKey(path: string, value: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(value)) {
    throw new ContractViolation(path, "idempotency key is not a bounded token");
  }
}

function assertCorpusId(path: string, value: string): void {
  if (!CORPUS_ID.test(value)) {
    throw new ContractViolation(path, "corpus id is not a bounded token");
  }
}

function assertIsoInstant(path: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    throw new ContractViolation(path, "expected an ISO-8601 UTC instant ending in Z");
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ContractViolation(path, "is not a real instant");
  }
}

function assertSignedSeconds(path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ContractViolation(path, "expected a signed safe integer");
  }
  if (value < -64_800 || value > 64_800) {
    throw new ContractViolation(path, "UTC offset is outside ±18h");
  }
}

// --------------------------------------------------------------------------
// Parsers
// --------------------------------------------------------------------------

function checkDeclaration(path: string, declaration: LogTimeDeclarationV1): void {
  assertSource(`${path}.source`, declaration.source);
  assertIanaTimezone(`${path}.ianaTimezone`, declaration.ianaTimezone);
  assertFingerprint(`${path}.declarationFingerprint`, declaration.declarationFingerprint);
}

export function parseLogCorpusState(raw: unknown): LogCorpusStateV1 {
  checkObject("$", corpusStateShape, raw);
  const body = raw as LogCorpusStateV1;
  if (body.corpusId !== null) assertCorpusId("$.corpusId", body.corpusId);
  if (body.builtAt !== null) assertIsoInstant("$.builtAt", body.builtAt);
  if (body.corpusId === null && body.corpusRevision !== 0) {
    throw new ContractViolation(
      "$.corpusRevision",
      "a case with no corpus must report revision 0",
    );
  }
  if (body.corpusId === null && body.sources.length > 0) {
    throw new ContractViolation("$.sources", "a case with no corpus has no sources");
  }
  if (body.sources.length > LOG_TIME_LIMITS.maxSources) {
    throw new ContractViolation("$.sources", "source count exceeds cap");
  }
  const seen = new Set<string>();
  body.sources.forEach((status, index) => {
    const path = `$.sources[${index}]`;
    assertSource(`${path}.source`, status.source);
    if (seen.has(status.source)) {
      throw new ContractViolation(`${path}.source`, "duplicate source identity");
    }
    seen.add(status.source);
    if (status.declaration !== null) {
      checkDeclaration(`${path}.declaration`, status.declaration);
      if (status.declaration.source !== status.source) {
        throw new ContractViolation(
          `${path}.declaration.source`,
          "declaration does not belong to this source",
        );
      }
      if (status.declaration.appliedRevision > body.corpusRevision) {
        throw new ContractViolation(
          `${path}.declaration.appliedRevision`,
          "declaration claims a revision the corpus has not reached",
        );
      }
    }
  });
  const outstanding = body.sources.some((status) => status.unresolvedLocalRecords > 0);
  if (outstanding !== body.reviewOutstanding) {
    throw new ContractViolation(
      "$.reviewOutstanding",
      "must equal whether any source still has undeclared local timestamps",
    );
  }
  if (body.undoableRevision !== null && body.undoableRevision >= body.corpusRevision) {
    throw new ContractViolation(
      "$.undoableRevision",
      "an undo target must precede the current revision",
    );
  }
  return body;
}

export function parseLogTimePreviewRequest(raw: unknown): LogTimePreviewRequestV1 {
  checkObject("$", previewRequestShape, raw);
  const body = raw as LogTimePreviewRequestV1;
  assertSource("$.source", body.source);
  assertIanaTimezone("$.ianaTimezone", body.ianaTimezone);
  return body;
}

export function parseLogTimePreview(raw: unknown): LogTimePreviewV1 {
  checkObject("$", previewShape, raw);
  const body = raw as LogTimePreviewV1;
  assertCorpusId("$.corpusId", body.corpusId);
  assertSource("$.source", body.source);
  assertIanaTimezone("$.ianaTimezone", body.ianaTimezone);
  assertFingerprint("$.declarationFingerprint", body.declarationFingerprint);
  if (body.firstResolvedInstant !== null) {
    assertIsoInstant("$.firstResolvedInstant", body.firstResolvedInstant);
  }
  if (body.lastResolvedInstant !== null) {
    assertIsoInstant("$.lastResolvedInstant", body.lastResolvedInstant);
  }
  if (
    body.firstResolvedInstant !== null &&
    body.lastResolvedInstant !== null &&
    Date.parse(body.firstResolvedInstant) > Date.parse(body.lastResolvedInstant)
  ) {
    throw new ContractViolation(
      "$.lastResolvedInstant",
      "resolved range must not end before it starts",
    );
  }
  if ((body.affectedRecords === 0) !== (body.firstResolvedInstant === null)) {
    throw new ContractViolation(
      "$.firstResolvedInstant",
      "a resolved range must be present exactly when records would resolve",
    );
  }
  if (body.samples.length > LOG_TIME_LIMITS.maxPreviewSamples) {
    throw new ContractViolation("$.samples", "sample count exceeds cap");
  }
  body.samples.forEach((sample, index) => {
    const path = `$.samples[${index}]`;
    if (sample.excerpt.length > LOG_TIME_LIMITS.maxExcerptChars) {
      throw new ContractViolation(`${path}.excerpt`, "excerpt exceeds cap");
    }
    if (sample.utcOffsetSeconds !== null) {
      assertSignedSeconds(`${path}.utcOffsetSeconds`, sample.utcOffsetSeconds);
    }
    if (sample.normalizedInstant !== null) {
      assertIsoInstant(`${path}.normalizedInstant`, sample.normalizedInstant);
    }
    if (sample.outcome === "resolved") {
      if (sample.normalizedInstant === null || sample.utcOffsetSeconds === null) {
        throw new ContractViolation(
          `${path}.normalizedInstant`,
          "a resolved sample must carry its instant and offset",
        );
      }
      if (sample.unresolvedReason !== null) {
        throw new ContractViolation(
          `${path}.unresolvedReason`,
          "a resolved sample has no unresolved reason",
        );
      }
      if (sample.rawTimestamp === null) {
        throw new ContractViolation(
          `${path}.rawTimestamp`,
          "a resolved sample must retain the text it was resolved from",
        );
      }
    }
    if (sample.outcome === "unresolved" && sample.unresolvedReason === null) {
      throw new ContractViolation(
        `${path}.unresolvedReason`,
        "an unresolved sample must say why it stays order-only",
      );
    }
    if (sample.outcome === "unresolved" && sample.normalizedInstant !== null) {
      throw new ContractViolation(
        `${path}.normalizedInstant`,
        "an unresolved sample must not carry an instant",
      );
    }
  });
  return body;
}

export function parseLogTimeApplyRequest(raw: unknown): LogTimeApplyRequestV1 {
  checkObject("$", applyRequestShape, raw);
  const body = raw as LogTimeApplyRequestV1;
  assertSource("$.source", body.source);
  assertIanaTimezone("$.ianaTimezone", body.ianaTimezone);
  assertFingerprint("$.declarationFingerprint", body.declarationFingerprint);
  assertIdempotencyKey("$.idempotencyKey", body.idempotencyKey);
  return body;
}

export function parseLogTimeClearRequest(raw: unknown): LogTimeClearRequestV1 {
  checkObject("$", clearRequestShape, raw);
  const body = raw as LogTimeClearRequestV1;
  assertSource("$.source", body.source);
  assertIdempotencyKey("$.idempotencyKey", body.idempotencyKey);
  return body;
}

export function parseLogTimeUndoRequest(raw: unknown): LogTimeUndoRequestV1 {
  checkObject("$", undoRequestShape, raw);
  const body = raw as LogTimeUndoRequestV1;
  assertIdempotencyKey("$.idempotencyKey", body.idempotencyKey);
  if (body.expectedRevision === 0) {
    throw new ContractViolation(
      "$.expectedRevision",
      "revision 0 has nothing to undo",
    );
  }
  return body;
}

export function parseLogTimeOutcome(raw: unknown): LogTimeOutcomeV1 {
  checkObject("$", outcomeShape, raw);
  const body = raw as LogTimeOutcomeV1;
  assertCorpusId("$.corpusId", body.corpusId);
  assertIsoInstant("$.createdAt", body.createdAt);
  if (body.source !== null) assertSource("$.source", body.source);
  if (body.operation === "preview") {
    throw new ContractViolation(
      "$.operation",
      "preview never produces a durable outcome",
    );
  }
  if (body.appliedRevision <= body.previousRevision) {
    throw new ContractViolation(
      "$.appliedRevision",
      "a durable change must advance the corpus revision",
    );
  }
  if (body.operation === "undo") {
    if (body.restoredRevision === null) {
      throw new ContractViolation(
        "$.restoredRevision",
        "undo must name the earlier revision it restored",
      );
    }
    if (body.restoredRevision >= body.previousRevision) {
      throw new ContractViolation(
        "$.restoredRevision",
        "undo must restore a revision earlier than the one it replaced",
      );
    }
  } else if (body.restoredRevision !== null) {
    throw new ContractViolation(
      "$.restoredRevision",
      "only undo restores an earlier revision",
    );
  }
  body.declarations.forEach((declaration, index) => {
    checkDeclaration(`$.declarations[${index}]`, declaration);
  });
  const seen = new Set<string>();
  body.dependents.forEach((dependent, index) => {
    const key = `${dependent.kind}:${dependent.id}`;
    if (seen.has(key)) {
      throw new ContractViolation(
        `$.dependents[${index}].id`,
        "duplicate dependent entry",
      );
    }
    seen.add(key);
    if (
      dependent.disposition === "unknown_basis" &&
      dependent.observedRevision !== null
    ) {
      throw new ContractViolation(
        `$.dependents[${index}].observedRevision`,
        "unknown_basis means no revision was recorded",
      );
    }
  });
  return body;
}
