/**
 * Occurred-at versus recorded-at.
 *
 * A War Room investigation outlives the session that opened it, and older
 * work is routinely written down long after it happened: an incident from
 * two years ago gets a case today, a hand-written on-call log is transcribed,
 * a system that was decommissioned before the tool existed is named as an
 * involved party. Two clocks therefore exist side by side and never collapse
 * into one:
 *
 * - `recordedAt` is the server clock at the moment the row was written. It is
 *   the audit clock. It is assigned by the server, never supplied by a
 *   caller, and never rewritten — not by an edit, not by a backfill.
 * - `occurredAt` is when the described thing actually happened. It is
 *   caller-supplied, may be absent, and may sit far in the past.
 *
 * Backfilling an older investigation therefore moves `occurredAt` only. Audit
 * history — `recordedAt`, audit rows, timeline sequence — keeps saying when
 * the record was made, so nothing has to be rewritten in order to describe
 * something that happened before this tool existed.
 *
 * ## Not guessing the time zone
 *
 * Someone reconstructing an old incident usually knows the date and often not
 * the offset: the note says "4 November 2024", and nobody now knows whether
 * that was written in UTC, in the reporter's local time, or in whatever the
 * log viewer displayed. Silently reading that as UTC invents a fact. So an
 * occurrence keeps the **literal text it was recorded with**, and states
 * separately whether that text carried an explicit offset:
 *
 *   "2024-11-04"                 zone unspecified, precision day
 *   "2024-11-04T09:30"           zone unspecified, precision minute
 *   "2024-11-04T09:30:00Z"       zone explicit,    precision second
 *   "2024-11-04T09:30:00+02:00"  zone explicit,    precision second (stored as UTC)
 *
 * Precision and zone are both *derived* from that text rather than supplied
 * beside it, so a caller has no way to describe an occurrence inconsistently.
 * A zone-unspecified value is never converted, never suffixed with `Z`, and
 * never displayed as though the offset were known. Ordering such values needs
 * some instant, and `occurredAtSortKey` produces one — explicitly labelled an
 * ordering approximation, never a display value.
 *
 * Scope note: this module validates, compares, and orders. It deliberately
 * owns no formatting and no local-time rendering; a displayed clock is a
 * presentation concern that lives elsewhere.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

/** Coarsest to finest, plus the honest absence. Derived, never supplied. */
export const OCCURRED_AT_PRECISIONS = [
  "year",
  "month",
  "day",
  "minute",
  "second",
  "unknown",
] as const;
export type OccurredAtPrecision = (typeof OCCURRED_AT_PRECISIONS)[number];

/** Whether the recorded text carried a usable UTC offset. */
export const OCCURRED_AT_ZONES = ["explicit", "unspecified"] as const;
export type OccurredAtZone = (typeof OCCURRED_AT_ZONES)[number];

export const OCCURRENCE_SCHEMA_ID = "cd-collab.occurrence.v1" as const;

/**
 * Names the timeline columns that already implement this pair. `clientTime`
 * is the caller-asserted occurrence; `serverTime` is the recorded clock.
 */
export const TIMELINE_OCCURRENCE_FIELDS = {
  occurredAt: "clientTime",
  recordedAt: "serverTime",
} as const;

/**
 * A record whose occurrence predates its recording by more than this is
 * reported as a backfill. The tolerance keeps ordinary "typed it just now"
 * writes — where a client clock trails the server by seconds — from being
 * labelled historical.
 */
export const BACKFILL_TOLERANCE_MS = 60_000;

/** Future occurrences are rejected; this much clock skew is still accepted. */
export const FUTURE_SKEW_TOLERANCE_MS = 5 * 60_000;

/** Nothing may claim to have occurred before this. Guards typo-years like 0202. */
export const EARLIEST_OCCURRED_AT = "1970-01-01T00:00:00.000Z" as const;

export interface OccurrenceV1 {
  /** Literal recorded text, or null when nobody has written it down. */
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  /** Always a full UTC instant. Server-assigned, never rewritten. */
  recordedAt: string;
}

