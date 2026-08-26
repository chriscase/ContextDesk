/**
 * Investigation-scoped Log workbench contracts.
 *
 * Search, saved views, bookmarks, share-safe locators, timestamp-candidate
 * grouping, review-rule preview, and merged chronology. Pure JSON. No I/O.
 * Deny-unknown. Saved views and locators are records, not authorization
 * tokens. Timestamp *resolution* stays in the shipped log-time host; the
 * shape classifier here only labels explicit-offset vs local-ambiguous vs
 * unparsable text and never assigns a zone.
 */
import { createHash } from "node:crypto";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { RFC4122_UUID_RE, canonicalJson } from "./investigation-portable.js";
import { assertIanaTimezone } from "./investigation-log-time.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const WORKBENCH_SEARCH_REQUEST_SCHEMA_ID =
  "cd-collab.log_workbench_search_request.v1" as const;
export const WORKBENCH_SEARCH_RESULT_SCHEMA_ID =
  "cd-collab.log_workbench_search_result.v1" as const;
export const WORKBENCH_PAGE_SCHEMA_ID = "cd-collab.log_workbench_page.v1" as const;
export const WORKBENCH_VIEW_SCHEMA_ID = "cd-collab.log_workbench_view.v1" as const;
export const WORKBENCH_BOOKMARK_SCHEMA_ID =
  "cd-collab.log_workbench_bookmark.v1" as const;
export const WORKBENCH_SHARE_SAFE_LOCATOR_SCHEMA_ID =
  "cd-collab.log_workbench_share_safe_locator.v1" as const;
export const WORKBENCH_LOCATOR_RESOLVE_SCHEMA_ID =
  "cd-collab.log_workbench_locator_resolve.v1" as const;
export const WORKBENCH_TIMESTAMP_CANDIDATE_SCHEMA_ID =
  "cd-collab.log_time_candidate.v1" as const;
export const WORKBENCH_REVIEW_RULE_SCHEMA_ID =
  "cd-collab.log_time_review_rule.v1" as const;
export const WORKBENCH_REVIEW_PREVIEW_SCHEMA_ID =
  "cd-collab.log_time_review_preview.v1" as const;
export const WORKBENCH_CHRONOLOGY_SCHEMA_ID =
  "cd-collab.log_workbench_chronology.v1" as const;

/** Shape classifier only — never a timezone resolver. */
export const TIMESTAMP_SHAPE_PARSER_ID = "cd-collab.timestamp_shape" as const;
export const TIMESTAMP_SHAPE_PARSER_VERSION = "1" as const;
/** Host pipeline identity for candidates extracted by cd-core. */
export const TIMESTAMP_HOST_PARSER_ID = "cd-core.log_analysis.parse" as const;

export const WORKBENCH_SEARCH_MODES = [
  "literal",
  "case_insensitive",
  "regex",
] as const;
export type WorkbenchSearchMode = (typeof WORKBENCH_SEARCH_MODES)[number];

export const WORKBENCH_SORTS = ["ingest_order", "time_asc", "time_desc"] as const;
export type WorkbenchSort = (typeof WORKBENCH_SORTS)[number];

export const WORKBENCH_GROUPINGS = [
  "none",
  "component",
  "file",
  "batch",
  "rotation_family",
  "entity",
  "severity",
] as const;
export type WorkbenchGrouping = (typeof WORKBENCH_GROUPINGS)[number];

export const WORKBENCH_BOOKMARK_STATUSES = [
  "resolved",
  "stale",
  "unresolvable",
] as const;
export type WorkbenchBookmarkStatus = (typeof WORKBENCH_BOOKMARK_STATUSES)[number];

export const TIMESTAMP_PARSE_CLASSES = [
  "explicit_offset",
  "local_ambiguous",
  "unparsable",
  "date_only",
  "missing",
] as const;
export type TimestampParseClass = (typeof TIMESTAMP_PARSE_CLASSES)[number];

export const REVIEW_RULE_SCOPES = [
  "source",
  "rotation_family",
  "selected_items",
] as const;
export type ReviewRuleScope = (typeof REVIEW_RULE_SCOPES)[number];

export const CHRONOLOGY_CORRELATION_KINDS = [
  "observed_identifier",
  "heuristic_similarity",
  "none",
] as const;
export type ChronologyCorrelationKind =
  (typeof CHRONOLOGY_CORRELATION_KINDS)[number];

export const CHRONOLOGY_ANCHOR_STATUSES = [
  "pinned",
  "human_ground_truth",
] as const;
export type ChronologyAnchorStatus = (typeof CHRONOLOGY_ANCHOR_STATUSES)[number];

export const WORKBENCH_LIMITS = {
  maxPageRows: 200,
  maxReturnedMatches: 200,
  /**
   * Lines one search *page* may scan. This is a per-request work budget, not a
   * cap on the corpus: a page that spends it stops at an exact corpus position
   * and hands back a cursor that resumes there, so every selected line stays
   * reachable across pages.
   */
  maxSearchWorkLines: 50_000,
  /** Rows held resident while streaming one file. Bounds peak memory. */
  corpusWindowLines: 2_000,
  /** Bound on the opaque resume token so a cursor can never grow unbounded. */
  maxPageCursorChars: 1_024,
  maxLineChars: 16_384,
  maxRegexChars: 256,
  maxIncludeTerms: 16,
  maxExcludeTerms: 16,
  maxPanes: 4,
  maxContextLines: 10,
  maxViewsPerInvestigation: 64,
  maxBookmarksPerInvestigation: 1_024,
  maxQueryChars: 512,
  maxLabelChars: 120,
  maxNoteChars: 2_000,
  maxIdempotencyChars: 128,
} as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const ISO_OFFSET =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const LOCAL_DATETIME =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?!\s*(?:Z|[+-]\d{2}))/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A time-range bound is only accepted as a full instant with a declared zone.
 * A bare local calendar time is refused rather than compared, because the
 * workbench never guesses which zone a responder meant.
 */
const RANGE_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CATASTROPHIC_REGEX =
  /(\([^()]*[+*][^()]*\)[+*])|(\{\s*(?:[6-9]\d|\d{3,})\s*(?:,\s*(?:\d+)?\s*)?\})/;

export function rotationFamilyOf(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.replace(
    /(\.log)(?:[.-](?:\d[\d._-]*|old|previous|bak))$/i,
    "$1",
  );
}

export function displayLabelForPath(relativePath: string): string {
  const base = relativePath.replace(/\\/g, "/");
  const leaf = base.split("/").pop() ?? base;
  return leaf.length > 0 ? leaf : "untitled log";
}

export const WORKBENCH_PAGE_CURSOR_VERSION = 1 as const;

/**
 * Where a search page stopped, so the next one resumes at that exact corpus
 * position.
 *
 * The first contract only had a match ordinal. An ordinal cannot express "the
 * scan stopped at line 50,000 having found nothing": advancing it skips
 * *matches*, never corpus lines, so a root cause past the stopping point was
 * unreachable no matter how many pages a responder asked for. This names the
 * position instead.
 *
 * It carries no capability. Authorization is re-checked on every request; the
 * digest here only refuses a cursor minted against a different corpus, so a
 * stale token fails closed instead of silently reading past a moved boundary.
 */
export interface WorkbenchPageCursorV1 {
  version: typeof WORKBENCH_PAGE_CURSOR_VERSION;
  /** Identity of the scoped file set this cursor was minted against. */
  scopeDigest: string;
  /** Normalization revision in force when it was minted. */
  normalizationRevision: number | null;
  /** File to resume in. Empty means "the first file in scope". */
  evidenceId: string;
  /** First line not yet scanned, 1-based. */
  lineNumber: number;
  /** Matches counted strictly before this position. */
  matchOrdinal: number;
  /** Lines scanned by every page before this one. */
  scannedLines: number;
}

const cursorShape: ObjectShape = {
  version: f.req(f.u64),
  scopeDigest: f.req(f.nstr),
  normalizationRevision: f.nul(f.u64),
  evidenceId: f.req(f.str),
  lineNumber: f.req(f.u64),
  matchOrdinal: f.req(f.u64),
  scannedLines: f.req(f.u64),
};

export function encodeWorkbenchPageCursor(cursor: WorkbenchPageCursorV1): string {
  const token = Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");
  if (token.length > WORKBENCH_LIMITS.maxPageCursorChars) {
    throw new ContractViolation("$.pageCursor", "resume token exceeds its bound");
  }
  return token;
}

export function decodeWorkbenchPageCursor(raw: string): WorkbenchPageCursorV1 {
  if (!raw || raw.length > WORKBENCH_LIMITS.maxPageCursorChars) {
    throw new ContractViolation("$.pageCursor", "is not a bounded resume token");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ContractViolation("$.pageCursor", "is not a readable resume token");
  }
  checkObject("$.pageCursor", cursorShape, parsed);
  const cursor = parsed as WorkbenchPageCursorV1;
  if (cursor.version !== WORKBENCH_PAGE_CURSOR_VERSION) {
    throw new ContractViolation("$.pageCursor", "was minted by a different contract");
  }
  return cursor;
}

/** Identity of one file as far as a resume cursor is concerned. */
export interface WorkbenchScopedFile {
  evidenceId: string;
  relativePath: string;
  digest: string;
}

/**
 * Identity of a scoped corpus: which files, in which order, at which bytes.
 * A cursor minted before an intake changed the set will not match, and is
 * refused rather than resumed against different lines.
 */
