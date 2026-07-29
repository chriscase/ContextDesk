import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  clampMetricRange,
  downsampleMetricPoints,
  metricDocumentTimeRange,
  metricPointsForRange,
  pointFallsInGap,
  type OperationalMetricPoint,
  type OperationalMetricRange,
  type OperationalMetricsDocumentV1,
  type OperationalMetricSeries,
} from "../../lib/logExplorer/operationalMetrics";
import "./OperationalMetricTracks.css";

export type OperationalMetricDensity = "compact" | "standard" | "detailed";

export type OperationalMetricTracksProps = {
  document: OperationalMetricsDocumentV1;
  /**
   * A layout density hint only. Both presentations use this same renderer and
   * shared interaction state; the parent owns docking/orientation.
   */
  presentation?: "stacked" | "compact-side";
  /** Controls plot height and how much supporting metadata is shown inline. */
  density?: OperationalMetricDensity;
  /**
   * Optional parent-owned time domain, such as the visible log timeline.
   * The effective domain always includes every metric sample.
   */
  sharedTimeBounds?: OperationalMetricRange;
  /**
   * Optional exact viewport within the shared domain. Source samples are
   * selected before downsampling so zooming progressively reveals detail.
   */
  visibleTimeBounds?: OperationalMetricRange;
  cursorTimestamp?: number;
  selectedRange?: OperationalMetricRange | null;
  maxRenderedPointsPerTrack?: number;
  onCursorChange?: (timestamp: number) => void;
  cursorReadingsVisible?: boolean;
  onCursorReadingsVisibleChange?: (visible: boolean) => void;
  onRangeSelect?: (range: OperationalMetricRange | null) => void;
  /** Pointer release requests one bounded seek toward nearby log events. */
  onSeekTimestamp?: (timestamp: number) => void;
};

const VIEWBOX_SIZE = 100;

function clamp(value: number, from: number, to: number): number {
  return Math.max(from, Math.min(to, value));
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp * 1000));
}

function formatValue(value: number, unit: string): string {
  if (unit === "bytes") {
    return `${new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value)} bytes`;
  }
  return `${new Intl.NumberFormat("en", {
    maximumFractionDigits: 2,
  }).format(value)} ${unit}`;
}

function nearestPoint(
  points: readonly OperationalMetricPoint[],
  timestamp: number,
): OperationalMetricPoint {
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const point = points[middle];
    if (point.timestamp === timestamp) return point;
    if (point.timestamp < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  const before = points[Math.max(0, high)];
  const after = points[Math.min(points.length - 1, low)];
  return Math.abs(before.timestamp - timestamp) <=
    Math.abs(after.timestamp - timestamp)
    ? before
    : after;
}

function scaleTimestamp(
  timestamp: number,
  bounds: OperationalMetricRange,
): number {
  if (bounds.to === bounds.from) return VIEWBOX_SIZE / 2;
  return ((timestamp - bounds.from) / (bounds.to - bounds.from)) * VIEWBOX_SIZE;
}

function resolveTimeBounds(
  documentBounds: OperationalMetricRange,
  sharedTimeBounds?: OperationalMetricRange,
): OperationalMetricRange {
  if (
    sharedTimeBounds == null ||
    !Number.isFinite(sharedTimeBounds.from) ||
    !Number.isFinite(sharedTimeBounds.to)
  ) {
    return documentBounds;
  }
  const sharedFrom = Math.min(sharedTimeBounds.from, sharedTimeBounds.to);
  const sharedTo = Math.max(sharedTimeBounds.from, sharedTimeBounds.to);
  return {
    from: Math.min(documentBounds.from, sharedFrom),
    to: Math.max(documentBounds.to, sharedTo),
  };
}

function yDomain(series: OperationalMetricSeries): {
  min: number;
  max: number;
} {
  const values = [
    ...series.points.map((point) => point.value),
    ...(series.thresholds ?? []).map((threshold) => threshold.value),
  ];
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.abs(min) * 0.05 || 1;
    min -= padding;
    max += padding;
  }
  return { min, max };
}

