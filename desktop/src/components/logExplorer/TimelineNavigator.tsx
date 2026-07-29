import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  hostLogQueryEvents,
  hostLogSharedTimelineSummary,
  type EventQueryDto,
  type ExplorerEventDto,
  type SharedTimelineLaneSummaryDto,
  type SharedTimelineSeverity,
  type SharedTimelineSummaryDto,
} from "../../lib/host";
import {
  formatCanonicalUtc,
  timeQualityLabel,
} from "../../lib/logExplorer/types";
import { HELP_TIMELINE_NAVIGATOR } from "../../lib/helpContent";
import { HelpTip } from "../HelpTip";
import { OperationalMetricTracks } from "./OperationalMetricTracks";
import {
  metricDocumentTimeRange,
  validateOperationalMetricsDocument,
  type OperationalMetricRange,
  type OperationalMetricsDocumentV1,
} from "../../lib/logExplorer/operationalMetrics";
import "./TimelineNavigator.css";

const NAVIGATOR_BUCKETS = 96;
const MAX_SESSION_METRIC_BYTES = 8 * 1_048_576;
const MAX_SESSION_METRIC_SERIES = 32;
const MAX_SESSION_METRIC_POINTS = 250_000;

type Props = {
  corpusId: string;
  filter: EventQueryDto;
  emptySourceScope?: boolean;
  residentEvents: ExplorerEventDto[];
  lanes?: {
    id: string;
    label: string;
    sources: string[];
    emptySourceScope?: boolean;
  }[];
  onSeekSeq: (seq: number, target?: ExplorerEventDto) => Promise<void> | void;
};

type LaneSummaryState = {
  id: string;
  label: string;
  summary: SharedTimelineLaneSummaryDto | null;
  error: string | null;
};

const LEVELS: {
  key: SharedTimelineSeverity;
  label: string;
  glyph: string;
}[] = [
  { key: "error", label: "Error", glyph: "E" },
  { key: "warn", label: "Warning", glyph: "W" },
  { key: "info", label: "Info", glyph: "I" },
  { key: "debug", label: "Debug", glyph: "D" },
  { key: "other", label: "Other", glyph: "O" },
];

function levelCounts(summary: SharedTimelineSummaryDto, index: number) {
  const result: Record<SharedTimelineSeverity, number> = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    other: 0,
  };
  for (const series of summary.severitySeries) {
    result[series.severity] = series.counts[index] ?? 0;
  }
  return result;
}

function levelSummary(summary: SharedTimelineSummaryDto, index: number) {
  const counts = levelCounts(summary, index);
  return LEVELS.filter(({ key }) => counts[key] > 0)
    .map(({ key, label }) => `${label} ${counts[key]}`)
    .join(", ");
}

function bucketBounds(summary: SharedTimelineSummaryDto, index: number) {
  return (
    summary.buckets[index] ?? {
      index,
      start: summary.spanFrom ?? 0,
      end: summary.spanTo ?? summary.spanFrom ?? 0,
    }
  );
}