export function workbenchCorpusScopeDigest(
  files: readonly WorkbenchScopedFile[],
): string {
  return createHash("sha256")
    .update(
      canonicalJson(
        files.map((file) => [file.evidenceId, file.digest] as const),
      ),
      "utf8",
    )
    .digest("hex");
}

/** File-level selection, resolved before a single byte is read. */
export interface WorkbenchCorpusScope {
  evidenceIds: readonly string[];
  file: string | null;
  rotationFamily: string | null;
}

export function scopeFromSearchFilters(
  filters: WorkbenchSearchFiltersV1,
): WorkbenchCorpusScope {
  return {
    evidenceIds: filters.evidenceIds,
    file: filters.file,
    rotationFamily: filters.rotationFamily,
  };
}

/**
 * Whether a file is in scope at all.
 *
 * This runs against file metadata, before its bytes are read. Applying the
 * same predicate after a read budget was already spent is what let a selected
 * file sit unread behind unselected ones.
 */
export function fileInScope(
  scope: WorkbenchCorpusScope,
  file: { evidenceId: string; relativePath: string },
): boolean {
  if (scope.evidenceIds.length > 0 && !scope.evidenceIds.includes(file.evidenceId)) {
    return false;
  }
  if (scope.file !== null && scope.file !== file.relativePath) return false;
  if (
    scope.rotationFamily !== null
    && scope.rotationFamily !== rotationFamilyOf(file.relativePath)
  ) {
    return false;
  }
  return true;
}

/**
 * Classify timestamp *text shape*. Never assigns a zone. An explicit offset
 * is reported as such; a local calendar time stays `local_ambiguous`.
 */
export function classifyTimestampShape(text: string | null | undefined): {
  parseClass: TimestampParseClass;
  originalText: string | null;
  explicitOffset: string | null;
  unknownReason: string | null;
} {
  if (text === undefined || text === null || text.trim() === "") {
    return {
      parseClass: "missing",
      originalText: null,
      explicitOffset: null,
      unknownReason: "no_recognized_timestamp",
    };
  }
  const trimmed = text.trim();
  if (DATE_ONLY.test(trimmed)) {
    return {
      parseClass: "date_only",
      originalText: trimmed,
      explicitOffset: null,
      unknownReason: "date_only_is_not_an_instant",
    };
  }
  const offset = trimmed.match(ISO_OFFSET);
  if (offset) {
    const token = offset[0];
    const zone = token.match(/(Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? null;
    return {
      parseClass: "explicit_offset",
      originalText: token,
      explicitOffset: zone,
      unknownReason: null,
    };
  }
  const local = trimmed.match(LOCAL_DATETIME);
  if (local) {
    return {
      parseClass: "local_ambiguous",
      originalText: local[0],
      explicitOffset: null,
      unknownReason: "ambiguous_timezone",
    };
  }
  return {
    parseClass: "unparsable",
    originalText: trimmed.slice(0, 80),
    explicitOffset: null,
    unknownReason: "unsupported_local_timestamp_shape",
  };
}

export function assertSafeRegex(path: string, pattern: string): void {
  if (pattern.length > WORKBENCH_LIMITS.maxRegexChars) {
    throw new ContractViolation(path, "regex exceeds the bounded pattern length");
  }
  if (
    CATASTROPHIC_REGEX.test(pattern)
    || /\([^)]*[|+*][^)]*\)[+*?]/.test(pattern)
  ) {
    throw new ContractViolation(
      path,
      "regex is not safely bounded (nested or oversized quantifiers)",
    );
  }
  if (/(?<!\\)\\[1-9]/.test(pattern) || pattern.includes("(?<") || pattern.includes("(?=")) {
    throw new ContractViolation(path, "regex backreferences and lookaround are refused");
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    throw new ContractViolation(path, "regex is not a valid pattern");
  }
}

function requireKey(path: string, value: string): void {
  if (!IDEMPOTENCY.test(value)) {
    throw new ContractViolation(path, "idempotency key is not a bounded token");
  }
}

function requireDigest(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "must be a lowercase SHA-256 digest");
  }
}

function requireUuid(path: string, value: string): void {
  if (!RFC4122_UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected an RFC 4122 UUID");
  }
}

function requireLabel(path: string, value: string): void {
  if (!value.trim()) throw new ContractViolation(path, "must not be empty");
  if (value.length > WORKBENCH_LIMITS.maxLabelChars) {
    throw new ContractViolation(path, "is too long");
  }
}

/**
 * Parse a time-range bound. Returns the instant in epoch milliseconds, or
 * throws with copy a responder can act on. Never falls back to a string
 * comparison: an unparsable bound is a refusal, not a silent filter.
 */
export function parseRangeInstant(path: string, value: string): number {
  const trimmed = value.trim();
  if (!RANGE_INSTANT.test(trimmed)) {
    throw new ContractViolation(
      path,
      "must be a full UTC instant such as 2024-03-10T08:00:00Z; a local time with no zone is not accepted",
    );
  }
  const instant = Date.parse(trimmed);
  if (Number.isNaN(instant)) {
    throw new ContractViolation(path, "is not a real calendar instant");
  }
  return instant;
}

export function truncateLine(text: string): { text: string; wrapped: boolean } {
  if (text.length <= WORKBENCH_LIMITS.maxLineChars) {
    return { text, wrapped: false };
  }
  return {
    text: text.slice(0, WORKBENCH_LIMITS.maxLineChars),
    wrapped: true,
  };
}

export interface WorkbenchLine {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  intakeBatchId: string | null;
  lineNumber: number;
  byteOffset: number;
  text: string;
  wrapped: boolean;
  severity: string | null;
  component: string | null;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  parseClass: TimestampParseClass;
  digest: string;
}

export interface WorkbenchSearchFiltersV1 {
  includeTerms: string[];
  excludeTerms: string[];
  severity: string | null;
  component: string | null;
  file: string | null;
  rotationFamily: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  evidenceIds: string[];
}

export interface WorkbenchSearchRequestV1 {
  schemaId: typeof WORKBENCH_SEARCH_REQUEST_SCHEMA_ID;
  query: string;
  mode: WorkbenchSearchMode;
  filters: WorkbenchSearchFiltersV1;
  contextBefore: number;
  contextAfter: number;
  /**
   * Match ordinal already returned. Kept for callers written against the first
   * contract: resuming by ordinal re-scans from the start of the scoped corpus.
   */
  cursor: number;
  /**
   * Opaque resume token from a previous page's `nextPageCursor`. When present
   * it wins over `cursor`, because it names the exact corpus position the last
   * page stopped at instead of a count that has to be re-derived.
   */
  pageCursor?: string | null;
  limit: number;
  expectedNormalizationRevision: number | null;
}

export interface WorkbenchMatchV1 {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  lineNumber: number;
  byteOffset: number;
  text: string;
  wrapped: boolean;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  parseClass: TimestampParseClass;
  contextBefore: string[];
  contextAfter: string[];
}

export interface WorkbenchSearchResultV1 {
  schemaId: typeof WORKBENCH_SEARCH_RESULT_SCHEMA_ID;
  matches: WorkbenchMatchV1[];
  returned: number;
  bounded: boolean;
  atLeast: number;
  nextCursor: number | null;
  /**
   * Resume token for the next page, or null when there is nothing left to do.
   * Unlike `nextCursor` this names a corpus *position*, so advancing it can
   * never skip a match that this page did not reach.
   */
  nextPageCursor: string | null;
  cancelled: boolean;
  /**
   * True only when the scan stopped short and cannot be resumed. A page that
   * stopped on its work budget is *not* truncated: it hands back a cursor.
   */
  corpusTruncated: boolean;
  /** True when every line in the selected scope has now been searched. */
  coverageComplete: boolean;
  /** Lines this page examined. */
  scannedLines: number;
  /** Lines examined by this page and every page before it. */
  scannedLinesTotal: number;
  /** Files the selected scope resolved to, before any line was read. */
  scopeFileCount: number;
  timeFilterApplied: boolean;
  timeFilterUnknownReason: string | null;
  /**
   * Set when a time-filtered search could not consult the timestamp authority.
   * The workbench refuses to answer a time range from intake bytes alone.
   */
  timeAuthorityUnavailableReason: string | null;
  expectedNormalizationRevision: number | null;
}

export interface WorkbenchPageV1 {
  schemaId: typeof WORKBENCH_PAGE_SCHEMA_ID;
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  startLine: number;
  rows: WorkbenchMatchV1[];
  wrappedRowCount: number;
  nextStartLine: number | null;
  bounded: boolean;
}

export interface WorkbenchDisplayOptionsV1 {
  syncScroll: boolean;
  wrap: boolean;
  lineNumbers: boolean;
  displayTimezone: string | null;
}

export interface WorkbenchViewV1 {
  schemaId: typeof WORKBENCH_VIEW_SCHEMA_ID;
  id: string;
  investigationId: string;
  name: string;
  filters: WorkbenchSearchFiltersV1;
  query: string;
  mode: WorkbenchSearchMode;
  selectedPanes: string[];
  timeFrom: string | null;
  timeTo: string | null;
  sort: WorkbenchSort;
  grouping: WorkbenchGrouping;
  display: WorkbenchDisplayOptionsV1;
  contextBefore: number;
  contextAfter: number;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  createdAt: string;
  createdBy: string;
  replayed: boolean;
}

