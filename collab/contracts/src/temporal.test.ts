import { describe, expect, it } from "vitest";
import {
  BACKFILL_TOLERANCE_MS,
  EARLIEST_OCCURRED_AT,
  TIMELINE_OCCURRENCE_FIELDS,
  UNRECORDED_OCCURRENCE,
  canonicalInstant,
  isBackfilled,
  isIsoInstant,
  normalizeOccurredAt,
  occurredAtSortKey,
  occurrenceOrderKey,
  parseOccurrence,
} from "./temporal.js";

const NOW = "2026-05-01T12:00:00.000Z";

describe("occurred-at versus recorded-at", () => {
  it("treats an absent occurrence as honest ignorance, not an error", () => {
    expect(normalizeOccurredAt({}, { now: NOW })).toEqual(UNRECORDED_OCCURRENCE);
    expect(normalizeOccurredAt({ occurredAt: null }, { now: NOW })).toEqual(UNRECORDED_OCCURRENCE);
    expect(normalizeOccurredAt({ occurredAt: "  " }, { now: NOW })).toEqual(UNRECORDED_OCCURRENCE);
  });

  it("accepts an occurrence far in the past so older work can be backfilled", () => {
    expect(normalizeOccurredAt({ occurredAt: "2011-03-09" }, { now: NOW })).toEqual({
      occurredAt: "2011-03-09",
      occurredAtPrecision: "day",
      occurredAtZone: "unspecified",
    });
  });

  it("names the timeline columns that already carry the same pair", () => {
    expect(TIMELINE_OCCURRENCE_FIELDS).toEqual({
      occurredAt: "clientTime",
      recordedAt: "serverTime",
    });
  });
});

describe("not guessing the time zone", () => {
  it("keeps a date-only occurrence literal and marks the zone unspecified", () => {
    const normalized = normalizeOccurredAt({ occurredAt: "2024-11-04" }, { now: NOW });
    expect(normalized.occurredAt).toBe("2024-11-04");
    expect(normalized.occurredAtZone).toBe("unspecified");
    // The stored value is never silently promoted to an instant.
    expect(normalized.occurredAt).not.toContain("T");
    expect(normalized.occurredAt).not.toContain("Z");
  });

  it("derives precision from the recorded form", () => {
    const cases: [string, string][] = [
      ["2024", "year"],
      ["2024-11", "month"],
      ["2024-11-04", "day"],
      ["2024-11-04T09:30", "minute"],
      ["2024-11-04T09:30:00", "second"],
      ["2024-11-04T09:30:00Z", "second"],
    ];
    for (const [value, precision] of cases) {
      expect(normalizeOccurredAt({ occurredAt: value }, { now: NOW }).occurredAtPrecision).toBe(
        precision,
      );
    }
  });

  it("marks an explicit offset as explicit and stores it as UTC", () => {
    const normalized = normalizeOccurredAt(
      { occurredAt: "2024-11-04T09:30:00+02:00" },
      { now: NOW },
    );
    expect(normalized).toEqual({
      occurredAt: "2024-11-04T07:30:00.000Z",
      occurredAtPrecision: "second",
      occurredAtZone: "explicit",
    });
    expect(canonicalInstant("2024-11-04T09:30:00+02:00")).toBe("2024-11-04T07:30:00.000Z");
  });

  it("refuses a caller-supplied precision or zone that contradicts the text", () => {
    expect(() =>
      normalizeOccurredAt(
        { occurredAt: "2024-11-04", occurredAtPrecision: "second" },
        { now: NOW },
      ),
    ).toThrow(/precision is derived/);
    expect(() =>
      normalizeOccurredAt({ occurredAt: "2024-11-04", occurredAtZone: "explicit" }, { now: NOW }),
    ).toThrow(/zone is derived/);
    expect(() => normalizeOccurredAt({ occurredAtPrecision: "day" }, { now: NOW })).toThrow(
      /cannot be stated without an occurredAt/,
    );
  });

  it("rejects unparseable calendar text rather than coercing it", () => {
    for (const bad of ["yesterday", "04/11/2024", "2024-13-01", "2024-11-04 09:30", "2024-11-04T"]) {
      expect(() => normalizeOccurredAt({ occurredAt: bad }, { now: NOW })).toThrow();
    }
  });

  it("sorts zone-unspecified values without claiming an instant", () => {
    const key = occurredAtSortKey({ occurredAt: "2024-11-04", recordedAt: NOW });
    expect(key).toBe("2024-11-04T00:00:00.000Z");
    // The sort key is an ordering convention; the stored value keeps saying
    // the zone is unspecified.
    expect(normalizeOccurredAt({ occurredAt: "2024-11-04" }, { now: NOW }).occurredAtZone).toBe(
      "unspecified",
    );
  });
});

