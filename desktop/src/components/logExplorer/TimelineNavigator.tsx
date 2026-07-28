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
  type TimelineSummaryDto,
} from "../../lib/host";
import { formatCanonicalUtc, timeQualityLabel } from "../../lib/logExplorer/types";

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
 * Lazy, fixed-size corpus navigator. Opening it performs two bounded SQL
 * aggregate queries; dragging never queries until the user commits a position.
 */
export function TimelineNavigator({
  corpusId,
  filter,
  emptySourceScope = false,
  residentEvents,
  lanes = [],
  onSeekSeq,
}: Props) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<TimelineSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laneSummaries, setLaneSummaries] = useState<LaneSummaryState[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [status, setStatus] = useState("Navigator closed");
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
                  summary:
                    result?.status === "fulfilled" ? result.value : null,
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

  const counts = useMemo(() => {
    const values = Array.from(
      { length: summary?.bucketCount ?? 0 },
      () => 0,
    );
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
      className="log-explorer__navigator"
      data-testid="timeline-navigator"
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className={`log-explorer__btn ${open ? "log-explorer__btn--active" : ""}`}
        aria-expanded={open}
        aria-controls="log-explorer-timeline-navigator"
        data-testid="timeline-navigator-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        Navigator
      </button>
      {!open ? (
        <span className="log-explorer__chat-preview">
          closed · no timeline work
        </span>
      ) : (
        <div
          id="log-explorer-timeline-navigator"
          className="log-explorer__navigator-body"
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
                className="log-explorer__navigator-bars"
                data-testid="timeline-navigator-bars"
                style={{
                  gridTemplateColumns: `repeat(${summary.bucketCount}, minmax(2px, 1fr))`,
                  padding: "3px 4px",
                }}
              >
                {counts.map((count, index) => (
                  <button
                    // Bucket indexes are stable for this summary request.
                    key={index}
                    type="button"
                    className={[
                      "log-explorer__navigator-bucket",
                      residentIndexes.has(index)
                        ? "log-explorer__navigator-bucket--resident"
                        : "",
                      previewIndex === index
                        ? "log-explorer__navigator-bucket--active"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-testid={`timeline-bucket-${index}`}
                    aria-label={`${bucketLabel(summary, index)} · ${count} events${residentIndexes.has(index) ? " · current resident window" : ""}`}
                    title={`${bucketLabel(summary, index)} · ${count} events`}
                    style={{
                      "--bucket-height": `${Math.max(4, Math.round((count / maxCount) * 100))}%`,
                    } as CSSProperties}
                    onClick={() => void seekBucket(index)}
                  />
                ))}
              </div>
              <label className="log-explorer__navigator-range">
                Position
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, summary.bucketCount - 1)}
                  value={previewIndex}
                  aria-label="Timeline position"
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
              </label>
              <span className="log-explorer__navigator-label">
                {bucketLabel(summary, previewIndex)} ·{" "}
                {timeQualityLabel(summary.timeQuality)}
              </span>
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
            className="log-explorer__navigator-status"
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