export interface WorkbenchLocatorV1 {
  evidenceId: string;
  digestAtBind: string;
  byteOffset: number;
  lineNumber: number;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  corpusRevision: number | null;
}

export interface WorkbenchBookmarkV1 {
  schemaId: typeof WORKBENCH_BOOKMARK_SCHEMA_ID;
  id: string;
  investigationId: string;
  locator: WorkbenchLocatorV1;
  shareSafeToken: string;
  note: string;
  status: WorkbenchBookmarkStatus;
  staleReason: string | null;
  privacyClass: PrivacyClass;
  idempotencyKey: string;
  createdAt: string;
  createdBy: string;
  replayed: boolean;
}

export interface WorkbenchShareSafeLocatorV1 {
  schemaId: typeof WORKBENCH_SHARE_SAFE_LOCATOR_SCHEMA_ID;
  token: string;
}

export interface WorkbenchLocatorResolveV1 {
  schemaId: typeof WORKBENCH_LOCATOR_RESOLVE_SCHEMA_ID;
  found: boolean;
  status: WorkbenchBookmarkStatus | "not_found";
  staleReason: string | null;
  relativePath: string | null;
  lineNumber: number | null;
  investigationId: string | null;
}

export interface WorkbenchTimestampCandidateV1 {
  schemaId: typeof WORKBENCH_TIMESTAMP_CANDIDATE_SCHEMA_ID;
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  parserId: string;
  parserVersion: string;
  sourceOffset: number;
  sourceLine: number;
  originalText: string;
  parseClass: TimestampParseClass;
  precision: string;
  explicitOffset: string | null;
  confidenceUnknownReason: string | null;
}

export interface WorkbenchReviewRuleV1 {
  schemaId: typeof WORKBENCH_REVIEW_RULE_SCHEMA_ID;
  scope: ReviewRuleScope;
  source: string | null;
  rotationFamily: string | null;
  selectedEvidenceIds: string[];
  ianaTimezone: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface WorkbenchReviewPreviewV1 {
  schemaId: typeof WORKBENCH_REVIEW_PREVIEW_SCHEMA_ID;
  ianaTimezone: string;
  expectedRevision: number;
  affectedEvidenceIds: string[];
  affectedRelativePaths: string[];
  affectedRecordCount: number;
  refusedGuess: boolean;
  notes: string[];
}

export interface WorkbenchChronologyEventV1 {
  evidenceId: string;
  relativePath: string;
  rotationFamily: string;
  lineNumber: number;
  originalTimestamp: string | null;
  normalizedUtc: string | null;
  displayTime: string | null;
  severity: string | null;
  component: string | null;
  intakeBatchId: string | null;
  groupKey: string;
  adjacencyReason: string;
  uncertainty: string[];
  correlationKind: ChronologyCorrelationKind;
  correlationId: string | null;
  anchorStatus: ChronologyAnchorStatus | null;
  excerpt: string;
}

/** Host/cd-core event stamp. `ts` is unix seconds; wall-clock quality only. */
export interface HostEventStampV1 {
  source: string;
  message: string;
  ts: number;
  timeQuality: string;
  unresolvedLocalTimestamp: string | null;
}

export function chronologyAnchorKey(evidenceId: string, lineNumber: number): string {
  return `${evidenceId}:${lineNumber}`;
}

export function groupingKeyOf(
  line: WorkbenchLine,
  grouping: WorkbenchGrouping,
): string {
  switch (grouping) {
    case "file":
      return line.relativePath;
    case "component":
      return line.component ?? line.relativePath;
    case "batch":
      return line.intakeBatchId ?? "no-batch";
    case "rotation_family":
      return line.rotationFamily;
    case "entity":
      return observedCorrelationId(line.text) ?? "no-observed-id";
    case "severity":
      return line.severity ?? "unspecified";
    case "none":
      return "ungrouped";
  }
}

/**
 * Overlay host/cd-core timestamps onto intake lines. Local-ambiguous text
 * never becomes UTC unless the host reports wall-clock quality after an
 * explicit timezone apply.
 */
export interface HostTimestampOverlay {
  /** Overlay one bounded window. Each stamp is still consumed at most once. */
  apply(lines: readonly WorkbenchLine[]): WorkbenchLine[];
  readonly empty: boolean;
}

/**
 * Build a reusable overlay over host stamps.
 *
 * The overlay is stateful across windows because a stamp describes one event
 * and must not be spent twice. Candidates are bucketed by file leaf so a
 * window costs the stamps that could plausibly belong to it, not the whole
 * host result: matching every line against every stamp is quadratic, and on a
 * corpus large enough to need windowing that cost is the whole search.
 */
export function createHostTimestampOverlay(
  stamps: readonly HostEventStampV1[],
): HostTimestampOverlay {
  const buckets = new Map<string, HostEventStampV1[]>();
  for (const stamp of stamps) {
    const leaf = stamp.source.replace(/\\/g, "/").split("/").pop() ?? stamp.source;
    const bucket = buckets.get(leaf);
    if (bucket) bucket.push(stamp);
    else buckets.set(leaf, [stamp]);
  }
  return {
    empty: stamps.length === 0,
    apply(lines) {
      if (stamps.length === 0) return [...lines];
      return lines.map((line) => {
        const leaf = line.relativePath.replace(/\\/g, "/").split("/").pop()
          ?? line.relativePath;
        const bucket = buckets.get(leaf);
        if (!bucket || bucket.length === 0) return line;
        const index = bucket.findIndex((stamp) => stampMatchesLine(stamp, line));
        if (index < 0) return line;
        const [stamp] = bucket.splice(index, 1);
        if (!stamp) return line;
        const wall = stamp.timeQuality === "wall clock";
        const normalizedUtc =
          wall && Number.isFinite(stamp.ts) ? new Date(stamp.ts * 1000).toISOString() : null;
        return {
          ...line,
          originalTimestamp: stamp.unresolvedLocalTimestamp ?? line.originalTimestamp,
          normalizedUtc,
        };
      });
    },
  };
}

export function applyHostTimestamps(
  lines: readonly WorkbenchLine[],
  stamps: readonly HostEventStampV1[],
): WorkbenchLine[] {
  return createHostTimestampOverlay(stamps).apply(lines);
}

function stampMatchesLine(stamp: HostEventStampV1, line: WorkbenchLine): boolean {
  const source = stamp.source.replace(/\\/g, "/");
  const path = line.relativePath.replace(/\\/g, "/");
  const sourceOk =
    source === path
    || path.endsWith(`/${source}`)
    || source.endsWith(`/${path}`)
    || source.split("/").pop() === path.split("/").pop();
  if (!sourceOk) return false;
  const local = stamp.unresolvedLocalTimestamp?.trim();
  const original = line.originalTimestamp?.trim();
  if (local && original && local === original) return true;
  const message = stamp.message.trim();
  const text = line.text.trim();
  if (!message || !text) return false;
  if (text.includes(message) || message.includes(text)) return true;
  const fold = (value: string) => value.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
  return fold(text).includes(fold(message));
}

export interface WorkbenchUnknownBucketV1 {
  category: string;
  count: number;
  detail: string;
}

export interface WorkbenchChronologyV1 {
  schemaId: typeof WORKBENCH_CHRONOLOGY_SCHEMA_ID;
  grouping: WorkbenchGrouping;
  events: WorkbenchChronologyEventV1[];
  bounded: boolean;
  atLeast: number;
  unknownBuckets: WorkbenchUnknownBucketV1[];
  expectedNormalizationRevision: number | null;
}

const filtersShape: ObjectShape = {
  includeTerms: f.req(f.arr(f.str)),
  excludeTerms: f.req(f.arr(f.str)),
  severity: f.nul(f.str),
  component: f.nul(f.str),
  file: f.nul(f.str),
  rotationFamily: f.nul(f.str),
  timeFrom: f.nul(f.str),
  timeTo: f.nul(f.str),
  evidenceIds: f.req(f.arr(f.str)),
};

const searchRequestShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_SEARCH_REQUEST_SCHEMA_ID)),
  query: f.req(f.str),
  mode: f.req(f.en(...WORKBENCH_SEARCH_MODES)),
  filters: f.req(f.obj(filtersShape)),
  contextBefore: f.req(f.u64),
  contextAfter: f.req(f.u64),
  cursor: f.req(f.u64),
  // Optional so a client written against the first contract still validates.
  pageCursor: f.optNul(f.str),
  limit: f.req(f.u64),
  expectedNormalizationRevision: f.nul(f.u64),
};

const matchShape: ObjectShape = {
  evidenceId: f.req(f.nstr),
  relativePath: f.req(f.str),
  rotationFamily: f.req(f.str),
  lineNumber: f.req(f.u64),
  byteOffset: f.req(f.u64),
  text: f.req(f.str),
  wrapped: f.req(f.bool),
  originalTimestamp: f.nul(f.str),
  normalizedUtc: f.nul(f.str),
  parseClass: f.req(f.en(...TIMESTAMP_PARSE_CLASSES)),
  contextBefore: f.req(f.arr(f.str)),
  contextAfter: f.req(f.arr(f.str)),
};

const searchResultShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_SEARCH_RESULT_SCHEMA_ID)),
  matches: f.req(f.arr(f.obj(matchShape))),
  returned: f.req(f.u64),
  bounded: f.req(f.bool),
  atLeast: f.req(f.u64),
  nextCursor: f.nul(f.u64),
  nextPageCursor: f.nul(f.str),
  cancelled: f.req(f.bool),
  corpusTruncated: f.req(f.bool),
  coverageComplete: f.req(f.bool),
  scannedLines: f.req(f.u64),
  scannedLinesTotal: f.req(f.u64),
  scopeFileCount: f.req(f.u64),
  timeFilterApplied: f.req(f.bool),
  timeFilterUnknownReason: f.nul(f.str),
  timeAuthorityUnavailableReason: f.nul(f.str),
  expectedNormalizationRevision: f.nul(f.u64),
};

const displayShape: ObjectShape = {
  syncScroll: f.req(f.bool),
  wrap: f.req(f.bool),
  lineNumbers: f.req(f.bool),
  displayTimezone: f.nul(f.str),
};

const viewShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_VIEW_SCHEMA_ID)),
  id: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  name: f.req(f.nstr),
  filters: f.req(f.obj(filtersShape)),
  query: f.req(f.str),
  mode: f.req(f.en(...WORKBENCH_SEARCH_MODES)),
  selectedPanes: f.req(f.arr(f.str)),
  timeFrom: f.nul(f.str),
  timeTo: f.nul(f.str),
  sort: f.req(f.en(...WORKBENCH_SORTS)),
  grouping: f.req(f.en(...WORKBENCH_GROUPINGS)),
  display: f.req(f.obj(displayShape)),
  contextBefore: f.req(f.u64),
  contextAfter: f.req(f.u64),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.nstr),
  createdAt: f.req(f.nstr),
  createdBy: f.req(f.nstr),
  replayed: f.req(f.bool),
};

const locatorShape: ObjectShape = {
  evidenceId: f.req(f.nstr),
  digestAtBind: f.req(f.nstr),
  byteOffset: f.req(f.u64),
  lineNumber: f.req(f.u64),
  originalTimestamp: f.nul(f.str),
  normalizedUtc: f.nul(f.str),
  corpusRevision: f.nul(f.u64),
};

const bookmarkShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_BOOKMARK_SCHEMA_ID)),
  id: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  locator: f.req(f.obj(locatorShape)),
  shareSafeToken: f.req(f.nstr),
  note: f.req(f.str),
  status: f.req(f.en(...WORKBENCH_BOOKMARK_STATUSES)),
  staleReason: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  idempotencyKey: f.req(f.nstr),
  createdAt: f.req(f.nstr),
  createdBy: f.req(f.nstr),
  replayed: f.req(f.bool),
};

const shareSafeLocatorShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_SHARE_SAFE_LOCATOR_SCHEMA_ID)),
  token: f.req(f.nstr),
};

const locatorResolveShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_LOCATOR_RESOLVE_SCHEMA_ID)),
  found: f.req(f.bool),
  status: f.req(f.en("resolved", "stale", "unresolvable", "not_found")),
  staleReason: f.nul(f.str),
  relativePath: f.nul(f.str),
  lineNumber: f.nul(f.u64),
  investigationId: f.nul(f.str),
};

const candidateShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_TIMESTAMP_CANDIDATE_SCHEMA_ID)),
  evidenceId: f.req(f.nstr),
  relativePath: f.req(f.str),
  rotationFamily: f.req(f.str),
  parserId: f.req(f.nstr),
  parserVersion: f.req(f.nstr),
  sourceOffset: f.req(f.u64),
  sourceLine: f.req(f.u64),
  originalText: f.req(f.str),
  parseClass: f.req(f.en(...TIMESTAMP_PARSE_CLASSES)),
  precision: f.req(f.nstr),
  explicitOffset: f.nul(f.str),
  confidenceUnknownReason: f.nul(f.str),
};

const reviewRuleShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_REVIEW_RULE_SCHEMA_ID)),
  scope: f.req(f.en(...REVIEW_RULE_SCOPES)),
  source: f.nul(f.str),
  rotationFamily: f.nul(f.str),
  selectedEvidenceIds: f.req(f.arr(f.str)),
  ianaTimezone: f.req(f.nstr),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
};

const reviewPreviewShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_REVIEW_PREVIEW_SCHEMA_ID)),
  ianaTimezone: f.req(f.nstr),
  expectedRevision: f.req(f.u64),
  affectedEvidenceIds: f.req(f.arr(f.str)),
  affectedRelativePaths: f.req(f.arr(f.str)),
  affectedRecordCount: f.req(f.u64),
  refusedGuess: f.req(f.bool),
  notes: f.req(f.arr(f.str)),
};

const chronologyEventShape: ObjectShape = {
  evidenceId: f.req(f.nstr),
  relativePath: f.req(f.str),
  rotationFamily: f.req(f.str),
  lineNumber: f.req(f.u64),
  originalTimestamp: f.nul(f.str),
  normalizedUtc: f.nul(f.str),
  displayTime: f.nul(f.str),
  severity: f.nul(f.str),
  component: f.nul(f.str),
  intakeBatchId: f.nul(f.str),
  groupKey: f.req(f.str),
  adjacencyReason: f.req(f.nstr),
  uncertainty: f.req(f.arr(f.str)),
  correlationKind: f.req(f.en(...CHRONOLOGY_CORRELATION_KINDS)),
  correlationId: f.nul(f.str),
  anchorStatus: f.nul(f.en(...CHRONOLOGY_ANCHOR_STATUSES)),
  excerpt: f.req(f.str),
};

const unknownBucketShape: ObjectShape = {
  category: f.req(f.nstr),
  count: f.req(f.u64),
  detail: f.req(f.nstr),
};

const chronologyShape: ObjectShape = {
  schemaId: f.req(f.en(WORKBENCH_CHRONOLOGY_SCHEMA_ID)),
  grouping: f.req(f.en(...WORKBENCH_GROUPINGS)),
  events: f.req(f.arr(f.obj(chronologyEventShape))),
  bounded: f.req(f.bool),
  atLeast: f.req(f.u64),
  unknownBuckets: f.req(f.arr(f.obj(unknownBucketShape))),
  expectedNormalizationRevision: f.nul(f.u64),
};

function assertFilters(path: string, filters: WorkbenchSearchFiltersV1): void {
  if (filters.includeTerms.length > WORKBENCH_LIMITS.maxIncludeTerms) {
    throw new ContractViolation(`${path}.includeTerms`, "too many include terms");
  }
  if (filters.excludeTerms.length > WORKBENCH_LIMITS.maxExcludeTerms) {
    throw new ContractViolation(`${path}.excludeTerms`, "too many exclude terms");
  }
  for (const [index, term] of filters.includeTerms.entries()) {
    if (term.length > WORKBENCH_LIMITS.maxQueryChars) {
      throw new ContractViolation(`${path}.includeTerms[${index}]`, "is too long");
    }
  }
  for (const [index, term] of filters.excludeTerms.entries()) {
    if (term.length > WORKBENCH_LIMITS.maxQueryChars) {
      throw new ContractViolation(`${path}.excludeTerms[${index}]`, "is too long");
    }
  }
  assertTimeRange(path, filters.timeFrom, filters.timeTo);
}

/**
 * A half-open or closed time range is only usable if both bounds are real
 * instants and the window is not inverted. Refusing here keeps an unparsable
 * bound from quietly excluding every line further down.
 */
export function assertTimeRange(
  path: string,
  timeFrom: string | null,
  timeTo: string | null,
): void {
  const from = timeFrom ? parseRangeInstant(`${path}.timeFrom`, timeFrom) : null;
  const to = timeTo ? parseRangeInstant(`${path}.timeTo`, timeTo) : null;
  if (from !== null && to !== null && from > to) {
    throw new ContractViolation(
      `${path}.timeTo`,
      "is earlier than the start of the range",
    );
  }
}

export function parseWorkbenchSearchRequest(raw: unknown): WorkbenchSearchRequestV1 {
  checkObject("$", searchRequestShape, raw);
  const body = raw as WorkbenchSearchRequestV1;
  if (body.query.length > WORKBENCH_LIMITS.maxQueryChars) {
    throw new ContractViolation("$.query", "is too long");
  }
  if (body.mode === "regex") assertSafeRegex("$.query", body.query);
  if (body.contextBefore > WORKBENCH_LIMITS.maxContextLines) {
    throw new ContractViolation("$.contextBefore", "exceeds the context cap");
  }
  if (body.contextAfter > WORKBENCH_LIMITS.maxContextLines) {
    throw new ContractViolation("$.contextAfter", "exceeds the context cap");
  }
  if (body.limit === 0 || body.limit > WORKBENCH_LIMITS.maxReturnedMatches) {
    throw new ContractViolation("$.limit", "must be between 1 and the match cap");
  }
  assertFilters("$.filters", body.filters);
  return body;
}

export function parseWorkbenchSearchResult(raw: unknown): WorkbenchSearchResultV1 {
  checkObject("$", searchResultShape, raw);
  const body = raw as WorkbenchSearchResultV1;
  if (body.matches.length !== body.returned) {
    throw new ContractViolation("$.returned", "must equal matches.length");
  }
  if (body.returned > WORKBENCH_LIMITS.maxReturnedMatches) {
    throw new ContractViolation("$.returned", "exceeds the match cap");
  }
  if (body.atLeast < body.returned) {
    throw new ContractViolation("$.atLeast", "must be at least the returned count");
  }
  if (body.bounded && body.atLeast < body.returned) {
    throw new ContractViolation("$.bounded", "bounded results must not under-count");
  }
  if (body.corpusTruncated && !body.bounded) {
    throw new ContractViolation(
      "$.bounded",
      "a partly read corpus must be reported as bounded",
    );
  }
  return body;
}

