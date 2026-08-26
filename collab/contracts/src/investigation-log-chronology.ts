/**
 * Read-only normalized chronology for a case-bound log corpus.
 *
 * This contract intentionally keeps timestamp evidence and ordering separate.
 * A row is either backed by a proven instant or explicitly marked order-only;
 * clients must never infer a zone, DST fold, or DST gap from a numeric value.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const LOG_CHRONOLOGY_QUERY_SCHEMA_ID =
  "cd-collab.log_chronology_query.v1" as const;
export const LOG_CHRONOLOGY_PAGE_SCHEMA_ID =
  "cd-collab.log_chronology_page.v1" as const;

export const LOG_CHRONOLOGY_TIME_STATES = ["resolved", "order_only"] as const;
export type LogChronologyTimeState = (typeof LOG_CHRONOLOGY_TIME_STATES)[number];

export const LOG_CHRONOLOGY_PROVENANCE = [
  "explicit_wall",
  "resolved_local",
  "unresolved_local",
  "order_only",
  "legacy_unknown",
] as const;
export type LogChronologyProvenance = (typeof LOG_CHRONOLOGY_PROVENANCE)[number];

export const LOG_CHRONOLOGY_ORDER_ONLY_REASONS = [
  "timezone_unresolved",
  "no_recognized_local_timestamp",
  "unsupported_local_timestamp_shape",
  "ambiguous_dst_fold",
  "nonexistent_dst_gap",
  "zone_abbreviation_mismatch",
  "resolved_instant_out_of_range",
] as const;
export type LogChronologyOrderOnlyReason =
  (typeof LOG_CHRONOLOGY_ORDER_ONLY_REASONS)[number];

export const LOG_CHRONOLOGY_TIME_QUALITIES = ["wall", "mixed", "order_only"] as const;
export type LogChronologyTimeQuality = (typeof LOG_CHRONOLOGY_TIME_QUALITIES)[number];

export const LOG_CHRONOLOGY_LIMITS = {
  defaultPageRows: 50,
  maxPageRows: 200,
  maxSearchChars: 256,
  maxCursorChars: 2_048,
  maxSourceChars: 4_096,
  maxSources: 512,
  maxRawTimestampChars: 256,
  maxMessageChars: 240,
} as const;

const CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LogChronologyQueryV1 {
  schemaId: typeof LOG_CHRONOLOGY_QUERY_SCHEMA_ID;
  /** Case-insensitive literal substring over the redacted message. */
  search: string | null;
  /** Exact portable source identities. Empty means all sources. */
  sources: string[];
  /** Zero selects the bounded default. */
  limit: number;
  /** Opaque keyset cursor returned by the preceding page. */
  cursor: string | null;
}

export interface LogChronologyRowV1 {
  /** Stable ingest ordinal, used only as the final deterministic tie-breaker. */
  seq: number;
  /** Exact portable source identity from the corpus. */
  source: string;
  /** Parser-retained local timestamp text, when available. */
  rawTimestamp: string | null;
  /** ISO-8601 UTC instant only when the active basis proves one. */
  normalizedInstant: string | null;
  timeState: LogChronologyTimeState;
  timestampProvenance: LogChronologyProvenance;
  /** Explicit reason an order-only row is not placed on the instant axis. */
  orderOnlyReason: LogChronologyOrderOnlyReason | null;
  level: string;
  /** Already-redacted and bounded message excerpt. */
  message: string;
}

export interface LogChronologyPageV1 {
  schemaId: typeof LOG_CHRONOLOGY_PAGE_SCHEMA_ID;
  caseId: string;
  corpusId: string;
  corpusRevision: number;
  search: string | null;
  sources: string[];
  rows: LogChronologyRowV1[];
  nextCursor: string | null;
  totalMatched: number;
  orderOnlyCount: number;
  timeQuality: LogChronologyTimeQuality;
}

const queryShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_CHRONOLOGY_QUERY_SCHEMA_ID)),
  search: f.nul(f.str),
  sources: f.req(f.arr(f.nstr)),
  limit: f.req(f.u64),
  cursor: f.nul(f.str),
};

const rowShape: ObjectShape = {
  seq: f.req(f.u64),
  source: f.req(f.nstr),
  rawTimestamp: f.nul(f.str),
  normalizedInstant: f.nul(f.str),
  timeState: f.req(f.en(...LOG_CHRONOLOGY_TIME_STATES)),
  timestampProvenance: f.req(f.en(...LOG_CHRONOLOGY_PROVENANCE)),
  orderOnlyReason: f.nul(f.en(...LOG_CHRONOLOGY_ORDER_ONLY_REASONS)),
  level: f.req(f.nstr),
  message: f.req(f.str),
};

