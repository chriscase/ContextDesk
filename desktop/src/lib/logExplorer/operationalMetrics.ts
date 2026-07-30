import type { TimeQuality } from "./types";

export const OPERATIONAL_METRICS_SCHEMA_VERSION = 1 as const;

export type OperationalMetricProvenance = {
  source: string;
  collector?: string;
  query?: string;
};

export type OperationalMetricThreshold = {
  id: string;
  label: string;
  value: number;
  severity: "info" | "warning" | "critical";
};

export type OperationalMetricPoint = {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
  provenance?: OperationalMetricProvenance;
  timeQuality?: TimeQuality;
};

export type OperationalMetricGap = {
  from: number;
  to: number;
  reason?: string;
};

export type OperationalMetricSeries = {
  id: string;
  name: string;
  unit: string;
  points: OperationalMetricPoint[];
  labels?: Record<string, string>;
  thresholds?: OperationalMetricThreshold[];
  gaps?: OperationalMetricGap[];
  provenance: OperationalMetricProvenance;
  timeQuality: TimeQuality;
};

export type OperationalMetricsDocumentV1 = {
  schemaVersion: typeof OPERATIONAL_METRICS_SCHEMA_VERSION;
  id: string;
  name: string;
  series: OperationalMetricSeries[];
};

export type OperationalMetricValidationIssue = {
  path: string;
  message: string;
};

export type OperationalMetricValidationResult =
  | { ok: true; data: OperationalMetricsDocumentV1; issues: [] }
  | { ok: false; data: null; issues: OperationalMetricValidationIssue[] };

export type OperationalMetricRange = {
  from: number;
  to: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateLabels(
  value: unknown,
  path: string,
  issues: OperationalMetricValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object of string values" });
    return;
  }
  for (const [key, labelValue] of Object.entries(value)) {
    if (!hasNonEmptyString(key) || typeof labelValue !== "string") {
      issues.push({ path: `${path}.${key}`, message: "must be a string" });
    }
  }
}

function validateProvenance(
  value: unknown,
  path: string,
  issues: OperationalMetricValidationIssue[],
): void {
  if (!isRecord(value) || !hasNonEmptyString(value.source)) {
    issues.push({ path, message: "must include a non-empty source" });
    return;
  }
  for (const key of ["collector", "query"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push({ path: `${path}.${key}`, message: "must be a string" });
    }
  }
}

function validateTimeQuality(
  value: unknown,
  path: string,
  issues: OperationalMetricValidationIssue[],
): void {
  if (value !== "wall" && value !== "mixed" && value !== "order_only") {
    issues.push({
      path,
      message: "must be wall, mixed, or order_only",
    });
  }
}

/**
 * Strict, dependency-free validation at the import boundary. Unknown fields are
 * tolerated so additive schema evolution does not break older readers.
 */