const ZONED_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const YEAR_RE = /^(\d{4})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const SECOND_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?$/;

/** Largest real UTC offset in use. Anything wider is a typo, not a zone. */
const MAX_OFFSET_MINUTES = 14 * 60;

/**
 * Rejects calendar text that parses only because JavaScript rolls it over:
 * `2024-02-30` is not a late February, it is not a date at all. Component
 * checks are explicit so a nonexistent day, a 25th hour, or a 30-hour offset
 * fails instead of silently becoming a different instant.
 */
function assertRealCalendarParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  path: string,
): void {
  const { year, month, day, hour, minute, second } = parts;
  if (month < 1 || month > 12) throw new ContractViolation(path, "month is out of range");
  if (day < 1 || day > 31) throw new ContractViolation(path, "day is out of range");
  if (hour > 23) throw new ContractViolation(path, "hour is out of range");
  if (minute > 59) throw new ContractViolation(path, "minute is out of range");
  if (second > 59) throw new ContractViolation(path, "second is out of range");
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new ContractViolation(path, "that calendar date does not exist");
  }
}

function assertRealOffset(offset: string, path: string): void {
  if (offset === "Z") return;
  const sign = offset.startsWith("-") ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (minutes > 59) throw new ContractViolation(path, "offset minutes are out of range");
  if (Math.abs(sign * (hours * 60 + minutes)) > MAX_OFFSET_MINUTES) {
    throw new ContractViolation(path, "offset is out of range");
  }
}

/** True for a full ISO-8601 instant carrying an explicit offset. */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ZONED_INSTANT_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Canonical UTC form, so equal instants compare equal as strings. */
export function canonicalInstant(value: string): string {
  if (!isIsoInstant(value)) {
    throw new ContractViolation(
      "$.instant",
      "expected an ISO-8601 instant with an explicit offset",
    );
  }
  return new Date(value).toISOString();
}

export function isOccurredAtPrecision(value: unknown): value is OccurredAtPrecision {
  return typeof value === "string" && (OCCURRED_AT_PRECISIONS as readonly string[]).includes(value);
}

export function isOccurredAtZone(value: unknown): value is OccurredAtZone {
  return typeof value === "string" && (OCCURRED_AT_ZONES as readonly string[]).includes(value);
}

export interface NormalizedOccurredAt {
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
}

/** The absent occurrence. Meaningful: nobody has written this down yet. */
export const UNRECORDED_OCCURRENCE: NormalizedOccurredAt = {
  occurredAt: null,
  occurredAtPrecision: "unknown",
  occurredAtZone: "unspecified",
};

interface ClassifiedOccurredAt {
  precision: OccurredAtPrecision;
  zone: OccurredAtZone;
  /** The instant used for range checks and ordering, never for display. */
  approximateInstant: string;
  /** What gets stored: canonical UTC when zoned, the literal text otherwise. */
  stored: string;
}

