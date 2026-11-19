import { describe, expect, it } from "vitest";
import { parseLogFacets } from "./wireV1";

const legacy = { sources: { "app.log": 3 }, levels: {}, services: {}, hosts: {}, timeQuality: "mixed" };
const counts = { debugTrace: 0, info: 1, warn: 1, errorFatal: 0, unknown: 1 };
describe("source severity facet compatibility", () => {
  it("does not manufacture distributions for a legacy host", () => {
    expect(parseLogFacets(legacy)).not.toHaveProperty("sourceSeverityCounts");
  });
  it("preserves explicit unknown counts and zeroes", () => {
    const value = { ...legacy, sourceSeverityCounts: { "app.log": counts } };
    expect(parseLogFacets(value)).toBe(value);
  });
  it("rejects missing, extra, negative or fractional buckets", () => {
    for (const invalid of [{...counts, unknown: undefined}, {...counts, extra: 1}, {...counts, warn: -1}, {...counts, info: 0.5}]) {
      expect(() => parseLogFacets({ ...legacy, sourceSeverityCounts: { "app.log": invalid } })).toThrow();
    }
  });
});