describe("range and backfill rules", () => {
  it("rejects a future occurrence beyond the accepted clock skew", () => {
    expect(() =>
      normalizeOccurredAt({ occurredAt: "2026-05-01T12:04:00Z" }, { now: NOW }),
    ).not.toThrow();
    expect(() =>
      normalizeOccurredAt({ occurredAt: "2026-05-02T12:00:00Z" }, { now: NOW }),
    ).toThrow(/must not be in the future/);
  });

  it("rejects an occurrence before the earliest representable instant", () => {
    expect(() => normalizeOccurredAt({ occurredAt: "0202" }, { now: NOW })).toThrow(
      /must not precede/,
    );
    expect(EARLIEST_OCCURRED_AT).toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects a bare date and a timestamp with no offset as full instants", () => {
    expect(isIsoInstant("2011-03-09")).toBe(false);
    expect(isIsoInstant("2011-03-09T04:30:00")).toBe(false);
    expect(isIsoInstant("2011-03-09T04:30:00Z")).toBe(true);
  });

  it("labels a record backfilled only when the gap is material", () => {
    expect(isBackfilled({ occurredAt: "2019-06-04", recordedAt: NOW })).toBe(true);
    expect(isBackfilled({ occurredAt: null, recordedAt: NOW })).toBe(false);
    const barelyEarlier = new Date(
      Date.parse(NOW) - Math.floor(BACKFILL_TOLERANCE_MS / 2),
    ).toISOString();
    expect(isBackfilled({ occurredAt: barelyEarlier, recordedAt: NOW })).toBe(false);
  });

  it("orders by when it happened, falling back to the recording clock", () => {
    expect(occurrenceOrderKey({ occurredAt: "2019-06-04", recordedAt: NOW })).toBe(
      "2019-06-04T00:00:00.000Z",
    );
    expect(occurrenceOrderKey({ occurredAt: null, recordedAt: NOW })).toBe(NOW);
  });
});

describe("stored occurrence pairs", () => {
  it("round-trips a backfilled, zone-unspecified pair", () => {
    const stored = {
      occurredAt: "2019-06-04",
      occurredAtPrecision: "day" as const,
      occurredAtZone: "unspecified" as const,
      recordedAt: NOW,
    };
    expect(parseOccurrence(stored)).toEqual(stored);
  });

  it("rejects drift between the stored text and its derived fields", () => {
    expect(() =>
      parseOccurrence({
        occurredAt: null,
        occurredAtPrecision: "unknown",
        occurredAtZone: "unspecified",
        recordedAt: NOW,
        backfilled: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseOccurrence({
        occurredAt: null,
        occurredAtPrecision: "day",
        occurredAtZone: "unspecified",
        recordedAt: NOW,
      }),
    ).toThrow(/must record unknown precision/);
    expect(() =>
      parseOccurrence({
        occurredAt: "2019-06-04",
        occurredAtPrecision: "second",
        occurredAtZone: "unspecified",
        recordedAt: NOW,
      }),
    ).toThrow(/precision must match/);
    expect(() =>
      parseOccurrence({
        occurredAt: "2019-06-04",
        occurredAtPrecision: "day",
        occurredAtZone: "explicit",
        recordedAt: NOW,
      }),
    ).toThrow(/zone must match/);
    expect(() =>
      parseOccurrence({
        occurredAt: null,
        occurredAtPrecision: "unknown",
        occurredAtZone: "unspecified",
        recordedAt: "soon",
      }),
    ).toThrow(/ISO-8601 instant/);
  });
});
