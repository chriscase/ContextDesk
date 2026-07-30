import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampMetricRange,
  downsampleMetricPoints,
  metricPointsForRange,
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

  it("spans the full seven-day log horizon with one explicit heap gap", () => {
    const result = validateOperationalMetricsDocument(checkedInFixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid checked-in fixture");

    const corpusFrom = 1_735_732_800;
    const corpusTo = corpusFrom + 7 * 24 * 60 * 60;
    expect(
      result.data.series.map((series) => ({
        id: series.id,
        points: series.points.length,
        from: series.points[0]?.timestamp,
        to: series.points.at(-1)?.timestamp,
      })),
    ).toEqual([
      {
        id: "cpu-percent",
        points: 673,
        from: corpusFrom,
        to: corpusTo,
      },
      {
        id: "heap-used-bytes",
        points: 668,
        from: corpusFrom,
        to: corpusTo,
      },
      {
        id: "concurrent-clients",
        points: 673,
        from: corpusFrom,
        to: corpusTo,
      },
    ]);

    const gaps = result.data.series.flatMap((series) =>
      (series.gaps ?? []).map((gap) => ({ seriesId: series.id, ...gap })),
    );
    expect(gaps).toEqual([
      {
        seriesId: "heap-used-bytes",
        from: corpusFrom + 61 * 60 * 60,
        to: corpusFrom + 62 * 60 * 60,
        reason: "intentional synthetic heap collector restart",
      },
    ]);
    const heap = result.data.series.find(
      (series) => series.id === "heap-used-bytes",
    );
    expect(
      heap?.points.some(
        (point) =>
          point.timestamp >= gaps[0]!.from && point.timestamp <= gaps[0]!.to,
      ),
    ).toBe(false);
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

  it("shares valid metrics-parity fixture with Rust (required series provenance)", () => {
    const doc = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/incident-evidence/metrics-parity/valid-with-provenance.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const result = validateOperationalMetricsDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(
      result.data.series.every((series) => series.provenance.source.length > 0),
    ).toBe(true);
  });

  it("rejects shared invalid-missing-series-provenance fixture", () => {
    const doc = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/incident-evidence/metrics-parity/invalid-missing-series-provenance.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const result = validateOperationalMetricsDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing provenance to fail");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.series[0].provenance"]),
    );
  });

  it("rejects shared invalid-empty-series fixture", () => {
    const doc = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/incident-evidence/metrics-parity/invalid-empty-series.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const result = validateOperationalMetricsDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected empty series to fail");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.series"]),
    );
  });

  it("accepts logs-plus-metrics operational-metrics.v1.json from IEB fixtures", () => {
    const doc = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/incident-evidence/valid/logs-plus-metrics/metrics/operational-metrics.v1.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const result = validateOperationalMetricsDocument(doc);
    expect(result.ok).toBe(true);
  });
});

describe("operational metric rendering helpers", () => {
  it("bounds dense data deterministically while retaining endpoints and spikes", () => {
    const sixMinuteSamplesForTwoMonths = 60 * 24 * 10;
    const source = Array.from(
      { length: sixMinuteSamplesForTwoMonths },
      (_, index) => ({
        timestamp: 1_735_689_600 + index * 6 * 60,
        value: index === 7_321 ? 10_000 : index % 17,
      }),
    );
    const first = downsampleMetricPoints(source, 240);
    const second = downsampleMetricPoints(source, 240);

    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(240);
    expect(first[0]).toEqual(source[0]);
    expect(first[first.length - 1]).toEqual(source[source.length - 1]);
    expect(first.some((point) => point.value === 10_000)).toBe(true);
  });

  it("selects only a zoomed source range before rendering finer detail", () => {
    const source = Array.from({ length: 30 * 24 * 10 }, (_, index) => ({
      timestamp: index * 6 * 60,
      value: index,
    }));
    const dayTen = 10 * 24 * 60 * 60;
    const visible = metricPointsForRange(source, {
      from: dayTen,
      to: dayTen + 24 * 60 * 60,
    });

    expect(visible.length).toBe(243);
    expect(visible[0].timestamp).toBe(dayTen - 6 * 60);
    expect(visible[visible.length - 1].timestamp).toBe(
      dayTen + 24 * 60 * 60 + 6 * 60,
    );
    expect(downsampleMetricPoints(visible, 240)).toHaveLength(240);
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