function classify(text: string, path: string): ClassifiedOccurredAt {
  const zoned = ZONED_INSTANT_RE.exec(text);
  if (zoned) {
    assertRealCalendarParts(
      {
        year: Number(zoned[1]),
        month: Number(zoned[2]),
        day: Number(zoned[3]),
        hour: Number(zoned[4]),
        minute: Number(zoned[5]),
        second: Number(zoned[6]),
      },
      path,
    );
    assertRealOffset(zoned[8] as string, path);
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) {
      throw new ContractViolation(path, "not a real instant");
    }
    const canonical = new Date(parsed).toISOString();
    return {
      precision: "second",
      zone: "explicit",
      approximateInstant: canonical,
      stored: canonical,
    };
  }
  const partial: [RegExp, OccurredAtPrecision, string][] = [
    [SECOND_RE, "second", ""],
    [MINUTE_RE, "minute", ":00"],
    [DAY_RE, "day", "T00:00:00"],
    [MONTH_RE, "month", "-01T00:00:00"],
    [YEAR_RE, "year", "-01-01T00:00:00"],
  ];
  for (const [re, precision, suffix] of partial) {
    const match = re.exec(text);
    if (!match) continue;
    assertRealCalendarParts(
      {
        year: Number(match[1]),
        month: Number(match[2] ?? "1"),
        day: Number(match[3] ?? "1"),
        hour: Number(precision === "day" || precision === "month" || precision === "year" ? "0" : match[4]),
        minute: Number(precision === "day" || precision === "month" || precision === "year" ? "0" : match[5]),
        second: Number(precision === "second" ? (match[6] ?? "0") : "0"),
      },
      path,
    );
    // The Z here exists only to obtain a comparable instant. It is never
    // stored and never shown: `stored` keeps the caller's literal text.
    const approximate = `${text}${suffix}Z`;
    const parsed = Date.parse(approximate);
    if (!Number.isFinite(parsed)) {
      throw new ContractViolation(path, "not a real date");
    }
    return {
      precision,
      zone: "unspecified",
      approximateInstant: new Date(parsed).toISOString(),
      stored: text,
    };
  }
  throw new ContractViolation(
    path,
    "expected YYYY, YYYY-MM, YYYY-MM-DD, YYYY-MM-DDThh:mm, YYYY-MM-DDThh:mm:ss, or a full instant with an offset",
  );
}

/**
 * Fail-closed normalization of a caller-supplied occurrence.
 *
 * An absent occurrence is honest ignorance, not an error. Anything else must
 * be a recognised calendar form; precision and zone are derived from it so a
 * half-stated occurrence cannot exist. A caller that also sends the derived
 * fields must send values matching what the text says — the mismatch is a
 * contract violation rather than a silent correction.
 */
export function normalizeOccurredAt(
  input: { occurredAt?: unknown; occurredAtPrecision?: unknown; occurredAtZone?: unknown },
  options: { now?: string; path?: string } = {},
): NormalizedOccurredAt {
  const path = options.path ?? "$";
  const rawAt = input.occurredAt;

  if (rawAt === undefined || rawAt === null || (typeof rawAt === "string" && rawAt.trim() === "")) {
    if (
      input.occurredAtPrecision !== undefined &&
      input.occurredAtPrecision !== null &&
      input.occurredAtPrecision !== "unknown"
    ) {
      throw new ContractViolation(
        `${path}.occurredAtPrecision`,
        "a precision cannot be stated without an occurredAt",
      );
    }
    return { ...UNRECORDED_OCCURRENCE };
  }
  if (typeof rawAt !== "string") {
    throw new ContractViolation(`${path}.occurredAt`, "expected string");
  }

  const classified = classify(rawAt.trim(), `${path}.occurredAt`);

  if (
    input.occurredAtPrecision !== undefined &&
    input.occurredAtPrecision !== null &&
    input.occurredAtPrecision !== classified.precision
  ) {
    throw new ContractViolation(
      `${path}.occurredAtPrecision`,
      `precision is derived from occurredAt; expected ${classified.precision}`,
    );
  }
  if (
    input.occurredAtZone !== undefined &&
    input.occurredAtZone !== null &&
    input.occurredAtZone !== classified.zone
  ) {
    throw new ContractViolation(
      `${path}.occurredAtZone`,
      `zone is derived from occurredAt; expected ${classified.zone}`,
    );
  }

  const at = Date.parse(classified.approximateInstant);
  const now = options.now ? Date.parse(canonicalInstant(options.now)) : Date.now();
  if (at > now + FUTURE_SKEW_TOLERANCE_MS) {
    throw new ContractViolation(`${path}.occurredAt`, "occurredAt must not be in the future");
  }
  if (at < Date.parse(EARLIEST_OCCURRED_AT)) {
    throw new ContractViolation(
      `${path}.occurredAt`,
      `occurredAt must not precede ${EARLIEST_OCCURRED_AT}`,
    );
  }
  return {
    occurredAt: classified.stored,
    occurredAtPrecision: classified.precision,
    occurredAtZone: classified.zone,
  };
}