export function parseWorkbenchView(raw: unknown): WorkbenchViewV1 {
  checkObject("$", viewShape, raw);
  const body = raw as WorkbenchViewV1;
  requireUuid("$.id", body.id);
  requireUuid("$.investigationId", body.investigationId);
  requireLabel("$.name", body.name);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  if (body.selectedPanes.length === 0 || body.selectedPanes.length > WORKBENCH_LIMITS.maxPanes) {
    throw new ContractViolation("$.selectedPanes", "must select between 1 and 4 panes");
  }
  if (body.mode === "regex") assertSafeRegex("$.query", body.query);
  assertFilters("$.filters", body.filters);
  assertTimeRange("$", body.timeFrom, body.timeTo);
  if (body.display.displayTimezone) {
    assertIanaTimezone("$.display.displayTimezone", body.display.displayTimezone);
  }
  if (body.contextBefore > WORKBENCH_LIMITS.maxContextLines) {
    throw new ContractViolation("$.contextBefore", "exceeds the context cap");
  }
  if (body.contextAfter > WORKBENCH_LIMITS.maxContextLines) {
    throw new ContractViolation("$.contextAfter", "exceeds the context cap");
  }
  return body;
}

export function workbenchShareSafeToken(
  investigationId: string,
  locator: WorkbenchLocatorV1,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        investigationId,
        evidenceId: locator.evidenceId,
        digestAtBind: locator.digestAtBind,
        byteOffset: locator.byteOffset,
        lineNumber: locator.lineNumber,
        corpusRevision: locator.corpusRevision,
      }),
      "utf8",
    )
    .digest("hex");
}

export function parseWorkbenchBookmark(raw: unknown): WorkbenchBookmarkV1 {
  checkObject("$", bookmarkShape, raw);
  const body = raw as WorkbenchBookmarkV1;
  requireUuid("$.id", body.id);
  requireUuid("$.investigationId", body.investigationId);
  requireUuid("$.locator.evidenceId", body.locator.evidenceId);
  requireDigest("$.locator.digestAtBind", body.locator.digestAtBind);
  requireDigest("$.shareSafeToken", body.shareSafeToken);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  if (body.note.length > WORKBENCH_LIMITS.maxNoteChars) {
    throw new ContractViolation("$.note", "is too long");
  }
  const expected = workbenchShareSafeToken(body.investigationId, body.locator);
  if (body.shareSafeToken !== expected) {
    throw new ContractViolation("$.shareSafeToken", "does not match the bound locator");
  }
  if (body.status === "resolved" && body.staleReason !== null) {
    throw new ContractViolation("$.staleReason", "resolved bookmarks have no stale reason");
  }
  if (body.status !== "resolved" && !body.staleReason) {
    throw new ContractViolation("$.staleReason", "stale locators must explain why");
  }
  return body;
}

export function parseWorkbenchShareSafeLocator(
  raw: unknown,
): WorkbenchShareSafeLocatorV1 {
  checkObject("$", shareSafeLocatorShape, raw);
  const body = raw as WorkbenchShareSafeLocatorV1;
  requireDigest("$.token", body.token);
  return body;
}

export function parseWorkbenchLocatorResolve(raw: unknown): WorkbenchLocatorResolveV1 {
  checkObject("$", locatorResolveShape, raw);
  const body = raw as WorkbenchLocatorResolveV1;
  if (body.status === "not_found") {
    if (body.found) throw new ContractViolation("$.found", "not_found cannot be found");
    if (body.relativePath !== null || body.lineNumber !== null || body.investigationId !== null) {
      throw new ContractViolation("$", "not_found must not disclose path, line, or investigation");
    }
  }
  if (body.found && body.status === "not_found") {
    throw new ContractViolation("$.status", "found results cannot be not_found");
  }
  return body;
}

export function parseWorkbenchTimestampCandidate(
  raw: unknown,
): WorkbenchTimestampCandidateV1 {
  checkObject("$", candidateShape, raw);
  const body = raw as WorkbenchTimestampCandidateV1;
  requireUuid("$.evidenceId", body.evidenceId);
  if (body.parseClass === "explicit_offset" && !body.explicitOffset) {
    throw new ContractViolation("$.explicitOffset", "explicit-offset candidates must keep the offset text");
  }
  if (body.parseClass === "local_ambiguous" && body.explicitOffset) {
    throw new ContractViolation("$.explicitOffset", "ambiguous local times must not smuggle an offset");
  }
  if (body.parseClass === "local_ambiguous" && !body.confidenceUnknownReason) {
    throw new ContractViolation(
      "$.confidenceUnknownReason",
      "ambiguous local times must stay unexplained as a zone",
    );
  }
  return body;
}

export function parseWorkbenchReviewRule(raw: unknown): WorkbenchReviewRuleV1 {
  checkObject("$", reviewRuleShape, raw);
  const body = raw as WorkbenchReviewRuleV1;
  assertIanaTimezone("$.ianaTimezone", body.ianaTimezone);
  requireKey("$.idempotencyKey", body.idempotencyKey);
  if (body.scope === "source" && !body.source) {
    throw new ContractViolation("$.source", "source-scoped rules must name the source");
  }
  if (body.scope === "rotation_family" && !body.rotationFamily) {
    throw new ContractViolation("$.rotationFamily", "family-scoped rules must name the family");
  }
  if (body.scope === "selected_items" && body.selectedEvidenceIds.length === 0) {
    throw new ContractViolation("$.selectedEvidenceIds", "selected-item rules must list items");
  }
  return body;
}

export function parseWorkbenchReviewPreview(raw: unknown): WorkbenchReviewPreviewV1 {
  checkObject("$", reviewPreviewShape, raw);
  const body = raw as WorkbenchReviewPreviewV1;
  assertIanaTimezone("$.ianaTimezone", body.ianaTimezone);
  if (body.affectedEvidenceIds.length !== body.affectedRelativePaths.length) {
    throw new ContractViolation("$.affectedRelativePaths", "must list one path per affected item");
  }
  if (body.affectedRecordCount < body.affectedEvidenceIds.length) {
    throw new ContractViolation("$.affectedRecordCount", "cannot be smaller than the item list");
  }
  return body;
}

export function parseWorkbenchChronology(raw: unknown): WorkbenchChronologyV1 {
  checkObject("$", chronologyShape, raw);
  const body = raw as WorkbenchChronologyV1;
  if (body.events.length > WORKBENCH_LIMITS.maxPageRows) {
    throw new ContractViolation("$.events", "exceeds the page cap");
  }
  if (body.atLeast < body.events.length) {
    throw new ContractViolation("$.atLeast", "must be at least the returned event count");
  }
  for (const [index, event] of body.events.entries()) {
    if (
      event.correlationKind === "heuristic_similarity"
      && event.adjacencyReason.toLowerCase().includes("ground truth")
    ) {
      throw new ContractViolation(
        `$.events[${index}].adjacencyReason`,
        "heuristic similarity cannot claim ground truth",
      );
    }
    if (event.anchorStatus === "human_ground_truth" && event.correlationKind === "heuristic_similarity") {
      throw new ContractViolation(
        `$.events[${index}].anchorStatus`,
        "heuristic similarity cannot be recorded as ground truth",
      );
    }
  }
  return body;
}

export function privacySafeNotFound(): WorkbenchLocatorResolveV1 {
  return {
    schemaId: WORKBENCH_LOCATOR_RESOLVE_SCHEMA_ID,
    found: false,
    status: "not_found",
    staleReason: null,
    relativePath: null,
    lineNumber: null,
    investigationId: null,
  };
}

export function resolveLocatorAgainstEvidence(
  locator: WorkbenchLocatorV1,
  current: {
    digest: string;
    lineNumber: number;
    byteOffset: number;
    lineCount: number;
  } | null,
): { status: WorkbenchBookmarkStatus; staleReason: string | null } {
  if (!current) {
    return {
      status: "unresolvable",
      staleReason: "The evidence this bookmark named is no longer in the investigation.",
    };
  }
  if (current.digest !== locator.digestAtBind) {
    return {
      status: "stale",
      staleReason:
        "The file bytes changed after this bookmark was made, so the line was not moved.",
    };
  }
  if (locator.lineNumber > current.lineCount || locator.lineNumber < 1) {
    return {
      status: "unresolvable",
      staleReason: "The saved line number is outside the current file.",
    };
  }
  if (current.byteOffset !== locator.byteOffset && current.lineNumber !== locator.lineNumber) {
    return {
      status: "stale",
      staleReason: "The saved byte and line locators no longer agree with the file.",
    };
  }
  return { status: "resolved", staleReason: null };
}

function lineMatches(
  line: WorkbenchLine,
  request: WorkbenchSearchRequestV1,
  matcher: (haystack: string) => boolean,
): boolean {
  const filters = request.filters;
  if (filters.evidenceIds.length > 0 && !filters.evidenceIds.includes(line.evidenceId)) {
    return false;
  }
  if (filters.file && filters.file !== line.relativePath) return false;
  if (filters.rotationFamily && filters.rotationFamily !== line.rotationFamily) return false;
  if (filters.severity && filters.severity.toLowerCase() !== (line.severity ?? "").toLowerCase()) {
    return false;
  }
  if (
    filters.component
    && filters.component.toLowerCase() !== (line.component ?? "").toLowerCase()
  ) {
    return false;
  }
  const haystack = line.text;
  for (const term of filters.excludeTerms) {
    if (term && haystack.toLowerCase().includes(term.toLowerCase())) return false;
  }
  for (const term of filters.includeTerms) {
    if (term && !haystack.toLowerCase().includes(term.toLowerCase())) return false;
  }
  if (request.query && !matcher(haystack)) return false;
  return true;
}