function compactTime(summary: SharedTimelineSummaryDto, ts: number) {
  if (summary.timeQuality === "order_only") return `order ${ts}`;
  if (summary.timeQuality === "mixed" && ts < 946_684_800) {
    return `~order ${ts}`;
  }
  try {
    const iso = new Date(ts * 1000).toISOString();
    const startDay = new Date((summary.spanFrom ?? ts) * 1000)
      .toISOString()
      .slice(0, 10);
    const endDay = new Date((summary.spanTo ?? ts) * 1000)
      .toISOString()
      .slice(0, 10);
    const label =
      startDay === endDay
        ? `${iso.slice(11, 19)}Z`
        : `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
    return `${summary.timeQuality === "mixed" ? "~" : ""}${label}`;
  } catch {
    return "invalid time";
  }
}

function bucketLabel(summary: SharedTimelineSummaryDto, index: number) {
  const { start, end } = bucketBounds(summary, index);
  if (summary.timeQuality === "wall") {
    return `${formatCanonicalUtc(start)}–${formatCanonicalUtc(Math.max(start, end - 1))}`;
  }
  if (summary.timeQuality === "order_only") {
    return `order ${start}–${Math.max(start, end - 1)}`;
  }
  return `mixed time/order ${start}–${Math.max(start, end - 1)}`;
}

function compactBucketRange(summary: SharedTimelineSummaryDto, index: number) {
  const { start, end } = bucketBounds(summary, index);
  return `${compactTime(summary, start)}–${compactTime(
    summary,
    Math.max(start, end - 1),
  )}`;
}

/**
 * Fixed-size corpus navigator. While expanded it performs bounded summary
 * queries; dragging never queries until the user commits a position.
 */
export function TimelineNavigator({
  corpusId,
  filter,
  emptySourceScope = false,
  residentEvents,
  lanes = [],
  onSeekSeq,
}: Props) {
  const [open, setOpen] = useState(true);
  const [summary, setSummary] = useState<SharedTimelineSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laneSummaries, setLaneSummaries] = useState<LaneSummaryState[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [committedIndex, setCommittedIndex] = useState<number | null>(null);
  const [sharedCursorTimestamp, setSharedCursorTimestamp] = useState<
    number | null
  >(null);
  const [metricDocument, setMetricDocument] =
    useState<OperationalMetricsDocumentV1 | null>(null);
  const [metricFileName, setMetricFileName] = useState<string | null>(null);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [metricDensity, setMetricDensity] = useState<
    "compact" | "standard" | "detailed"
  >("compact");
  const [metricSelection, setMetricSelection] =
    useState<OperationalMetricRange | null>(null);
  const [metricViewRange, setMetricViewRange] =
    useState<OperationalMetricRange | null>(null);
  const [status, setStatus] = useState("Loading bounded timeline summary…");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const metricInputRef = useRef<HTMLInputElement>(null);
  const detailDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryRequest = useRef(0);
  const seekRequest = useRef(0);
  const effectiveFilter: EventQueryDto = metricViewRange
    ? {
        ...filter,
        timeFrom: Math.floor(
          Math.max(filter.timeFrom ?? -Infinity, metricViewRange.from),
        ),
        timeTo: Math.ceil(
          Math.min(filter.timeTo ?? Infinity, metricViewRange.to),
        ),
      }
    : filter;
  const effectiveFilterKey = JSON.stringify(effectiveFilter);
  const laneKey = JSON.stringify(
    lanes.map((lane) => ({
      id: lane.id,
      sources: lane.sources,
      emptySourceScope: lane.emptySourceScope,
    })),
  );

  const clearDetail = useCallback(() => {
    if (detailDismissTimer.current != null) {
      clearTimeout(detailDismissTimer.current);
      detailDismissTimer.current = null;
    }
    setDetailIndex(null);
  }, []);

  const showTransientDetail = useCallback((index: number) => {
    if (detailDismissTimer.current != null) {
      clearTimeout(detailDismissTimer.current);
    }
    setDetailIndex(index);
    detailDismissTimer.current = setTimeout(() => {
      detailDismissTimer.current = null;
      setDetailIndex(null);
    }, 1_400);
  }, []);

  useEffect(
    () => () => {
      if (detailDismissTimer.current != null) {
        clearTimeout(detailDismissTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (detailIndex == null) return;
    const dismissOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".timeline-navigator__chart")
      ) {
        return;
      }
      clearDetail();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        dismissOnOutsidePointer,
        true,
      );
  }, [clearDetail, detailIndex]);

  useEffect(() => {
    if (!open) {
      summaryRequest.current += 1;
      return;
    }
    if (emptySourceScope) {
      summaryRequest.current += 1;
      setLoading(false);
      setError(null);
      setSummary(null);
      setLaneSummaries([]);
      setStatus("No events match the visible lane sources");
      return;
    }
    const request = ++summaryRequest.current;
    setLoading(true);
    setError(null);
    setSummary(null);
    setLaneSummaries([]);
    setCommittedIndex(null);
    setStatus("Loading bounded timeline summary…");
    const requestedLanes =
      lanes.length > 1
        ? lanes.slice(0, 4).map((lane) => ({
            sources: lane.emptySourceScope ? [] : lane.sources,
          }))
        : [];
    void hostLogSharedTimelineSummary(
      corpusId,
      effectiveFilter,
      requestedLanes,
      NAVIGATOR_BUCKETS,
    )
      .then((next) => {
        if (request !== summaryRequest.current) return;
        setSummary(next);
        setPreviewIndex(0);
        setSharedCursorTimestamp(next.spanFrom);
        setLaneSummaries(
          lanes.length > 1
            ? lanes.slice(0, 4).map((lane, index) => {
                const result = next.lanes.find(
                  (candidate) => candidate.laneIndex === index,
                );
                return {
                  id: lane.id,
                  label: lane.label,
                  summary: result ?? null,
                  error: result ? null : "lane coverage unavailable",
                };
              })
            : [],
        );
        setStatus(
          next.totalMatched === 0
            ? "No events match the current filters"
            : `${next.totalMatched.toLocaleString()} matching events summarized in ${next.bucketCount} fixed slots`,
        );
      })
      .catch((cause) => {
        if (request !== summaryRequest.current) return;
        setError(String(cause));
        setSummary(null);
        setLaneSummaries([]);
        setStatus("Timeline summary unavailable");
      })
      .finally(() => {
        if (request === summaryRequest.current) setLoading(false);
      });
    return () => {
      if (request === summaryRequest.current) summaryRequest.current += 1;
    };
    // Keys intentionally represent the complete serializable predicates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpusId, effectiveFilterKey, emptySourceScope, laneKey, open]);

  const counts = summary?.counts ?? [];
  const maxCount = Math.max(1, ...counts);
  const maxErrorCount = summary
    ? Math.max(
        1,
        ...counts.map((_, index) => levelCounts(summary, index).error),
      )
    : 1;

  const residentIndexes = useMemo(() => {
    if (!summary || summary.spanFrom == null || summary.bucketCount === 0) {
      return new Set<number>();
    }
    const indexes = new Set<number>();
    for (const event of residentEvents) {
      const index = Math.floor(
        (event.ts - summary.spanFrom) / summary.bucketWidth,
      );
      if (index >= 0 && index < summary.bucketCount) indexes.add(index);
    }
    return indexes;
  }, [residentEvents, summary]);
  const residentRange = useMemo(() => {
    const sorted = [...residentIndexes].sort((a, b) => a - b);
    if (!summary || sorted.length === 0) return null;
    const from = sorted[0];
    const to = sorted[sorted.length - 1];
    return {
      left: `${(from / summary.bucketCount) * 100}%`,
      width: `${((to - from + 1) / summary.bucketCount) * 100}%`,
    };
  }, [residentIndexes, summary]);

  const previewTimestamp = useCallback(
    (timestamp: number) => {
      if (
        !summary ||
        summary.spanFrom == null ||
        summary.bucketCount === 0 ||
        summary.bucketWidth <= 0
      ) {
        return null;
      }
      const index = Math.max(
        0,
        Math.min(
          summary.bucketCount - 1,
          Math.floor((timestamp - summary.spanFrom) / summary.bucketWidth),
        ),
      );
      setSharedCursorTimestamp(timestamp);
      setPreviewIndex(index);
      return index;
    },
    [summary],
  );

  const previewTimelinePointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        !summary ||
        summary.spanFrom == null ||
        summary.spanTo == null ||
        summary.spanTo <= summary.spanFrom
      ) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      );
      const index = previewTimestamp(
        summary.spanFrom + ratio * (summary.spanTo - summary.spanFrom),
      );
      if (index != null) setDetailIndex(index);
    },
    [previewTimestamp, summary],
  );

  const importSessionMetrics = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setMetricError(null);
    if (file.size > MAX_SESSION_METRIC_BYTES) {
      setMetricError("Metric bundle exceeds the 8 MB session import limit.");
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const validated = validateOperationalMetricsDocument(parsed);
      if (!validated.ok) {
        throw new Error(
          validated.issues
            .slice(0, 3)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; "),
        );
      }
      const pointCount = validated.data.series.reduce(
        (total, series) => total + series.points.length,
        0,
      );
      if (validated.data.series.length > MAX_SESSION_METRIC_SERIES) {
        throw new Error(
          `Metric bundle has more than ${MAX_SESSION_METRIC_SERIES} series.`,
        );
      }
      if (pointCount > MAX_SESSION_METRIC_POINTS) {
        throw new Error(
          `Metric bundle has more than ${MAX_SESSION_METRIC_POINTS.toLocaleString()} points.`,
        );
      }
      if (
        validated.data.series.some((series) => series.timeQuality !== "wall")
      ) {
        throw new Error(
          "Session metric alignment requires explicit wall-clock timestamps for every series.",
        );
      }
      const metricRange = metricDocumentTimeRange(validated.data);
      if (
        summary?.timeQuality !== "wall" ||
        summary.spanFrom == null ||
        summary.spanTo == null
      ) {
        throw new Error(
          "The current log view does not have a reliable wall-clock axis.",
        );
      }
      if (
        metricRange.to < summary.spanFrom ||
        metricRange.from > summary.spanTo
      ) {
        throw new Error(
          "Metric timestamps do not overlap the current log timeline.",
        );
      }
      setMetricDocument(validated.data);
      setMetricFileName(file.name);
      setMetricsOpen(true);
      setMetricSelection(null);
      setMetricViewRange(null);
      previewTimestamp(metricRange.from);
    } catch (cause) {
      setMetricDocument(null);
      setMetricFileName(null);
      setMetricError(`Metric bundle not loaded: ${String(cause)}`);
    }
  };

  const seekBucket = async (index: number) => {
    if (!summary || summary.bucketCount === 0) return;
    const request = ++seekRequest.current;
    const { start, end } = bucketBounds(summary, index);
    setPreviewIndex(index);
    setSharedCursorTimestamp(start);
    setError(null);
    setStatus(`Seeking ${compactBucketRange(summary, index)}…`);
    try {
      const page = await hostLogQueryEvents(corpusId, {
        ...effectiveFilter,
        timeFrom: start,
        timeTo: end,
        afterSeq: null,
        afterTs: null,
        beforeSeq: null,
        beforeTs: null,
        limit: 1,
        sortByTime: true,
      });
      if (request !== seekRequest.current) return;
      const event = page.events[0];
      if (!event) {
        setStatus(`No event in ${compactBucketRange(summary, index)}`);
        return;
      }
      await onSeekSeq(event.seq, event);
      if (request !== seekRequest.current) return;
      setCommittedIndex(index);
      setStatus(
        `Moved to seq ${event.seq} · ${compactTime(summary, event.ts)} · bounded neighborhood loaded`,
      );
    } catch (cause) {
      if (request !== seekRequest.current) return;
      setError(String(cause));
      setStatus("Could not move to that timeline position");
    }
  };

  const seekTimestamp = (timestamp: number) => {
    const index = previewTimestamp(timestamp);
    if (index != null) void seekBucket(index);
  };

  const toggleTimeline = (
    <button
      type="button"
      className="timeline-navigator__toggle"
      aria-expanded={open}
      aria-controls="log-explorer-timeline-navigator"
      data-testid="timeline-navigator-toggle"
      ref={toggleRef}
      aria-label={open ? "Collapse timeline" : "Expand timeline"}
      onClick={() => {
        setOpen((value) => {
          const next = !value;
          if (!next) setStatus("Timeline collapsed · no timeline work");
          return next;
        });
        requestAnimationFrame(() => toggleRef.current?.focus());
      }}
    >
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      Timeline
    </button>
  );

  return (
    <section
      className="log-explorer__navigator timeline-navigator"
      data-testid="timeline-navigator"
      data-open={open ? "true" : "false"}
      style={{ flexBasis: "100%", flexShrink: 0, maxWidth: "100%" }}
    >
      {toggleTimeline}
      {!open ? (
        <span className="timeline-navigator__collapsed-copy">
          Collapsed · no timeline work
        </span>
      ) : (
        <div
          id="log-explorer-timeline-navigator"
          className="log-explorer__navigator-body timeline-navigator__body"
          style={{ maxHeight: "min(44vh, 30rem)", overflowY: "auto" }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (detailIndex != null) {
              clearDetail();
              return;
            }
            setOpen(false);
            setStatus("Timeline collapsed · no timeline work");
            requestAnimationFrame(() => toggleRef.current?.focus());
          }}
        >
          {loading ? <span>Loading summary…</span> : null}
          {error ? (
            <span role="alert" className="log-explorer__error">
              {error}
            </span>
          ) : null}
          {summary && summary.bucketCount > 0 ? (
            <>
              <div
                className="timeline-navigator__track"
                data-testid="timeline-navigator-track"
              >
                <div className="timeline-navigator__topline">
                  <div
                    className="timeline-navigator__legend"
                    aria-label="Timeline severity legend"
                  >
                    {LEVELS.map(({ key, label, glyph }) => (
                      <span key={key} data-level={key}>
                        <b aria-hidden="true">{glyph}</b>
                        {label}
                      </span>
                    ))}
                  </div>
                  <span
                    className="timeline-navigator__current"
                    data-testid="timeline-current-summary"
                  >
                    {compactTime(
                      summary,
                      bucketBounds(summary, previewIndex).start,
                    )}{" "}
                    · {counts[previewIndex] ?? 0} events
                  </span>
                  <div className="timeline-navigator__actions">
                    <input
                      ref={metricInputRef}
                      className="timeline-navigator__metric-input"
                      data-testid="timeline-metric-input"
                      type="file"
                      accept="application/json,.json"
                      aria-label="Choose operational metric bundle"
                      onChange={(event) => void importSessionMetrics(event)}
                    />
                    <button
                      type="button"
                      className="timeline-navigator__metric-action"
                      onClick={() => metricInputRef.current?.click()}
                    >
                      {metricDocument ? "Replace metrics" : "Load metrics…"}
                    </button>
                    {metricDocument ? (
                      <>
                        <button
                          type="button"
                          className="timeline-navigator__metric-action"
                          aria-expanded={metricsOpen}
                          aria-controls="timeline-session-metrics"
                          onClick={() => setMetricsOpen((value) => !value)}
                        >
                          {metricsOpen ? "Hide tracks" : "Show tracks"}
                        </button>
                        <button
                          type="button"
                          className="timeline-navigator__metric-action"
                          onClick={() => {
                            setMetricDocument(null);
                            setMetricFileName(null);
                            setMetricError(null);
                            setMetricsOpen(false);
                            setMetricSelection(null);
                            setMetricViewRange(null);
                          }}
                        >
                          Clear
                        </button>
                      </>
                    ) : null}
                    <HelpTip
                      label="Investigation timeline help"
                      title="Investigation timeline"
                      content={HELP_TIMELINE_NAVIGATOR}
                    />
                  </div>
                </div>
                <div
                  className="log-explorer__navigator-bars timeline-navigator__chart"
                  data-testid="timeline-navigator-bars"
                  style={{
                    gridTemplateColumns: `repeat(${summary.bucketCount}, minmax(2px, 1fr))`,
                  }}
                  onPointerMove={previewTimelinePointer}
                  onPointerLeave={clearDetail}
                >
                  {residentRange ? (
                    <span
                      className="timeline-navigator__resident-range"
                      data-testid="timeline-resident-range"
                      style={residentRange}
                      aria-hidden="true"
                    />
                  ) : null}
                  {counts.map((count, index) => {
                    const levels = levelCounts(summary, index);
                    const breakdown = levelSummary(summary, index);
                    return (
                      <button
                        // Bucket indexes are stable for this summary request.
                        key={index}
                        type="button"
                        className={[
                          "log-explorer__navigator-bucket",
                          "timeline-navigator__bucket",
                          count === 0
                            ? "timeline-navigator__bucket--empty"
                            : "",
                          levels.error > 0
                            ? "timeline-navigator__bucket--has-error"
                            : "",
                          residentIndexes.has(index)
                            ? "log-explorer__navigator-bucket--resident"
                            : "",
                          previewIndex === index
                            ? "log-explorer__navigator-bucket--active"
                            : "",
                          committedIndex === index
                            ? "timeline-navigator__bucket--committed"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-testid={`timeline-bucket-${index}`}
                        aria-label={`${bucketLabel(summary, index)} · ${count} events${breakdown ? ` · ${breakdown}` : " · empty"}${residentIndexes.has(index) ? " · resident range" : ""}${committedIndex === index ? " · committed position" : ""}`}
                        aria-describedby={
                          detailIndex === index
                            ? "timeline-bucket-detail"
                            : undefined
                        }
                        style={
                          {
                            "--bucket-height":
                              count === 0
                                ? "0%"
                                : `${Math.round((count / maxCount) * 100)}%`,
                            "--error-signal-height":
                              levels.error === 0
                                ? "0px"
                                : `${3 + Math.round((levels.error / maxErrorCount) * 9)}px`,
                          } as CSSProperties
                        }
                        onPointerEnter={() => {
                          previewTimestamp(bucketBounds(summary, index).start);
                          setDetailIndex(index);
                        }}
                        onPointerLeave={() => setDetailIndex(null)}
                        onFocus={() => {
                          previewTimestamp(bucketBounds(summary, index).start);
                          setDetailIndex(index);
                        }}
                        onBlur={clearDetail}
                        onClick={() => void seekBucket(index)}
                      >
                        <span className="timeline-navigator__stack">
                          {LEVELS.map(({ key }) =>
                            levels[key] > 0 ? (
                              <i
                                key={key}
                                data-level={key}
                                style={{
                                  height: `${(levels[key] / count) * 100}%`,
                                }}
                              />
                            ) : null,
                          )}
                        </span>
                      </button>
                    );
                  })}
                  <span
                    className="timeline-navigator__preview-marker"
                    style={{
                      left: `${((previewIndex + 0.5) / summary.bucketCount) * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                  {committedIndex != null ? (
                    <span
                      className="timeline-navigator__committed-marker"
                      data-testid="timeline-committed-position"
                      style={{
                        left: `${((committedIndex + 0.5) / summary.bucketCount) * 100}%`,
                      }}
                      aria-hidden="true"
                    />
                  ) : null}
                  <input
                    className="timeline-navigator__scrubber"
                    type="range"
                    min={0}
                    max={Math.max(0, summary.bucketCount - 1)}
                    value={previewIndex}
                    aria-label="Timeline position"
                    aria-valuetext={`${compactTime(summary, bucketBounds(summary, previewIndex).start)} · ${counts[previewIndex]} events · ${timeQualityLabel(summary.timeQuality)}`}
                    title={bucketLabel(summary, previewIndex)}
                    onFocus={() => setDetailIndex(previewIndex)}
                    onBlur={clearDetail}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      previewTimestamp(bucketBounds(summary, next).start);
                      showTransientDetail(next);
                    }}
                    onPointerUp={(event) =>
                      void seekBucket(Number(event.currentTarget.value))
                    }
                    onKeyUp={(event) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight" ||
                        event.key === "Home" ||
                        event.key === "End"
                      ) {
                        void seekBucket(Number(event.currentTarget.value));
                      }
                    }}
                  />
                </div>
                {detailIndex != null ? (
                  <div
                    id="timeline-bucket-detail"
                    role="tooltip"
                    className="timeline-navigator__bucket-detail"
                    data-testid="timeline-bucket-detail"
                    style={
                      {
                        "--timeline-detail-x": `${((detailIndex + 0.5) / summary.bucketCount) * 100}%`,
                      } as CSSProperties
                    }
                  >
                    <strong>{compactBucketRange(summary, detailIndex)}</strong>
                    <span>
                      {counts[detailIndex] ?? 0} events
                      {levelSummary(summary, detailIndex)
                        ? ` · ${levelSummary(summary, detailIndex)}`
                        : " · empty bucket"}
                    </span>
                    <code>{bucketLabel(summary, detailIndex)}</code>
                    {laneSummaries.some((lane) => lane.summary) ? (
                      <ul aria-label="Bucket lane breakdown">
                        {laneSummaries.map((lane) => (
                          <li key={lane.id}>
                            <span>{lane.label}</span>
                            <b>
                              {lane.summary?.counts[detailIndex] ??
                                "unavailable"}
                            </b>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <small>
                      {residentIndexes.has(detailIndex)
                        ? "Resident evidence is loaded here."
                        : "Outside the resident evidence window."}
                      {committedIndex === detailIndex
                        ? " Current committed position."
                        : ""}
                    </small>
                  </div>
                ) : null}
                <div className="timeline-navigator__axis" aria-hidden="true">
                  <span>
                    {compactTime(summary, bucketBounds(summary, 0).start)}
                  </span>
                  <span>
                    {compactTime(
                      summary,
                      bucketBounds(summary, summary.bucketCount - 1).end,
                    )}
                  </span>
                </div>
              </div>
              {metricError ? (
                <div role="alert" className="timeline-navigator__metric-error">
                  {metricError}
                </div>
              ) : null}
              {metricDocument && metricsOpen ? (
                <section
                  id="timeline-session-metrics"
                  className="timeline-navigator__session-metrics"
                  data-testid="timeline-session-metrics"
                >
                  <div className="timeline-navigator__session-metrics-note">
                    <div>
                      <strong>Session metrics</strong>
                      <label>
                        Track size
                        <select
                          aria-label="Metric track size"
                          value={metricDensity}
                          onChange={(event) =>
                            setMetricDensity(
                              event.currentTarget.value as
                                "compact" | "standard" | "detailed",
                            )
                          }
                        >
                          <option value="compact">Compact</option>
                          <option value="standard">Standard</option>
                          <option value="detailed">Detailed</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="timeline-navigator__metric-action"
                        disabled={
                          metricSelection == null ||
                          metricSelection.to - metricSelection.from < 1
                        }
                        onClick={() => {
                          if (!metricSelection) return;
                          setMetricViewRange(metricSelection);
                          setMetricSelection(null);
                        }}
                      >
                        Zoom to selection
                      </button>
                      {metricViewRange ? (
                        <button
                          type="button"
                          className="timeline-navigator__metric-action"
                          onClick={() => {
                            setMetricViewRange(null);
                            setMetricSelection(null);
                          }}
                        >
                          Reset full range
                        </button>
                      ) : null}
                    </div>
                    <span title={metricFileName ?? undefined}>
                      {metricFileName} · session only · not persisted
                      {metricViewRange
                        ? ` · zoomed ${compactTime(
                            summary,
                            metricViewRange.from,
                          )}–${compactTime(summary, metricViewRange.to)}`
                        : ""}
                    </span>
                  </div>
                  <OperationalMetricTracks
                    document={metricDocument}
                    density={metricDensity}
                    sharedTimeBounds={
                      summary.spanFrom != null && summary.spanTo != null
                        ? { from: summary.spanFrom, to: summary.spanTo }
                        : undefined
                    }
                    visibleTimeBounds={metricViewRange ?? undefined}
                    cursorTimestamp={
                      sharedCursorTimestamp ??
                      summary.spanFrom ??
                      metricDocumentTimeRange(metricDocument).from
                    }
                    onCursorChange={(timestamp) => {
                      previewTimestamp(timestamp);
                    }}
                    selectedRange={metricSelection}
                    onRangeSelect={setMetricSelection}
                    onSeekTimestamp={seekTimestamp}
                  />
                </section>
              ) : null}
              {laneSummaries.length > 0 ? (
                <div
                  className="log-explorer__navigator-lane-coverage"
                  data-testid="timeline-lane-coverage"
                  aria-label="Per-lane timeline coverage"
                >
                  {laneSummaries.map((lane) => (
                    <div
                      key={lane.id}
                      className="log-explorer__navigator-lane-row"
                      data-timeline-lane-id={lane.id}
                    >
                      <span title={lane.label}>{lane.label}</span>
                      {lane.summary ? (
                        <>
                          <div
                            className="log-explorer__navigator-lane-slots"
                            style={{
                              gridTemplateColumns: `repeat(${lane.summary.counts.length}, minmax(1px, 1fr))`,
                            }}
                          >
                            {lane.summary.counts.map((count, index) => {
                              return (
                                <i
                                  key={index}
                                  data-count={count}
                                  className={
                                    count > 0
                                      ? "log-explorer__navigator-lane-slot--filled"
                                      : ""
                                  }
                                />
                              );
                            })}
                          </div>
                          <span>
                            {timeQualityLabel(lane.summary.timeQuality)}
                          </span>
                        </>
                      ) : (
                        <span>coverage unavailable · {lane.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          <span
            className="log-explorer__navigator-status timeline-navigator__status"
            aria-live="polite"
          >
            {status}
          </span>
        </div>
      )}
    </section>
  );
}