/**
 * An instant for range checks and sorting only.
 *
 * A zone-unspecified occurrence has no single true instant, so this pins it
 * to the start of its stated period read as UTC. That is an ordering
 * convention, not a claim about the clock — callers must not render it, and
 * `occurredAtZone` stays `unspecified` so the UI keeps saying so.
 */
export function occurredAtSortKey(occurrence: {
  occurredAt: string | null;
  recordedAt: string;
}): string {
  if (occurrence.occurredAt === null) return occurrence.recordedAt;
  try {
    return classify(occurrence.occurredAt, "$.occurredAt").approximateInstant;
  } catch {
    return occurrence.recordedAt;
  }
}

/**
 * Sort key for mixed historical and live records: what a reader means by
 * "when did this happen" is the occurrence when it is known, and the
 * recording clock only as a fallback. Never the other way round — falling
 * back first would file a backfilled 2019 incident under today.
 */
export function occurrenceOrderKey(occurrence: {
  occurredAt: string | null;
  recordedAt: string;
}): string {
  return occurredAtSortKey(occurrence);
}

/**
 * True when this row describes something that happened materially before it
 * was written down. Callers use it to label historical records honestly
 * instead of implying the work happened when the row appeared.
 */
export function isBackfilled(occurrence: {
  occurredAt: string | null;
  recordedAt: string;
}): boolean {
  if (occurrence.occurredAt === null) return false;
  const at = Date.parse(occurredAtSortKey(occurrence));
  const recorded = Date.parse(occurrence.recordedAt);
  if (!Number.isFinite(at) || !Number.isFinite(recorded)) return false;
  return recorded - at > BACKFILL_TOLERANCE_MS;
}

export const occurrenceShape: ObjectShape = {
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
  recordedAt: f.req(f.nstr),
};

/**
 * Validates a stored occurrence, including the cross-field consistency that
 * keeps a displayed date honest: a stored value must still classify to the
 * precision and zone recorded beside it.
 */
export function parseOccurrence(raw: unknown, path = "$"): OccurrenceV1 {
  checkObject(path, occurrenceShape, raw);
  const parsed = raw as OccurrenceV1;
  if (!isIsoInstant(parsed.recordedAt)) {
    throw new ContractViolation(`${path}.recordedAt`, "expected a full ISO-8601 instant");
  }
  assertOccurrenceFields(parsed, path);
  return parsed;
}

/**
 * Shared cross-field check for every row that carries an occurrence inline
 * rather than as a nested object.
 */
export function assertOccurrenceFields(
  row: {
    occurredAt: string | null;
    occurredAtPrecision: OccurredAtPrecision;
    occurredAtZone: OccurredAtZone;
  },
  path: string,
): void {
  if (row.occurredAt === null) {
    if (row.occurredAtPrecision !== "unknown") {
      throw new ContractViolation(
        `${path}.occurredAtPrecision`,
        "an absent occurredAt must record unknown precision",
      );
    }
    if (row.occurredAtZone !== "unspecified") {
      throw new ContractViolation(
        `${path}.occurredAtZone`,
        "an absent occurredAt has no time zone to record",
      );
    }
    return;
  }
  const classified = classify(row.occurredAt, `${path}.occurredAt`);
  if (classified.stored !== row.occurredAt) {
    throw new ContractViolation(
      `${path}.occurredAt`,
      "occurredAt must be stored in its canonical recorded form",
    );
  }
  if (classified.precision !== row.occurredAtPrecision) {
    throw new ContractViolation(
      `${path}.occurredAtPrecision`,
      `precision must match occurredAt; expected ${classified.precision}`,
    );
  }
  if (classified.zone !== row.occurredAtZone) {
    throw new ContractViolation(
      `${path}.occurredAtZone`,
      `zone must match occurredAt; expected ${classified.zone}`,
    );
  }
}