function compileMatcher(request: WorkbenchSearchRequestV1): (haystack: string) => boolean {
  if (!request.query) return () => true;
  if (request.mode === "literal") {
    return (haystack) => haystack.includes(request.query);
  }
  if (request.mode === "case_insensitive") {
    const needle = request.query.toLowerCase();
    return (haystack) => haystack.toLowerCase().includes(needle);
  }
  assertSafeRegex("$.query", request.query);
  const regex = new RegExp(request.query, "u");
  return (haystack) => regex.test(haystack);
}

/**
 * Compare a line against the requested window as *instants*. The bounds have
 * already been refused unless they parse, so no textual comparison and no
 * guessed zone can reach this point.
 */
function applyTimeFilter(
  line: WorkbenchLine,
  window: { from: number | null; to: number | null } | null,
): { keep: boolean; unresolved: boolean } {
  if (!window) return { keep: true, unresolved: false };
  if (!line.normalizedUtc) return { keep: false, unresolved: true };
  const instant = Date.parse(line.normalizedUtc);
  if (Number.isNaN(instant)) return { keep: false, unresolved: true };
  if (window.from !== null && instant < window.from) return { keep: false, unresolved: false };
  if (window.to !== null && instant > window.to) return { keep: false, unresolved: false };
  return { keep: true, unresolved: false };
}

/** Why a scan stopped. `complete` is the only one that means "all of it". */
export type WorkbenchScanStop = "complete" | "budget" | "cancelled";

export interface WorkbenchScanResume {
  /** Matches counted strictly before the resume position. */
  matchOrdinal: number;
  /** Lines scanned by every page before this one. */
  scannedLines: number;
  /** File the resume lands in. */
  evidenceId: string;
  /** First line to evaluate. Earlier rows of that file only feed context. */
  lineNumber: number;
}

export interface WorkbenchSearchScanOptions {
  cancelled?: () => boolean;
  /** Lines this page may scan before it must stop and hand back a cursor. */
  scanBudgetLines?: number;
  resume?: WorkbenchScanResume | null;
}

export interface WorkbenchScanResumePoint {
  evidenceId: string;
  lineNumber: number;
  matchOrdinal: number;
  scannedLines: number;
}

export interface WorkbenchSearchScanFinish {
  scopeFileCount: number;
  /** Bytes the reader could not obtain, so the scan cannot be resumed past them. */
  corpusUnreadable?: boolean;
  timeAuthorityUnavailableReason?: string | null;
  expectedNormalizationRevision?: number | null;
  /** False for callers with no corpus behind them to resume into. */
  offerResume?: boolean;
  mintCursor?: (point: WorkbenchScanResumePoint) => string;
}

/**
 * A search that consumes the corpus in bounded windows and can stop anywhere.
 *
 * The scan holds at most one window of rows, the requested context lines, and
 * the matches this page will return — never the corpus. When it stops early it
 * reports the exact position it stopped at, so the next page resumes on the
 * next unscanned line rather than re-deriving a position from a match count.
 */
export interface WorkbenchSearchScan {
  /** Feed the next window, in corpus order. Returns false once the scan is done. */
  feed(rows: readonly WorkbenchLine[]): boolean;
  /** No more rows for the current file; drop its context window. */
  endFile(): void;
  /** Every file in scope was fed to its last line. */
  markComplete(): void;
  readonly stop: WorkbenchScanStop | null;
  readonly scannedLines: number;
  finish(input: WorkbenchSearchScanFinish): WorkbenchSearchResultV1;
}

export function createLogSearchScan(
  request: WorkbenchSearchRequestV1,
  options: WorkbenchSearchScanOptions = {},
): WorkbenchSearchScan {
  parseWorkbenchSearchRequest(request);
  const matcher = compileMatcher(request);
  const resume = options.resume ?? null;
  const budget = Math.max(1, options.scanBudgetLines ?? WORKBENCH_LIMITS.maxSearchWorkLines);
  // With a position cursor every match found from here is this page's to
  // return. Only an ordinal cursor still has to walk past matches it already
  // handed out.
  const start = resume ? resume.matchOrdinal : request.cursor;
  const timeFilterApplied = Boolean(request.filters.timeFrom || request.filters.timeTo);
  const window = timeFilterApplied
    ? {
        from: request.filters.timeFrom
          ? parseRangeInstant("$.filters.timeFrom", request.filters.timeFrom)
          : null,
        to: request.filters.timeTo
          ? parseRangeInstant("$.filters.timeTo", request.filters.timeTo)
          : null,
      }
    : null;

  const emitted: WorkbenchMatchV1[] = [];
  const pending: { match: WorkbenchMatchV1; remaining: number }[] = [];
  let contextRing: WorkbenchLine[] = [];
  let ringFile: string | null = null;
  let matchOrdinal = resume ? resume.matchOrdinal : 0;
  let scanned = 0;
  let unresolvedInWindow = 0;
  let stop: WorkbenchScanStop | null = null;
  let lastScanned: { evidenceId: string; lineNumber: number } | null = null;
  let lastEmit: WorkbenchScanResumePoint | null = null;

  const resetContext = (evidenceId: string) => {
    if (ringFile === evidenceId) return;
    ringFile = evidenceId;
    contextRing = [];
    pending.length = 0;
  };

  function consume(line: WorkbenchLine): boolean {
    if (options.cancelled?.()) {
      stop = "cancelled";
      return false;
    }
    resetContext(line.evidenceId);
    // A resumed page reads a short lead-in so the first match still shows the
    // lines above it. Those rows are context only: matching or counting them
    // again would return a match this reader has already been given.
    const contextOnly =
      resume !== null
      && line.evidenceId === resume.evidenceId
      && line.lineNumber < resume.lineNumber;
    if (contextOnly) {
      contextRing.push(line);
      if (contextRing.length > request.contextBefore) contextRing.shift();
      return true;
    }
    if (scanned >= budget) {
      stop = "budget";
      return false;
    }
    scanned += 1;
    lastScanned = { evidenceId: line.evidenceId, lineNumber: line.lineNumber };

    for (const entry of pending) {
      if (entry.remaining > 0) {
        entry.match.contextAfter.push(line.text);
        entry.remaining -= 1;
      }
    }

    const time = applyTimeFilter(line, window);
    if (time.unresolved) unresolvedInWindow += 1;
    if (time.keep && lineMatches(line, request, matcher)) {
      matchOrdinal += 1;
      if (matchOrdinal > start) {
        if (emitted.length < request.limit) {
          const match: WorkbenchMatchV1 = {
            evidenceId: line.evidenceId,
            relativePath: line.relativePath,
            rotationFamily: line.rotationFamily,
            lineNumber: line.lineNumber,
            byteOffset: line.byteOffset,
            text: line.text,
            wrapped: line.wrapped,
            originalTimestamp: line.originalTimestamp,
            normalizedUtc: line.normalizedUtc,
            parseClass: line.parseClass,
            contextBefore: contextRing.map((row) => row.text),
            contextAfter: [],
          };
          emitted.push(match);
          if (request.contextAfter > 0) {
            pending.push({ match, remaining: request.contextAfter });
          }
          lastEmit = {
            evidenceId: line.evidenceId,
            lineNumber: line.lineNumber,
            matchOrdinal,
            scannedLines: (resume?.scannedLines ?? 0) + scanned,
          };
        }
      }
    }

    contextRing.push(line);
    if (contextRing.length > request.contextBefore) contextRing.shift();
    return true;
  }

  return {
    get stop() {
      return stop;
    },
    get scannedLines() {
      return scanned;
    },
    feed(rows) {
      if (stop !== null) return false;
      for (const row of rows) {
        if (!consume(row)) return false;
      }
      return true;
    },
    endFile() {
      ringFile = null;
      contextRing = [];
      pending.length = 0;
    },
    markComplete() {
      if (stop === null) stop = "complete";
    },
    finish(input) {
      const cancelled = stop === "cancelled";
      const complete = stop === "complete";
      const unreadable = input.corpusUnreadable === true;
      const atLeast = Math.max(matchOrdinal, emitted.length);
      const moreMatchesHere = atLeast > start + emitted.length;
      const coverageComplete = complete && !unreadable;
      // A page that spent its budget is not a truncated corpus: it stopped at a
      // position it can resume from. Truncation is reserved for a scan that
      // stopped and cannot continue, which is the only case where "no matches"
      // could still be hiding something.
      const resumable =
        input.offerResume !== false
        && typeof input.mintCursor === "function"
        && !cancelled
        && !unreadable
        && (!complete || moreMatchesHere);
      let point: WorkbenchScanResumePoint | null = null;
      if (resumable) {
        point = lastEmit
          ? {
              evidenceId: lastEmit.evidenceId,
              lineNumber: lastEmit.lineNumber + 1,
              matchOrdinal: lastEmit.matchOrdinal,
              scannedLines: lastEmit.scannedLines,
            }
          : lastScanned
            ? {
                evidenceId: lastScanned.evidenceId,
                lineNumber: lastScanned.lineNumber + 1,
                matchOrdinal,
                scannedLines: (resume?.scannedLines ?? 0) + scanned,
              }
            : resume
              ? {
                  evidenceId: resume.evidenceId,
                  lineNumber: resume.lineNumber,
                  matchOrdinal: resume.matchOrdinal,
                  scannedLines: resume.scannedLines,
                }
              : null;
      }
      const nextPageCursor = point === null ? null : input.mintCursor!(point);
      return parseWorkbenchSearchResult({
        schemaId: WORKBENCH_SEARCH_RESULT_SCHEMA_ID,
        matches: emitted,
        returned: emitted.length,
        bounded: cancelled || unreadable || !complete || atLeast > emitted.length,
        atLeast,
        // Unchanged meaning: a match ordinal, offered only when advancing it can
        // reach a match this page did not return.
        nextCursor: !cancelled && moreMatchesHere ? start + emitted.length : null,
        nextPageCursor,
        cancelled,
        corpusTruncated: !coverageComplete && nextPageCursor === null,
        coverageComplete,
        scannedLines: scanned,
        scannedLinesTotal: (resume?.scannedLines ?? 0) + scanned,
        scopeFileCount: input.scopeFileCount,
        timeFilterApplied,
        timeFilterUnknownReason:
          unresolvedInWindow > 0
            ? unresolvedInWindow === 1
              ? "1 line was left out of this time range because it has no normalized timestamp yet. Declare a timezone in Timezone review to place it."
              : `${unresolvedInWindow.toLocaleString()} lines were left out of this time range because they have no normalized timestamp yet. Declare a timezone in Timezone review to place them.`
            : null,
        timeAuthorityUnavailableReason: input.timeAuthorityUnavailableReason ?? null,
        expectedNormalizationRevision:
          input.expectedNormalizationRevision !== undefined
            ? input.expectedNormalizationRevision
            : request.expectedNormalizationRevision,
      });
    },
  };
}

