import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampMetricRange,
  downsampleMetricPoints,
  pointFallsInGap,
  validateOperationalMetricsDocument,
} from "./operationalMetrics";

const checkedInFixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/metrics/operational-metrics.v1.json",
    ),
    "utf8",
  ),
) as unknown;

describe("operational metrics schema", () => {
  it("accepts the checked-in Log Lab mixed-unit fixture as separate series", () => {
    const result = validateOperationalMetricsDocument(checkedInFixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid checked-in fixture");
    expect(result.data.series.map((series) => series.unit)).toEqual([
      "%",
      "bytes",
      "clients",
    ]);
  });

  it("fails closed for unknown versions, unordered points, and nonnumeric data", () => {
    const invalid = structuredClone(checkedInFixture) as {
      schemaVersion: number;
      series: Array<{ points: Array<{ timestamp: number; value: unknown }> }>;
    };
    invalid.schemaVersion = 9;
    invalid.series[0].points[1].timestamp =
      invalid.series[0].points[0].timestamp;
    invalid.series[1].points[0].value = "lots";

    const result = validateOperationalMetricsDocument(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid document");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.schemaVersion",
        "$.series[0].points[1].timestamp",
        "$.series[1].points[0].value",
      ]),
    );
  });
});

describe("operational metric rendering helpers", () => {
  it("bounds dense data deterministically while retaining endpoints and spikes", () => {
    const source = Array.from({ length: 1_000 }, (_, timestamp) => ({
      timestamp,
      value: timestamp === 501 ? 10_000 : timestamp % 17,
    }));
    const first = downsampleMetricPoints(source, 80);
    const second = downsampleMetricPoints(source, 80);

    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(80);
    expect(first[0]).toEqual(source[0]);
    expect(first[first.length - 1]).toEqual(source[source.length - 1]);
    expect(first.some((point) => point.value === 10_000)).toBe(true);
  });

  it("treats declared missing intervals as gaps, including their boundaries", () => {
    const gap = { from: 20, to: 30, reason: "collector restart" };
    expect(pointFallsInGap(19, [gap])).toBe(false);
    expect(pointFallsInGap(20, [gap])).toBe(true);
    expect(pointFallsInGap(25, [gap])).toBe(true);
    expect(pointFallsInGap(31, [gap])).toBe(false);
  });

  it("clamps both ends of wholly out-of-bounds ranges", () => {
    expect(clampMetricRange({ from: 30, to: 20 }, { from: 0, to: 10 })).toEqual(
      { from: 10, to: 10 },
    );
    expect(
      clampMetricRange({ from: -20, to: -10 }, { from: 0, to: 10 }),
    ).toEqual({ from: 0, to: 0 });
    expect(clampMetricRange({ from: 8, to: 2 }, { from: 0, to: 10 })).toEqual({
      from: 2,
      to: 8,
    });
  });
});