const pageShape: ObjectShape = {
  schemaId: f.req(f.en(LOG_CHRONOLOGY_PAGE_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  corpusId: f.req(f.nstr),
  corpusRevision: f.req(f.u64),
  search: f.nul(f.str),
  sources: f.req(f.arr(f.nstr)),
  rows: f.req(f.arr(f.obj(rowShape))),
  nextCursor: f.nul(f.str),
  totalMatched: f.req(f.u64),
  orderOnlyCount: f.req(f.u64),
  timeQuality: f.req(f.en(...LOG_CHRONOLOGY_TIME_QUALITIES)),
};

function assertSource(path: string, value: string): void {
  if (!value || value.length > LOG_CHRONOLOGY_LIMITS.maxSourceChars) {
    throw new ContractViolation(path, "source identity is not bounded");
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

function assertCursor(path: string, value: string | null): void {
  if (value !== null && (!value || value.length > LOG_CHRONOLOGY_LIMITS.maxCursorChars)) {
    throw new ContractViolation(path, "cursor is not bounded");
  }
  if (value?.includes("\0")) {
    throw new ContractViolation(path, "cursor must not contain NUL");
  }
}

function assertSearch(path: string, value: string | null): void {
  if (value !== null && value.length > LOG_CHRONOLOGY_LIMITS.maxSearchChars) {
    throw new ContractViolation(path, "literal search is too long");
  }
  if (value?.includes("\0")) {
    throw new ContractViolation(path, "literal search must not contain NUL");
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

function assertCorpusId(path: string, value: string): void {
  if (!CORPUS_ID.test(value)) {
    throw new ContractViolation(path, "corpus id is not a bounded token");
  }
}

function assertSources(path: string, sources: string[]): void {
  if (sources.length > LOG_CHRONOLOGY_LIMITS.maxSources) {
    throw new ContractViolation(path, "source count exceeds cap");
  }
  const seen = new Set<string>();
  sources.forEach((source, index) => {
    assertSource(`${path}[${index}]`, source);
    if (seen.has(source)) {
      throw new ContractViolation(`${path}[${index}]`, "duplicate source identity");
    }
    seen.add(source);
  });
}

export function normalizeLogChronologyQuery(
  raw: LogChronologyQueryV1,
): LogChronologyQueryV1 {
  return {
    ...raw,
    search: raw.search?.trim() || null,
    sources: [...raw.sources].sort(),
    limit: raw.limit === 0 ? LOG_CHRONOLOGY_LIMITS.defaultPageRows : raw.limit,
  };
}

export function parseLogChronologyQuery(raw: unknown): LogChronologyQueryV1 {
  checkObject("$", queryShape, raw);
  const body = raw as LogChronologyQueryV1;
  assertSearch("$.search", body.search);
  assertSources("$.sources", body.sources);
  if (body.limit > LOG_CHRONOLOGY_LIMITS.maxPageRows) {
    throw new ContractViolation("$.limit", "page size exceeds cap");
  }
  assertCursor("$.cursor", body.cursor);
  return normalizeLogChronologyQuery(body);
}

export function parseLogChronologyPage(raw: unknown): LogChronologyPageV1 {
  checkObject("$", pageShape, raw);
  const body = raw as LogChronologyPageV1;
  assertCorpusId("$.corpusId", body.corpusId);
  assertSources("$.sources", body.sources);
  assertSearch("$.search", body.search);
  assertCursor("$.nextCursor", body.nextCursor);
  if (body.rows.length > LOG_CHRONOLOGY_LIMITS.maxPageRows) {
    throw new ContractViolation("$.rows", "row count exceeds cap");
  }
  if (body.orderOnlyCount > body.totalMatched) {
    throw new ContractViolation(
      "$.orderOnlyCount",
      "order-only count cannot exceed total matched",
    );
  }

  body.rows.forEach((row, index) => {
    const path = `$.rows[${index}]`;
    assertSource(`${path}.source`, row.source);
    if (row.rawTimestamp !== null) {
      if (
        !row.rawTimestamp ||
        row.rawTimestamp.length > LOG_CHRONOLOGY_LIMITS.maxRawTimestampChars ||
        row.rawTimestamp.includes("\0")
      ) {
        throw new ContractViolation(`${path}.rawTimestamp`, "raw timestamp text is not bounded");
      }
    }
    if (row.message.length > LOG_CHRONOLOGY_LIMITS.maxMessageChars) {
      throw new ContractViolation(`${path}.message`, "message excerpt exceeds cap");
    }
    if (row.timeState === "resolved") {
      if (row.normalizedInstant === null) {
        throw new ContractViolation(
          `${path}.normalizedInstant`,
          "a resolved row must carry an exact instant",
        );
      }
      assertIsoInstant(`${path}.normalizedInstant`, row.normalizedInstant);
      if (row.orderOnlyReason !== null) {
        throw new ContractViolation(
          `${path}.orderOnlyReason`,
          "a resolved row cannot carry an order-only reason",
        );
      }
      if (
        row.timestampProvenance !== "explicit_wall" &&
        row.timestampProvenance !== "resolved_local"
      ) {
        throw new ContractViolation(
          `${path}.timestampProvenance`,
          "a resolved row must prove wall-clock time",
        );
      }
      if (row.timestampProvenance === "resolved_local" && row.rawTimestamp === null) {
        throw new ContractViolation(
          `${path}.rawTimestamp`,
          "resolved local evidence must retain its original timestamp text",
        );
      }
    } else {
      if (row.normalizedInstant !== null) {
        throw new ContractViolation(
          `${path}.normalizedInstant`,
          "an order-only row must not carry an instant",
        );
      }
      if (row.orderOnlyReason === null) {
        throw new ContractViolation(
          `${path}.orderOnlyReason`,
          "an order-only row must say why it is not on the instant axis",
        );
      }
      if (
        row.timestampProvenance === "explicit_wall" ||
        row.timestampProvenance === "resolved_local"
      ) {
        throw new ContractViolation(
          `${path}.timestampProvenance`,
          "a resolved provenance cannot be presented as order-only",
        );
      }
    }
  });

  const resolvedCount = body.totalMatched - body.orderOnlyCount;
  const expectedQuality: LogChronologyTimeQuality =
    body.totalMatched === 0 || body.orderOnlyCount === body.totalMatched
      ? "order_only"
      : body.orderOnlyCount === 0
        ? "wall"
        : "mixed";
  if (body.timeQuality !== expectedQuality) {
    throw new ContractViolation(
      "$.timeQuality",
      `does not match ${resolvedCount} resolved and ${body.orderOnlyCount} order-only rows`,
    );
  }
  return body;
}