/**
 * Search an already-materialized array of lines.
 *
 * Kept for callers that legitimately hold a small corpus in memory (a single
 * file page, a fixture). Anything corpus-sized must drive `createLogSearchScan`
 * with windows instead, so the rows never all exist at once.
 */
export function searchLogLines(
  lines: readonly WorkbenchLine[],
  request: WorkbenchSearchRequestV1,
  options: { cancelled?: () => boolean; corpusTruncated?: boolean } = {},
): WorkbenchSearchResultV1 {
  const scan = createLogSearchScan(request, {
    ...(options.cancelled ? { cancelled: options.cancelled } : {}),
  });
  let file: string | null = null;
  let buffer: WorkbenchLine[] = [];
  let stopped = false;
  const flush = () => {
    if (buffer.length === 0) return true;
    const ok = scan.feed(buffer);
    buffer = [];
    return ok;
  };
  for (const line of lines) {
    if (file !== null && line.evidenceId !== file) {
      if (!flush()) {
        stopped = true;
        break;
      }
      scan.endFile();
    }
    file = line.evidenceId;
    buffer.push(line);
    if (buffer.length >= WORKBENCH_LIMITS.corpusWindowLines && !flush()) {
      stopped = true;
      break;
    }
  }
  if (!stopped && flush()) scan.markComplete();
  // This entry point has no corpus behind it to resume into, so it never offers
  // a cursor: a scan that stopped short here really is a truncated answer.
  return scan.finish({
    scopeFileCount: new Set(lines.map((line) => line.evidenceId)).size,
    ...(options.corpusTruncated === true ? { corpusUnreadable: true } : {}),
    offerResume: false,
  });
}

export function pageLogLines(
  lines: readonly WorkbenchLine[],
  evidenceId: string,
  startLine: number,
  limit: number,
): WorkbenchPageV1 {
  const windowLimit = Math.min(Math.max(limit, 1), WORKBENCH_LIMITS.maxPageRows);
  const owned = lines.filter((line) => line.evidenceId === evidenceId);
  const start = Math.max(1, startLine);
  const slice = owned.filter((line) => line.lineNumber >= start).slice(0, windowLimit);
  const last = slice.at(-1)?.lineNumber ?? start;
  const more = owned.some((line) => line.lineNumber > last);
  return {
    schemaId: WORKBENCH_PAGE_SCHEMA_ID,
    evidenceId,
    relativePath: slice[0]?.relativePath ?? "",
    rotationFamily: slice[0]?.rotationFamily ?? "",
    startLine: start,
    rows: slice.map((line) => ({
      evidenceId: line.evidenceId,
      relativePath: line.relativePath,
      rotationFamily: line.rotationFamily,
      lineNumber: line.lineNumber,
      byteOffset: line.byteOffset,
      text: line.text,
      wrapped: line.wrapped,
      originalTimestamp: line.originalTimestamp,
      normalizedUtc: line.normalizedUtc,
      parseClass: line.parseClass,
      contextBefore: [],
      contextAfter: [],
    })),
    wrappedRowCount: slice.filter((line) => line.wrapped).length,
    nextStartLine: more ? last + 1 : null,
    // `bounded` means "rows follow this window". A final page is not bounded,
    // so the reader is never warned about more lines that do not exist.
    bounded: more,
  };
}

export function virtualizedWindow(input: {
  totalRows: number;
  scrollTop: number;
  rowHeight: number;
  viewportHeight: number;
  overscan: number;
}): { start: number; end: number; resident: number } {
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = Math.max(0, input.overscan);
  const start = Math.max(0, Math.floor(input.scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(input.viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(input.totalRows, start + visible);
  return { start, end, resident: Math.max(0, end - start) };
}

export function previewReviewRule(
  rule: WorkbenchReviewRuleV1,
  items: readonly {
    evidenceId: string;
    relativePath: string;
    rotationFamily: string;
    parseClass: TimestampParseClass;
  }[],
): WorkbenchReviewPreviewV1 {
  parseWorkbenchReviewRule(rule);
  const notes: string[] = [];
  const affected = items.filter((item) => {
    if (rule.scope === "source") return item.relativePath === rule.source;
    if (rule.scope === "rotation_family") return item.rotationFamily === rule.rotationFamily;
    return rule.selectedEvidenceIds.includes(item.evidenceId);
  });
  const ambiguous = affected.filter((item) => item.parseClass === "local_ambiguous");
  if (ambiguous.length === 0) {
    notes.push("No ambiguous local timestamps are in this scope.");
  }
  notes.push(
    `This rule would affect ${affected.length} evidence item${affected.length === 1 ? "" : "s"}. It will not be applied to the rest of the corpus.`,
  );
  return parseWorkbenchReviewPreview({
    schemaId: WORKBENCH_REVIEW_PREVIEW_SCHEMA_ID,
    ianaTimezone: rule.ianaTimezone,
    expectedRevision: rule.expectedRevision,
    affectedEvidenceIds: affected.map((item) => item.evidenceId),
    affectedRelativePaths: affected.map((item) => item.relativePath),
    affectedRecordCount: affected.length,
    refusedGuess: false,
    notes,
  });
}

export function groupReviewQueue(
  candidates: readonly WorkbenchTimestampCandidateV1[],
): { key: string; scope: ReviewRuleScope; items: WorkbenchTimestampCandidateV1[] }[] {
  const groups = new Map<string, WorkbenchTimestampCandidateV1[]>();
  for (const candidate of candidates) {
    const key = candidate.rotationFamily || candidate.relativePath;
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    scope: items[0]?.rotationFamily === key ? "rotation_family" : "source",
    items,
  }));
}

const REQUEST_ID =
  /\b(?:(?:req|request|trace|session|order)[-_]?id[=: ]|(?:rid|trace)[-_])([A-Za-z0-9._-]{4,64})/i;

export function observedCorrelationId(text: string): string | null {
  const match = text.match(REQUEST_ID);
  return match?.[1] ?? null;
}

export function mergeChronology(
  lines: readonly WorkbenchLine[],
  grouping: WorkbenchGrouping,
  expectedNormalizationRevision: number | null,
  anchors: ReadonlyMap<string, ChronologyAnchorStatus> = new Map(),
  options: { corpusTruncated?: boolean } = {},
): WorkbenchChronologyV1 {
  const sortable = [...lines];
  sortable.sort((left, right) => {
    const leftGroup = groupingKeyOf(left, grouping);
    const rightGroup = groupingKeyOf(right, grouping);
    if (leftGroup !== rightGroup) return leftGroup.localeCompare(rightGroup);
    if (left.normalizedUtc && right.normalizedUtc) {
      if (left.normalizedUtc !== right.normalizedUtc) {
        return left.normalizedUtc < right.normalizedUtc ? -1 : 1;
      }
    } else if (left.normalizedUtc) return -1;
    else if (right.normalizedUtc) return 1;
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }
    return left.lineNumber - right.lineNumber;
  });
  const bounded =
    sortable.length > WORKBENCH_LIMITS.maxPageRows || options.corpusTruncated === true;
  const window = sortable.slice(0, WORKBENCH_LIMITS.maxPageRows);
  const events: WorkbenchChronologyEventV1[] = window.map((line, index) => {
    const previous = window[index - 1];
    const groupKey = groupingKeyOf(line, grouping);
    const previousKey = previous ? groupingKeyOf(previous, grouping) : null;
    const uncertainty: string[] = [];
    if (!line.normalizedUtc) uncertainty.push("no usable timestamp");
    if (line.parseClass === "local_ambiguous" && !line.normalizedUtc) {
      uncertainty.push("ambiguous local time");
    }
    if (
      previous?.normalizedUtc
      && line.normalizedUtc
      && line.normalizedUtc < previous.normalizedUtc
      && previousKey === groupKey
    ) {
      uncertainty.push("impossible ordering against the previous row");
    }
    const observed = observedCorrelationId(line.text);
    let adjacencyReason = "Ingest order in the same investigation.";
    if (previousKey === groupKey && grouping !== "none") {
      adjacencyReason = `Adjacent in the same ${grouping.replace("_", " ")} group (${groupKey}).`;
    } else if (previous && previous.normalizedUtc && line.normalizedUtc) {
      adjacencyReason = "Adjacent because their normalized UTC instants are consecutive in this window.";
    } else if (previous && previous.relativePath === line.relativePath) {
      adjacencyReason = "Adjacent because they are neighboring lines in the same file.";
    }
    const anchorStatus =
      anchors.get(chronologyAnchorKey(line.evidenceId, line.lineNumber)) ?? null;
    return {
      evidenceId: line.evidenceId,
      relativePath: line.relativePath,
      rotationFamily: line.rotationFamily,
      lineNumber: line.lineNumber,
      originalTimestamp: line.originalTimestamp,
      normalizedUtc: line.normalizedUtc,
      displayTime: line.normalizedUtc,
      severity: line.severity,
      component: line.component,
      intakeBatchId: line.intakeBatchId,
      groupKey,
      adjacencyReason,
      uncertainty,
      correlationKind: observed ? "observed_identifier" : "none",
      correlationId: observed,
      anchorStatus,
      excerpt: line.text.slice(0, 240),
    };
  });
  // The buckets are disjoint so their counts can be added without counting the
  // same line twice: an ambiguous local time is a timezone unknown, not also a
  // missing-timestamp unknown.
  const ambiguous = lines.filter(
    (line) => line.parseClass === "local_ambiguous" && !line.normalizedUtc,
  ).length;
  const missing = lines.filter(
    (line) => !line.normalizedUtc && line.parseClass !== "local_ambiguous",
  ).length;
  const unknownBuckets: WorkbenchUnknownBucketV1[] = [];
  if (missing > 0) {
    unknownBuckets.push({
      category: "timestamps",
      count: missing,
      detail: `${missing} line${missing === 1 ? " has" : "s have"} no recognizable timestamp and stay in the order they arrived.`,
    });
  }
  if (ambiguous > 0) {
    unknownBuckets.push({
      category: "timezone",
      count: ambiguous,
      detail: `${ambiguous} line${ambiguous === 1 ? " has a local time" : "s have local times"} with no declared zone. Declare one in Timezone review; nothing here guesses.`,
    });
  }
  if (options.corpusTruncated) {
    unknownBuckets.push({
      category: "corpus",
      count: 1,
      detail:
        "This investigation has more log lines than one chronology can read, so lines past the read limit are not represented here. Narrow the selected files to see the rest.",
    });
  }
  return parseWorkbenchChronology({
    schemaId: WORKBENCH_CHRONOLOGY_SCHEMA_ID,
    grouping,
    events,
    bounded,
    atLeast: lines.length,
    unknownBuckets,
    expectedNormalizationRevision,
  });
}