export function validateOperationalMetricsDocument(
  value: unknown,
): OperationalMetricValidationResult {
  const issues: OperationalMetricValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      data: null,
      issues: [{ path: "$", message: "must be an object" }],
    };
  }
  if (value.schemaVersion !== OPERATIONAL_METRICS_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `must equal ${OPERATIONAL_METRICS_SCHEMA_VERSION}`,
    });
  }
  if (!hasNonEmptyString(value.id)) {
    issues.push({ path: "$.id", message: "must be a non-empty string" });
  }
  if (!hasNonEmptyString(value.name)) {
    issues.push({ path: "$.name", message: "must be a non-empty string" });
  }
  if (!Array.isArray(value.series) || value.series.length === 0) {
    issues.push({
      path: "$.series",
      message: "must contain at least one metric series",
    });
  } else {
    const ids = new Set<string>();
    value.series.forEach((candidate, seriesIndex) => {
      const path = `$.series[${seriesIndex}]`;
      if (!isRecord(candidate)) {
        issues.push({ path, message: "must be an object" });
        return;
      }
      if (!hasNonEmptyString(candidate.id)) {
        issues.push({ path: `${path}.id`, message: "must be non-empty" });
      } else if (ids.has(candidate.id)) {
        issues.push({ path: `${path}.id`, message: "must be unique" });
      } else {
        ids.add(candidate.id);
      }
      if (!hasNonEmptyString(candidate.name)) {
        issues.push({ path: `${path}.name`, message: "must be non-empty" });
      }
      if (!hasNonEmptyString(candidate.unit)) {
        issues.push({ path: `${path}.unit`, message: "must be non-empty" });
      }
      validateLabels(candidate.labels, `${path}.labels`, issues);
      validateProvenance(candidate.provenance, `${path}.provenance`, issues);
      validateTimeQuality(candidate.timeQuality, `${path}.timeQuality`, issues);

      if (!Array.isArray(candidate.points) || candidate.points.length === 0) {
        issues.push({
          path: `${path}.points`,
          message: "must contain at least one point",
        });
      } else {
        let previousTimestamp = Number.NEGATIVE_INFINITY;
        candidate.points.forEach((point, pointIndex) => {
          const pointPath = `${path}.points[${pointIndex}]`;
          if (!isRecord(point)) {
            issues.push({ path: pointPath, message: "must be an object" });
            return;
          }
          if (!isFiniteNumber(point.timestamp)) {
            issues.push({
              path: `${pointPath}.timestamp`,
              message: "must be a finite Unix timestamp in seconds",
            });
          } else if (point.timestamp <= previousTimestamp) {
            issues.push({
              path: `${pointPath}.timestamp`,
              message: "must be strictly increasing",
            });
          } else {
            previousTimestamp = point.timestamp;
          }
          if (!isFiniteNumber(point.value)) {
            issues.push({
              path: `${pointPath}.value`,
              message: "must be a finite number",
            });
          }
          validateLabels(point.labels, `${pointPath}.labels`, issues);
          if (point.provenance !== undefined) {
            validateProvenance(
              point.provenance,
              `${pointPath}.provenance`,
              issues,
            );
          }
          if (point.timeQuality !== undefined) {
            validateTimeQuality(
              point.timeQuality,
              `${pointPath}.timeQuality`,
              issues,
            );
          }
        });
      }

      if (candidate.thresholds !== undefined) {
        if (!Array.isArray(candidate.thresholds)) {
          issues.push({
            path: `${path}.thresholds`,
            message: "must be an array",
          });
        } else {
          candidate.thresholds.forEach((threshold, thresholdIndex) => {
            const thresholdPath = `${path}.thresholds[${thresholdIndex}]`;
            if (
              !isRecord(threshold) ||
              !hasNonEmptyString(threshold.id) ||
              !hasNonEmptyString(threshold.label) ||
              !isFiniteNumber(threshold.value) ||
              !["info", "warning", "critical"].includes(
                String(threshold.severity),
              )
            ) {
              issues.push({
                path: thresholdPath,
                message:
                  "must include id, label, finite value, and a supported severity",
              });
            }
          });
        }
      }

      if (candidate.gaps !== undefined) {
        if (!Array.isArray(candidate.gaps)) {
          issues.push({ path: `${path}.gaps`, message: "must be an array" });
        } else {
          candidate.gaps.forEach((gap, gapIndex) => {
            const gapPath = `${path}.gaps[${gapIndex}]`;
            if (
              !isRecord(gap) ||
              !isFiniteNumber(gap.from) ||
              !isFiniteNumber(gap.to) ||
              gap.to <= gap.from
            ) {
              issues.push({
                path: gapPath,
                message:
                  "must include finite from/to with to greater than from",
              });
            }
            if (
              isRecord(gap) &&
              gap.reason !== undefined &&
              typeof gap.reason !== "string"
            ) {
              issues.push({
                path: `${gapPath}.reason`,
                message: "must be a string",
              });
            }
          });
        }
      }
    });
  }

  if (issues.length > 0) return { ok: false, data: null, issues };
  return {
    ok: true,
    data: value as unknown as OperationalMetricsDocumentV1,
    issues: [],
  };
}

/**
 * Deterministic min/max bucket downsampling. It preserves the first and last
 * samples plus local extrema so short spikes survive while DOM/SVG work remains
 * bounded by maxPoints.
 */
export function downsampleMetricPoints(
  points: readonly OperationalMetricPoint[],
  maxPoints: number,
): OperationalMetricPoint[] {
  const limit = Math.max(2, Math.floor(maxPoints));
  if (points.length <= limit) return [...points];
  if (limit === 2) return [points[0], points[points.length - 1]];

  const interior = points.slice(1, -1);
  const slots = limit - 2;
  const pairBuckets = Math.max(1, Math.floor(slots / 2));
  const selected: OperationalMetricPoint[] = [points[0]];

  for (let bucket = 0; bucket < pairBuckets; bucket += 1) {
    const start = Math.floor((bucket * interior.length) / pairBuckets);
    const end = Math.floor(((bucket + 1) * interior.length) / pairBuckets);
    const entries = interior.slice(start, Math.max(start + 1, end));
    let min = entries[0];
    let max = entries[0];
    for (const point of entries.slice(1)) {
      if (point.value < min.value) min = point;
      if (point.value > max.value) max = point;
    }
    if (min.timestamp <= max.timestamp) {
      selected.push(min);
      if (max !== min) selected.push(max);
    } else {
      selected.push(max, min);
    }
  }

  const remaining = limit - 1;
  const bounded = selected.slice(0, remaining);
  bounded.push(points[points.length - 1]);
  return bounded;
}

