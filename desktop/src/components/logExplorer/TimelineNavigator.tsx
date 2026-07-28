import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  hostLogQueryEvents,
  hostLogTimelineSummary,
  type EventQueryDto,
  type ExplorerEventDto,
  type TimelineSummaryBucketDto,
  type TimelineSummaryDto,
} from "../../lib/host";
import {
  formatCanonicalUtc,
  timeQualityLabel,
} from "../../lib/logExplorer/types";
import "./TimelineNavigator.css";

const NAVIGATOR_BUCKETS = 96;

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
  summary: TimelineSummaryDto | null;
  error: string | null;
};

type CanonicalLevel = "error" | "warn" | "info" | "debug" | "other";

const LEVELS: { key: CanonicalLevel; label: string; glyph: string }[] = [
  { key: "error", label: "Error", glyph: "E" },
  { key: "warn", label: "Warning", glyph: "W" },
  { key: "info", label: "Info", glyph: "I" },
  { key: "debug", label: "Debug", glyph: "D" },
  { key: "other", label: "Other", glyph: "O" },
];

function canonicalLevel(level: string): CanonicalLevel {
  switch (level.trim().toLowerCase()) {
    case "fatal":
    case "critical":
    case "crit":
    case "severe":
    case "error":
    case "err":
      return "error";
    case "warning":
    case "warn":
      return "warn";
    case "info":
    case "notice":
      return "info";
    case "debug":
    case "trace":
      return "debug";
    default:
      return "other";
  }
}

function levelCounts(bucket?: TimelineSummaryBucketDto) {
  const result: Record<CanonicalLevel, number> = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    other: 0,
  };
  for (const [level, count] of Object.entries(bucket?.byLevel ?? {})) {
    result[canonicalLevel(level)] += count;
  }
  const classified = Object.values(result).reduce(
    (total, count) => total + count,
    0,
  );
  result.other += Math.max(0, (bucket?.count ?? 0) - classified);
  return result;
}

function levelSummary(bucket?: TimelineSummaryBucketDto) {
  const counts = levelCounts(bucket);
  return LEVELS.filter(({ key }) => counts[key] > 0)
    .map(({ key, label }) => `${label} ${counts[key]}`)
    .join(", ");
}

function bucketBounds(summary: TimelineSummaryDto, index: number) {
  const start = (summary.spanFrom ?? 0) + index * summary.bucketWidth;
  return {
    start,
    end: Math.min(
      start + summary.bucketWidth,
      summary.spanTo ?? start + summary.bucketWidth,
    ),
  };
}