function scaleValue(value: number, domain: ReturnType<typeof yDomain>): number {
  return (
    VIEWBOX_SIZE -
    ((value - domain.min) / (domain.max - domain.min)) * VIEWBOX_SIZE
  );
}

function visibleSegments(
  series: OperationalMetricSeries,
  points: readonly OperationalMetricPoint[],
  bounds: OperationalMetricRange,
  domain: ReturnType<typeof yDomain>,
): string[] {
  const segments: OperationalMetricPoint[][] = [];
  let segment: OperationalMetricPoint[] = [];
  let previousPoint: OperationalMetricPoint | null = null;
  for (const point of points) {
    const previousTimestamp = previousPoint?.timestamp;
    const intervalCrossesGap =
      previousTimestamp != null &&
      (series.gaps ?? []).some(
        (gap) => previousTimestamp <= gap.to && point.timestamp >= gap.from,
      );
    if (intervalCrossesGap && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    if (pointFallsInGap(point.timestamp, series.gaps)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    } else {
      segment.push(point);
    }
    previousPoint = point;
  }
  if (segment.length > 0) segments.push(segment);

  return segments.map((entries) =>
    entries
      .map((point, index) => {
        const x = scaleTimestamp(point.timestamp, bounds);
        const y = scaleValue(point.value, domain);
        return `${index === 0 ? "M" : "L"} ${x.toFixed(3)} ${y.toFixed(3)}`;
      })
      .join(" "),
  );
}

type MetricTrackProps = {
  series: OperationalMetricSeries;
  bounds: OperationalMetricRange;
  cursor: number;
  selection: OperationalMetricRange | null;
  maxRenderedPoints: number;
  showReading: boolean;
  onInteractionChange: (key: string, active: boolean) => void;
  onPointerTimestamp: (
    timestamp: number,
    phase: "start" | "move" | "end" | "cancel",
  ) => void;
  onKeyboardTimestamp: (timestamp: number, extendRange: boolean) => void;
  onKeyboardCommit: () => void;
};

function MetricTrack({
  series,
  bounds,
  cursor,
  selection,
  maxRenderedPoints,
  showReading,
  onInteractionChange,
  onPointerTimestamp,
  onKeyboardTimestamp,
  onKeyboardCommit,
}: MetricTrackProps) {
  const visibleSourcePoints = useMemo(
    () => metricPointsForRange(series.points, bounds),
    [bounds, series.points],
  );
  const points = useMemo(
    () => downsampleMetricPoints(visibleSourcePoints, maxRenderedPoints),
    [maxRenderedPoints, visibleSourcePoints],
  );
  const domain = useMemo(() => yDomain(series), [series]);
  const paths = useMemo(
    () => visibleSegments(series, points, bounds, domain),
    [bounds, domain, points, series],
  );
  const currentPoint = nearestPoint(series.points, cursor);
  const cursorInGap = pointFallsInGap(cursor, series.gaps);
  const currentTimeQuality = currentPoint.timeQuality ?? series.timeQuality;
  const currentProvenance =
    currentPoint.provenance?.source ?? series.provenance.source;
  const currentLabels = {
    ...(series.labels ?? {}),
    ...(currentPoint.labels ?? {}),
  };
  const currentText = cursorInGap
    ? `Missing data at ${formatTimestamp(cursor)}`
    : `${formatValue(currentPoint.value, series.unit)} at ${formatTimestamp(
        currentPoint.timestamp,
      )}`;
  const cursorX = scaleTimestamp(cursor, bounds);
  const cursorY = cursorInGap ? 50 : scaleValue(currentPoint.value, domain);
  const gaps = series.gaps ?? [];
  const interactionKey = (kind: "pointer" | "focus" | "drag") =>
    `${series.id}:${kind}`;

  const timestampFromPointer = (
    event: PointerEvent<HTMLDivElement>,
  ): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return bounds.from;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return bounds.from + ratio * (bounds.to - bounds.from);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    onInteractionChange(interactionKey("drag"), true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onPointerTimestamp(timestampFromPointer(event), "start");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    onPointerTimestamp(timestampFromPointer(event), "move");
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onPointerTimestamp(timestampFromPointer(event), "end");
    onInteractionChange(interactionKey("drag"), false);
  };

  const onPointerCancel = () => {
    onPointerTimestamp(cursor, "cancel");
    onInteractionChange(interactionKey("drag"), false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onKeyboardCommit();
      return;
    }
    const span = Math.max(1, bounds.to - bounds.from);
    const step = Math.max(1, span / 100);
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = cursor - step;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = cursor + step;
    } else if (event.key === "Home") {
      next = bounds.from;
    } else if (event.key === "End") {
      next = bounds.to;
    }
    if (next == null) return;
    event.preventDefault();
    onKeyboardTimestamp(clamp(next, bounds.from, bounds.to), event.shiftKey);
  };

  return (
    <section
      className="operational-metric-track"
      data-testid={`operational-metric-track-${series.id}`}
    >
      <header className="operational-metric-track__header">
        <div>
          <strong>{series.name}</strong>
          <span className="operational-metric-track__unit">{series.unit}</span>
        </div>
        <span
          className="operational-metric-track__reading"
          data-testid={`operational-metric-reading-${series.id}`}
        >
          {currentText}
        </span>
      </header>
      <div
        className="operational-metric-track__plot"
        role="slider"
        tabIndex={0}
        aria-label={`${series.name} shared time cursor`}
        aria-valuemin={bounds.from}
        aria-valuemax={bounds.to}
        aria-valuenow={Math.round(cursor)}
        aria-valuetext={currentText}
        aria-keyshortcuts="Enter Space"
        style={
          {
            "--metric-cursor-position": `${cursorX}%`,
            "--metric-reading-position": `${cursorY}%`,
          } as CSSProperties
        }
        onPointerEnter={() => {
          onInteractionChange(interactionKey("pointer"), true);
        }}
        onPointerLeave={() => {
          onInteractionChange(interactionKey("pointer"), false);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onFocus={() => {
          onInteractionChange(interactionKey("focus"), true);
        }}
        onBlur={() => {
          onInteractionChange(interactionKey("focus"), false);
        }}
        onKeyDown={onKeyDown}
      >
        <svg
          viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={`${series.id}-metric-title ${series.id}-metric-description`}
        >
          <title id={`${series.id}-metric-title`}>
            {series.name} over shared time
          </title>
          <desc id={`${series.id}-metric-description`}>
            {`${formatValue(domain.min, series.unit)} to ${formatValue(
              domain.max,
              series.unit,
            )}. ${series.gaps?.length ?? 0} explicitly missing interval${
              series.gaps?.length === 1 ? "" : "s"
            }.`}
          </desc>
          {gaps.map((gap) => {
            const x = scaleTimestamp(gap.from, bounds);
            const width =
              scaleTimestamp(gap.to, bounds) - scaleTimestamp(gap.from, bounds);
            return (
              <rect
                key={`${gap.from}-${gap.to}`}
                className="operational-metric-track__gap"
                data-testid={`operational-metric-gap-${series.id}`}
                x={x}
                y={0}
                width={Math.max(0.3, width)}
                height={VIEWBOX_SIZE}
              >
                <title>
                  Missing data from {formatTimestamp(gap.from)} to{" "}
                  {formatTimestamp(gap.to)}
                  {gap.reason ? `. ${gap.reason}` : ""}
                </title>
              </rect>
            );
          })}
          {selection ? (
            <rect
              className="operational-metric-track__selection"
              data-testid={`operational-metric-selection-${series.id}`}
              x={scaleTimestamp(selection.from, bounds)}
              y={0}
              width={
                scaleTimestamp(selection.to, bounds) -
                scaleTimestamp(selection.from, bounds)
              }
              height={VIEWBOX_SIZE}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {(series.thresholds ?? []).map((threshold) => (
            <line
              key={threshold.id}
              className={`operational-metric-track__threshold operational-metric-track__threshold--${threshold.severity}`}
              x1={0}
              x2={VIEWBOX_SIZE}
              y1={scaleValue(threshold.value, domain)}
              y2={scaleValue(threshold.value, domain)}
            />
          ))}
          {paths.map((path, index) => (
            <path
              key={`${series.id}-segment-${index}`}
              className="operational-metric-track__line"
              data-testid={`operational-metric-segment-${series.id}`}
              d={path}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            className="operational-metric-track__crosshair"
            data-testid={`operational-metric-crosshair-${series.id}`}
            x1={cursorX}
            x2={cursorX}
            y1={0}
            y2={VIEWBOX_SIZE}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          className="operational-metric-track__scale-label operational-metric-track__scale-label--max"
          aria-hidden="true"
        >
          Max {formatValue(domain.max, series.unit)}
        </span>
        <span
          className="operational-metric-track__scale-label operational-metric-track__scale-label--min"
          aria-hidden="true"
        >
          Min {formatValue(domain.min, series.unit)}
        </span>
        {showReading ? (
          <span
            aria-hidden="true"
            className="operational-metric-track__hover-reading"
            data-testid={`operational-metric-hover-reading-${series.id}`}
          >
            {currentText}
          </span>
        ) : null}
      </div>
      <footer className="operational-metric-track__details">
        <span>
          Scale {formatValue(domain.min, series.unit)}–
          {formatValue(domain.max, series.unit)}
        </span>
        <span>
          {currentTimeQuality === "wall"
            ? "Wall clock"
            : "Time quality: " + currentTimeQuality}
        </span>
        <span>Source: {currentProvenance}</span>
        {Object.entries(currentLabels).map(([label, value]) => (
          <span key={label}>
            {label}: {value}
          </span>
        ))}
        {(series.thresholds ?? []).map((threshold) => (
          <span key={threshold.id}>
            Threshold {threshold.label}:{" "}
            {formatValue(threshold.value, series.unit)} ({threshold.severity})
          </span>
        ))}
        {gaps.length > 0 ? (
          <details className="operational-metric-track__gaps">
            <summary>
              {gaps.length} data gap{gaps.length === 1 ? "" : "s"}
            </summary>
            <div
              className="operational-metric-track__gap-popover"
              role="note"
              aria-label={`${series.name} missing intervals`}
            >
              <strong>Missing intervals</strong>
              <ul>
                {gaps.map((gap) => (
                  <li key={`${gap.from}-${gap.to}`}>
                    <time dateTime={new Date(gap.from * 1_000).toISOString()}>
                      {formatTimestamp(gap.from)}
                    </time>
                    {" – "}
                    <time dateTime={new Date(gap.to * 1_000).toISOString()}>
                      {formatTimestamp(gap.to)}
                    </time>
                    {gap.reason ? <span>{gap.reason}</span> : null}
                  </li>
                ))}
              </ul>
              <p>
                The line stays broken; missing samples are not interpolated.
              </p>
            </div>
          </details>
        ) : null}
      </footer>
    </section>
  );
}

export function OperationalMetricTracks({
  document,
  presentation = "stacked",
  density = "standard",
  sharedTimeBounds,
  visibleTimeBounds,
  cursorTimestamp,
  selectedRange,
  maxRenderedPointsPerTrack = 240,
  onCursorChange,
  cursorReadingsVisible,
  onCursorReadingsVisibleChange,
  onRangeSelect,
  onSeekTimestamp,
}: OperationalMetricTracksProps) {
  const documentBounds = useMemo(
    () => metricDocumentTimeRange(document),
    [document],
  );
  const bounds = useMemo(() => {
    const fullBounds = resolveTimeBounds(documentBounds, sharedTimeBounds);
    return visibleTimeBounds
      ? clampMetricRange(visibleTimeBounds, fullBounds)
      : fullBounds;
  }, [documentBounds, sharedTimeBounds, visibleTimeBounds]);
  const [internalCursor, setInternalCursor] = useState(bounds.from);
  const [internalCursorReadingsVisible, setInternalCursorReadingsVisible] =
    useState(false);
  const activeInteractions = useRef(new Set<string>());
  const [internalSelection, setInternalSelection] =
    useState<OperationalMetricRange | null>(null);
  const selectionStart = useRef<number | null>(null);
  const cursor = clamp(
    cursorTimestamp ?? internalCursor,
    bounds.from,
    bounds.to,
  );
  const requestedSelection =
    selectedRange === undefined ? internalSelection : selectedRange;
  const selection = requestedSelection
    ? clampMetricRange(requestedSelection, bounds)
    : null;
  const showCursorReadings =
    cursorReadingsVisible ?? internalCursorReadingsVisible;

  const updateInteraction = (key: string, active: boolean) => {
    const next = new Set(activeInteractions.current);
    if (active) next.add(key);
    else next.delete(key);
    activeInteractions.current = next;
    const visible = next.size > 0;
    setInternalCursorReadingsVisible(visible);
    onCursorReadingsVisibleChange?.(visible);
  };

  const updateCursor = (timestamp: number) => {
    const bounded = clamp(timestamp, bounds.from, bounds.to);
    setInternalCursor(bounded);
    onCursorChange?.(bounded);
  };

  const updateSelection = (range: OperationalMetricRange | null) => {
    const bounded = range ? clampMetricRange(range, bounds) : null;
    setInternalSelection(bounded);
    onRangeSelect?.(bounded);
  };

  const onPointerTimestamp = (
    timestamp: number,
    phase: "start" | "move" | "end" | "cancel",
  ) => {
    if (phase === "cancel") {
      selectionStart.current = null;
      updateSelection(null);
      return;
    }
    if (phase === "end" && selectionStart.current == null) return;
    updateCursor(timestamp);
    if (phase === "start") {
      selectionStart.current = timestamp;
      updateSelection(null);
      return;
    }
    if (selectionStart.current != null) {
      updateSelection({ from: selectionStart.current, to: timestamp });
    }
    if (phase === "end") {
      selectionStart.current = null;
      onSeekTimestamp?.(clamp(timestamp, bounds.from, bounds.to));
    }
  };

  const onKeyboardTimestamp = (timestamp: number, extendRange: boolean) => {
    if (extendRange) {
      const anchor = selection?.from ?? cursor;
      updateSelection({ from: anchor, to: timestamp });
    } else {
      updateSelection(null);
    }
    updateCursor(timestamp);
  };

  const onKeyboardCommit = () => {
    onSeekTimestamp?.(clamp(cursor, bounds.from, bounds.to));
  };

  return (
    <section
      className={`operational-metric-tracks operational-metric-tracks--${presentation} operational-metric-tracks--density-${density}`}
      aria-label={`${document.name} operational metrics`}
      data-schema-version={document.schemaVersion}
      data-presentation={presentation}
      data-density={density}
      data-shared-plot-alignment={
        density === "compact" ? "outer-content" : "inset"
      }
    >
      <header className="operational-metric-tracks__header">
        <div>
          <h3>{document.name}</h3>
          <p>
            {document.series.length} aligned metric tracks · shared UTC cursor
          </p>
        </div>
        <output aria-live="polite">
          {formatTimestamp(cursor)}
          {selection
            ? ` · selected ${formatTimestamp(selection.from)}–${formatTimestamp(
                selection.to,
              )}`
            : ""}
        </output>
      </header>
      <div className="operational-metric-tracks__axis" aria-hidden="true">
        <span>{formatTimestamp(bounds.from)}</span>
        <span>{formatTimestamp(bounds.to)}</span>
      </div>
      <div className="operational-metric-tracks__stack">
        {document.series.map((series) => (
          <MetricTrack
            key={series.id}
            series={series}
            bounds={bounds}
            cursor={cursor}
            selection={selection}
            maxRenderedPoints={maxRenderedPointsPerTrack}
            showReading={showCursorReadings}
            onInteractionChange={updateInteraction}
            onPointerTimestamp={onPointerTimestamp}
            onKeyboardTimestamp={onKeyboardTimestamp}
            onKeyboardCommit={onKeyboardCommit}
          />
        ))}
      </div>
    </section>
  );
}