/**
 * Select the source samples needed for a visible time range, retaining at most
 * one neighbor on either side so a line can enter and leave the viewport
 * without scanning or rendering the rest of the series.
 */
export function metricPointsForRange(
  points: readonly OperationalMetricPoint[],
  range: OperationalMetricRange,
): OperationalMetricPoint[] {
  if (points.length === 0) return [];
  const from = Math.min(range.from, range.to);
  const to = Math.max(range.from, range.to);

  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < from) low = middle + 1;
    else high = middle;
  }
  const firstVisible = low;

  low = firstVisible;
  high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp <= to) low = middle + 1;
    else high = middle;
  }
  const afterVisible = low;

  const start = Math.max(0, firstVisible - 1);
  const end = Math.min(points.length, afterVisible + 1);
  return points.slice(start, end);
}

export function metricDocumentTimeRange(
  document: OperationalMetricsDocumentV1,
): OperationalMetricRange {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const series of document.series) {
    const first = series.points[0];
    const last = series.points[series.points.length - 1];
    if (first) from = Math.min(from, first.timestamp);
    if (last) to = Math.max(to, last.timestamp);
  }
  return { from, to };
}

export function clampMetricRange(
  range: OperationalMetricRange,
  bounds: OperationalMetricRange,
): OperationalMetricRange {
  const clampTimestamp = (timestamp: number) =>
    Math.max(bounds.from, Math.min(bounds.to, timestamp));
  const first = clampTimestamp(range.from);
  const second = clampTimestamp(range.to);
  return {
    from: Math.min(first, second),
    to: Math.max(first, second),
  };
}

export function pointFallsInGap(
  timestamp: number,
  gaps: readonly OperationalMetricGap[] = [],
): boolean {
  return gaps.some((gap) => timestamp >= gap.from && timestamp <= gap.to);
}

/** Exact copy when corpus is order-only (#670 / #707). */
export const METRIC_LOAD_BLOCKED_ORDER_ONLY =
  "Metrics need a wall clock. This corpus is order-only, so metric tracks cannot be aligned.";

/** Exact copy when corpus has mixed/unresolved time sources. */
export const METRIC_LOAD_BLOCKED_MIXED =
  "Metrics need a reliable shared wall clock. Some sources in this corpus have unresolved time.";

/** Honest failure when the timeline is empty, failed, or not yet loaded. */
export const METRIC_LOAD_BLOCKED_TIMELINE_UNAVAILABLE =
  "Metrics need a reliable shared wall clock. The timeline is not ready yet.";

export type MetricLoadTimelineSummary = {
  timeQuality: TimeQuality | string;
  spanFrom?: number | null;
  spanTo?: number | null;
  bucketCount?: number;
};

export type MetricLoadGate =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Pure gate: session metric loading requires a loaded timeline with reliable
 * shared wall-clock quality. Does not upgrade clocks or invent timezones.
 */
export function metricLoadGate(
  summary: MetricLoadTimelineSummary | null | undefined,
  options?: {
    loading?: boolean;
    error?: string | null;
  },
): MetricLoadGate {
  if (options?.loading) {
    return {
      allowed: false,
      reason: METRIC_LOAD_BLOCKED_TIMELINE_UNAVAILABLE,
    };
  }
  if (options?.error) {
    return {
      allowed: false,
      reason: METRIC_LOAD_BLOCKED_TIMELINE_UNAVAILABLE,
    };
  }
  if (
    !summary ||
    summary.spanFrom == null ||
    summary.spanTo == null ||
    (summary.bucketCount != null && summary.bucketCount <= 0)
  ) {
    return {
      allowed: false,
      reason: METRIC_LOAD_BLOCKED_TIMELINE_UNAVAILABLE,
    };
  }
  if (summary.timeQuality === "wall") {
    return { allowed: true };
  }
  if (summary.timeQuality === "order_only") {
    return { allowed: false, reason: METRIC_LOAD_BLOCKED_ORDER_ONLY };
  }
  if (summary.timeQuality === "mixed") {
    return { allowed: false, reason: METRIC_LOAD_BLOCKED_MIXED };
  }
  return {
    allowed: false,
    reason: METRIC_LOAD_BLOCKED_TIMELINE_UNAVAILABLE,
  };
}