function compactTime(summary: TimelineSummaryDto, ts: number) {
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

function bucketLabel(summary: TimelineSummaryDto, index: number) {
  const { start, end } = bucketBounds(summary, index);
  if (summary.timeQuality === "wall") {
    return `${formatCanonicalUtc(start)}–${formatCanonicalUtc(Math.max(start, end - 1))}`;
  }
  if (summary.timeQuality === "order_only") {
    return `order ${start}–${Math.max(start, end - 1)}`;
  }
  return `mixed time/order ${start}–${Math.max(start, end - 1)}`;
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
  const [summary, setSummary] = useState<TimelineSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laneSummaries, setLaneSummaries] = useState<LaneSummaryState[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [committedIndex, setCommittedIndex] = useState<number | null>(null);
  const [status, setStatus] = useState("Loading bounded timeline summary…");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const summaryRequest = useRef(0);
  const seekRequest = useRef(0);
  const filterKey = JSON.stringify(filter);
  const laneKey = JSON.stringify(
    lanes.map((lane) => ({
      id: lane.id,
      sources: lane.sources,
      emptySourceScope: lane.emptySourceScope,
    })),
  );

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
    const laneRequests =
      lanes.length > 1
        ? lanes.slice(0, 4).map((lane) =>
            lane.emptySourceScope
              ? Promise.resolve<TimelineSummaryDto | null>(null)
              : hostLogTimelineSummary(
                  corpusId,
                  {
                    ...filter,
                    sources:
                      lane.sources.length > 0
                        ? lane.sources
                        : (filter.sources ?? []),
                  },
                  NAVIGATOR_BUCKETS,
                ),
          )
        : [];
    void Promise.allSettled([
      hostLogTimelineSummary(corpusId, filter, NAVIGATOR_BUCKETS),
      ...laneRequests,
    ])
      .then((results) => {
        if (request !== summaryRequest.current) return;
        const global = results[0];
        if (!global || global.status === "rejected") {
          throw global?.reason ?? new Error("Timeline summary unavailable");
        }
        const next = global.value;
        setSummary(next);
        setPreviewIndex(0);
        setLaneSummaries(
          lanes.length > 1
            ? lanes.slice(0, 4).map((lane, index) => {
                const result = results[index + 1];
                return {
                  id: lane.id,
                  label: lane.label,
                  summary: result?.status === "fulfilled" ? result.value : null,
                  error:
                    result?.status === "rejected"
                      ? String(result.reason)
                      : result?.value == null
                        ? "no events match visible lane"
                        : null,
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
  }, [corpusId, emptySourceScope, filterKey, laneKey, open]);

  const bucketsByIndex = useMemo(() => {
    const buckets = new Map<number, TimelineSummaryBucketDto>();
    for (const bucket of summary?.buckets ?? []) {
      buckets.set(bucket.index, bucket);
    }
    return buckets;
  }, [summary]);

  const counts = useMemo(() => {
    const values = Array.from({ length: summary?.bucketCount ?? 0 }, () => 0);
    for (const bucket of summary?.buckets ?? []) {
      if (bucket.index < values.length) values[bucket.index] = bucket.count;
    }
    return values;
  }, [summary]);
  const maxCount = Math.max(1, ...counts);

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

  const seekBucket = async (index: number) => {
    if (!summary || summary.bucketCount === 0) return;
    const request = ++seekRequest.current;
    const { start, end } = bucketBounds(summary, index);
    setPreviewIndex(index);
    setError(null);
    setStatus(`Seeking ${bucketLabel(summary, index)}…`);
    try {
      const page = await hostLogQueryEvents(corpusId, {
        ...filter,
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
        setStatus(`No event in ${bucketLabel(summary, index)}`);
        return;
      }
      await onSeekSeq(event.seq, event);
      if (request !== seekRequest.current) return;
      setCommittedIndex(index);
      setStatus(
        `Moved to seq ${event.seq} · ${bucketLabel(summary, index)} · bounded neighborhood loaded`,
      );
    } catch (cause) {
      if (request !== seekRequest.current) return;
      setError(String(cause));
      setStatus("Could not move to that timeline position");
    }
  };

  return (
    <section
      className="log-explorer__navigator timeline-navigator"
      data-testid="timeline-navigator"
      data-open={open ? "true" : "false"}
    >
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
        }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Timeline
      </button>
      {!open ? (
        <span className="timeline-navigator__collapsed-copy">
          Collapsed · no timeline work
        </span>
      ) : (
        <div
          id="log-explorer-timeline-navigator"
          className="log-explorer__navigator-body timeline-navigator__body"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
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
              <div className="timeline-navigator__track">
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
                <div
                  className="log-explorer__navigator-bars timeline-navigator__chart"
                  data-testid="timeline-navigator-bars"
                  style={{
                    gridTemplateColumns: `repeat(${summary.bucketCount}, minmax(2px, 1fr))`,
                  }}
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
                    const bucket = bucketsByIndex.get(index);
                    const levels = levelCounts(bucket);
                    const breakdown = levelSummary(bucket);
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
                        title={`${bucketLabel(summary, index)} · ${count} events${breakdown ? ` · ${breakdown}` : ""}`}
                        style={
                          {
                            "--bucket-height":
                              count === 0
                                ? "0%"
                                : `${Math.round((count / maxCount) * 100)}%`,
                          } as CSSProperties
                        }
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
                    onChange={(event) =>
                      setPreviewIndex(Number(event.target.value))
                    }
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
                <div className="timeline-navigator__axis" aria-hidden="true">
                  <span>
                    {compactTime(summary, bucketBounds(summary, 0).start)}
                  </span>
                  <span>
                    {compactTime(
                      summary,
                      bucketBounds(summary, previewIndex).start,
                    )}{" "}
                    preview
                  </span>
                  <span>
                    {compactTime(
                      summary,
                      bucketBounds(summary, summary.bucketCount - 1).end,
                    )}
                  </span>
                </div>
              </div>
              <details className="timeline-navigator__data">
                <summary>Timeline data</summary>
                <ol>
                  {counts.map((count, index) => (
                    <li key={index}>
                      {compactTime(summary, bucketBounds(summary, index).start)}
                      : {count} events
                      {levelSummary(bucketsByIndex.get(index))
                        ? ` (${levelSummary(bucketsByIndex.get(index))})`
                        : " (empty)"}
                    </li>
                  ))}
                </ol>
              </details>
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
                      data-lane-id={lane.id}
                    >
                      <span title={lane.label}>{lane.label}</span>
                      {lane.summary ? (
                        <>
                          <div
                            className="log-explorer__navigator-lane-slots"
                            style={{
                              gridTemplateColumns: `repeat(${lane.summary.bucketCount}, minmax(1px, 1fr))`,
                            }}
                          >
                            {Array.from(
                              { length: lane.summary.bucketCount },
                              (_, index) => {
                                const count =
                                  lane.summary?.buckets.find(
                                    (bucket) => bucket.index === index,
                                  )?.count ?? 0;
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
                              },
                            )}
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
            role="status"
            aria-live="polite"
          >
            {status}
          </span>
        </div>
      )}
    </section>
  );
}
