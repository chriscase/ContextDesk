import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixtureLoader";
import { parseExplorerEvent, parseEventPage, parseEventRowsPage } from "./wireV1";

const keys = ["severityNumber", "severityText", "sourceSeverity", "severityInferred", "provenance"] as const;
function legacy() {
  const value = structuredClone(loadFixture("explorer_event.v1.json")) as Record<string, unknown>;
  for (const key of keys) delete value[key];
  return value;
}

describe("V1 additive severity compatibility", () => {
  it("accepts an older event unchanged without inventing source evidence", () => {
    const value = legacy();
    expect(parseExplorerEvent(value)).toBe(value);
    for (const key of keys) expect(value).not.toHaveProperty(key);
  });
  it("refuses numeric source severity beyond the exact JavaScript wire domain", () => {
    const fixture = structuredClone(loadFixture("explorer_event.v1.json")) as Record<string, unknown>;
    for (const edge of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect(() => parseExplorerEvent({ ...fixture, sourceSeverity: edge, severityNumber: null, severityText: null, severityInferred: false, provenance: "ambiguous" })).not.toThrow();
    }
    expect(() => parseExplorerEvent({ ...fixture, sourceSeverity: JSON.parse("9007199254740993") })).toThrow();
  });
  it("accepts legacy events inside full and bounded pages", () => {
    for (const [fixture, parse] of [
      ["event_page.v1.json", parseEventPage],
      ["event_rows_page.v1.json", parseEventRowsPage],
    ] as const) {
      const page = structuredClone(loadFixture(fixture)) as Record<string, unknown>;
      page.events = [legacy()];
      expect(() => parse(page)).not.toThrow();
    }
  });
  it("rejects each partial metadata group rather than silently defaulting it", () => {
    for (const key of keys) {
      const value = { ...legacy(), [key]: key === "severityInferred" ? false : null };
      expect(() => parseExplorerEvent(value)).toThrow();
      const page = structuredClone(loadFixture("event_rows_page.v1.json")) as Record<string, unknown>;
      page.events = [value];
      expect(() => parseEventRowsPage(page)).toThrow();
    }
  });
  it("retains strict malformed-field and unknown-field rejection on legacy events", () => {
    expect(() => parseExplorerEvent({ ...legacy(), level: 30 })).toThrow();
    expect(() => parseExplorerEvent({ ...legacy(), unexpected: true })).toThrow();
  });
});