/** One log file's identity, without its bytes. */
export interface WorkbenchFileIdentity {
  evidenceId: string;
  relativePath: string;
  digest: string;
  intakeBatchId: string | null;
}

const SEVERITY_RE = /\b(ERROR|WARN|WARNING|INFO|DEBUG|FATAL|TRACE)\b/i;

function buildLine(
  file: WorkbenchFileIdentity,
  family: string,
  component: string,
  lineNumber: number,
  byteOffset: number,
  raw: string,
): WorkbenchLine {
  const truncated = truncateLine(raw);
  const shape = classifyTimestampShape(raw);
  const severityMatch = raw.match(SEVERITY_RE);
  return {
    evidenceId: file.evidenceId,
    relativePath: file.relativePath,
    rotationFamily: family,
    intakeBatchId: file.intakeBatchId,
    lineNumber,
    byteOffset,
    text: truncated.text,
    wrapped: truncated.wrapped,
    severity: severityMatch?.[1]?.toLowerCase() ?? null,
    component,
    originalTimestamp: shape.originalText,
    normalizedUtc: shape.parseClass === "explicit_offset"
      ? normalizeExplicitUtc(shape.originalText)
      : null,
    parseClass: shape.parseClass,
    digest: file.digest,
  };
}

/**
 * Walk one file's text as bounded windows of rows.
 *
 * The whole point is that nothing here ever holds the file's rows all at once:
 * a caller searching a 200,000-line file sees it `windowLines` at a time and
 * can drop each window before asking for the next. Line numbering and byte
 * offsets are identical to reading the file in one piece, so a locator bound
 * from a windowed read and one bound from a whole read name the same line.
 *
 * `startLine` skips ahead without allocating the rows before it, which is how
 * a resumed page picks up where the previous one stopped.
 */
export function* iterateLogLineWindows(
  file: WorkbenchFileIdentity,
  text: string,
  options: { windowLines?: number; startLine?: number } = {},
): Generator<WorkbenchLine[], void, undefined> {
  const windowLines = Math.max(
    1,
    Math.min(options.windowLines ?? WORKBENCH_LIMITS.corpusWindowLines, WORKBENCH_LIMITS.corpusWindowLines),
  );
  const startLine = Math.max(1, options.startLine ?? 1);
  const family = rotationFamilyOf(file.relativePath);
  const component = family.split("/").pop() ?? family;
  let window: WorkbenchLine[] = [];
  let lineNumber = 0;
  let byteOffset = 0;
  let cursor = 0;

  // A file that ends with a newline has no extra line after it. Emitting the
  // trailing empty segment would add a phantom blank row to every pane and
  // report every line count one too high, so the last segment is held back
  // until we know whether anything follows it.
  let pending: string | null = null;
  let sawSeparator = false;

  const emit = function* (raw: string): Generator<WorkbenchLine[], void, undefined> {
    lineNumber += 1;
    if (lineNumber >= startLine) {
      window.push(buildLine(file, family, component, lineNumber, byteOffset, raw));
      if (window.length >= windowLines) {
        yield window;
        window = [];
      }
    }
    byteOffset += Buffer.byteLength(raw, "utf8") + 1;
  };

  while (cursor <= text.length) {
    const next = text.indexOf("\n", cursor);
    const end = next < 0 ? text.length : next;
    // Only a CR that a newline actually terminated is a line ending; a lone
    // CR is ordinary text and stays in the line, as a whole-file read leaves it.
    const hasCr = next >= 0 && end > cursor && text.charCodeAt(end - 1) === 13;
    const raw = text.slice(cursor, hasCr ? end - 1 : end);
    if (pending !== null) yield* emit(pending);
    pending = raw;
    if (next < 0) break;
    sawSeparator = true;
    cursor = next + 1;
  }
  if (pending !== null && !(sawSeparator && pending === "")) {
    yield* emit(pending);
  }
  if (window.length > 0) yield window;
}

/**
 * Count a file's lines without building a single row. Inventory needs the
 * count, not the content, and a corpus-sized allocation to answer "how many
 * lines" is exactly the cost this path exists to avoid.
 */
export function countLogTextLines(text: string): number {
  if (text.length === 0) return 1;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const next = text.indexOf("\n", cursor);
    if (next < 0) {
      // A trailing segment only counts when the file did not end on a newline.
      if (cursor < text.length) count += 1;
      return count === 0 ? 1 : count;
    }
    count += 1;
    cursor = next + 1;
  }
}

export function splitLogText(
  evidenceId: string,
  relativePath: string,
  digest: string,
  text: string,
  intakeBatchId: string | null,
): WorkbenchLine[] {
  const rows: WorkbenchLine[] = [];
  for (const window of iterateLogLineWindows(
    { evidenceId, relativePath, digest, intakeBatchId },
    text,
  )) {
    for (const row of window) rows.push(row);
  }
  return rows;
}

function normalizeExplicitUtc(original: string | null): string | null {
  if (!original) return null;
  const instant = Date.parse(original.replace(" ", "T"));
  if (Number.isNaN(instant)) return null;
  return new Date(instant).toISOString();
}

export function extractShapeCandidates(
  lines: readonly WorkbenchLine[],
): WorkbenchTimestampCandidateV1[] {
  const out: WorkbenchTimestampCandidateV1[] = [];
  for (const line of lines) {
    // A host-backed explicit timezone declaration may resolve a line whose
    // source text is still a local/ambiguous shape. It is no longer waiting
    // for review, so do not keep resurfacing it in the queue.
    if (line.parseClass === "missing" || line.normalizedUtc) continue;
    const shape = classifyTimestampShape(line.originalTimestamp ?? line.text);
    out.push({
      schemaId: WORKBENCH_TIMESTAMP_CANDIDATE_SCHEMA_ID,
      evidenceId: line.evidenceId,
      relativePath: line.relativePath,
      rotationFamily: line.rotationFamily,
      parserId: TIMESTAMP_SHAPE_PARSER_ID,
      parserVersion: TIMESTAMP_SHAPE_PARSER_VERSION,
      sourceOffset: line.byteOffset,
      sourceLine: line.lineNumber,
      originalText: shape.originalText ?? "",
      parseClass: shape.parseClass,
      precision: shape.parseClass === "date_only" ? "day" : "second",
      explicitOffset: shape.explicitOffset,
      confidenceUnknownReason: shape.unknownReason,
    });
  }
  return out;
}
