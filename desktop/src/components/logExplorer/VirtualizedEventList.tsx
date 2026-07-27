/**
 * Windowed virtual list for log events (#483).
 * Only renders rows in the visible scroll window (+ overscan).
 * Edge proximity notifies parent for bidirectional paging (#538).
 *
 * Variable-height policy (#537): wrap/full/expanded rows use larger heights;
 * total scroll height and every row offset include those heights so expanded
 * rows never overlap following content.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import type { ExplorerEventDto, TimeQuality } from "../../lib/host";
import {
  EDGE_TRIGGER_ROWS,
  nearBottom,
  nearTop,
} from "../../lib/logExplorer/residentWindow";
import {
  formatEventTime,
  formatEventTimeTitle,
} from "../../lib/logExplorer/types";

const DEFAULT_ROW = 28;
const OVERSCAN = 12;
const PREVIEW_LINE_HEIGHT = 18;
const PREVIEW_VERTICAL_CHROME = 12;

export type LineMode = "compact" | "wrap" | "full";

type Props = {
  events: ExplorerEventDto[];
  timeQuality: TimeQuality;
  selected: Set<number>;
  highlight: Set<number>;
  /** Backend-produced bounded, hit-centered excerpts keyed by stable event. */
  matchExcerpts?: Record<number, string>;
  /** Active literal Filter term for centered presentation of resident rows. */
  filterKeyword?: string | null;
  density: "comfortable" | "compact";
  lineMode?: LineMode;
  /** User-selected bounded preview depth; inspector always shows the complete event. */
  previewLines?: number;
  /** Column widths in rem: [ts, level, source, message]. */
  colWidths?: [number, number, number, number];
  scrollToSeq?: number | null;
  expandedSeqs?: Set<number>;
  onToggleExpand?: (seq: number) => void;
  onRowClick: (e: ExplorerEventDto, multi: boolean) => void;
  onNearTop?: () => void;
  onNearBottom?: () => void;
  "aria-label"?: string;
};

function levelClass(level: string): string {
  const l = level.toLowerCase();
  return `log-explorer__level log-explorer__level--${l}`;
}

function rowHeightFor(
  _e: ExplorerEventDto,
  lineMode: LineMode,
  expanded: boolean,
  compactH: number,
  wrapH: number,
  previewLines: number,
): number {
  const rowExpanded = expanded;
  const wrapText = lineMode === "full" || lineMode === "wrap" || rowExpanded;
  if (!wrapText) return compactH;
  if (lineMode === "wrap" && !rowExpanded) return wrapH;
  const lines =
    lineMode === "full" && !rowExpanded
      ? Math.min(24, previewLines * 2)
      : previewLines;
  return Math.max(
    compactH,
    lines * PREVIEW_LINE_HEIGHT + PREVIEW_VERTICAL_CHROME,
  );
}

function centeredLiteralExcerpt(message: string, keyword: string): string {
  const index = message.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0 || message.length <= 160) return message;
  const from = Math.max(0, index - 60);
  const to = Math.min(message.length, index + keyword.length + 80);
  return `${from > 0 ? "…" : ""}${message.slice(from, to)}${
    to < message.length ? "…" : ""
  }`;
}

export function VirtualizedEventList({
  events,
  timeQuality,
  selected,
  highlight,
  matchExcerpts,
  filterKeyword,
  density,
  lineMode = "compact",
  previewLines = 4,
  colWidths = [7.5, 3.5, 8, 1],
  scrollToSeq,
  expandedSeqs,
  onToggleExpand,
  onRowClick,
  onNearTop,
  onNearBottom,
  "aria-label": ariaLabel = "Log events",
}: Props) {
  const baseRowH = density === "compact" ? 22 : DEFAULT_ROW;
  const compactH = baseRowH;
  const boundedPreviewLines = Math.min(12, Math.max(2, previewLines));
  const wrapH =
    lineMode === "wrap"
      ? Math.max(
          baseRowH,
          boundedPreviewLines * PREVIEW_LINE_HEIGHT +
            PREVIEW_VERTICAL_CHROME,
        )
      : baseRowH;
  const edgeRowH = wrapH;

  const timeRange = useMemo(() => {
    if (events.length === 0) return { minTs: undefined, maxTs: undefined };
    let minTs = events[0]!.ts;
    let maxTs = events[0]!.ts;
    for (const e of events) {
      if (e.ts < minTs) minTs = e.ts;
      if (e.ts > maxTs) maxTs = e.ts;
    }
    return { minTs, maxTs };
  }, [events]);
  const gridCols = `${colWidths[0]}rem ${colWidths[1]}rem minmax(${colWidths[2]}rem, ${colWidths[2] + 2}rem) minmax(${colWidths[3]}rem, 1fr)`;
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const edgeCooldown = useRef(0);

  const { heights, offsets, totalH } = useMemo(() => {
    const heights: number[] = new Array(events.length);
    const offsets: number[] = new Array(events.length);
    let acc = 0;
    for (let i = 0; i < events.length; i++) {
      offsets[i] = acc;
      const e = events[i]!;
      const h = rowHeightFor(
        e,
        lineMode,
        expandedSeqs?.has(e.seq) ?? false,
        compactH,
        wrapH,
        boundedPreviewLines,
      );
      heights[i] = h;
      acc += h;
    }
    return { heights, offsets, totalH: acc };
  }, [
    events,
    expandedSeqs,
    lineMode,
    compactH,
    wrapH,
    boundedPreviewLines,
  ]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
      const now = Date.now();
      if (now - edgeCooldown.current < 200) return;
      if (nearTop(el.scrollTop, edgeRowH)) {
        edgeCooldown.current = now;
        onNearTop?.();
      } else if (
        nearBottom(el.scrollTop, el.clientHeight, el.scrollHeight, edgeRowH)
      ) {
        edgeCooldown.current = now;
        onNearBottom?.();
      }
    },
    [onNearBottom, onNearTop, edgeRowH],
  );

  const setRef = useCallback((el: HTMLDivElement | null) => {
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el) setViewportH(el.clientHeight || 400);
  }, []);

  const previousLayout = useRef<{
    seqs: number[];
    offsets: number[];
    heights: number[];
  } | null>(null);
  useLayoutEffect(() => {
    const el = parentRef.current;
    const prior = previousLayout.current;
    if (el && prior && prior.seqs.length > 0) {
      const oldTop = el.scrollTop;
      let anchorIndex = prior.seqs.length - 1;
      for (let index = 0; index < prior.seqs.length; index += 1) {
        const bottom =
          (prior.offsets[index] ?? 0) + (prior.heights[index] ?? compactH);
        if (bottom > oldTop) {
          anchorIndex = index;
          break;
        }
      }
      const anchorSeq = prior.seqs[anchorIndex];
      const nextIndex = events.findIndex((event) => event.seq === anchorSeq);
      if (nextIndex >= 0) {
        const withinRow = oldTop - (prior.offsets[anchorIndex] ?? 0);
        const nextTop = Math.max(
          0,
          (offsets[nextIndex] ?? 0) + withinRow,
        );
        if (nextTop !== oldTop) {
          el.scrollTop = nextTop;
          setScrollTop(nextTop);
        }
      }
    }
    previousLayout.current = {
      seqs: events.map((event) => event.seq),
      offsets: [...offsets],
      heights: [...heights],
    };
  }, [events, offsets, heights, compactH]);

  const lastScrollSeq = useRef<number | null>(null);
  if (scrollToSeq != null && scrollToSeq !== lastScrollSeq.current) {
    lastScrollSeq.current = scrollToSeq;
    const idx = events.findIndex((e) => e.seq === scrollToSeq);
    if (idx >= 0 && parentRef.current) {
      const top = Math.max(0, (offsets[idx] ?? 0) - viewportH / 3);
      queueMicrotask(() => {
        parentRef.current?.scrollTo({ top, behavior: "smooth" });
      });
    }
  }

  let start = 0;
  {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const bottom = (offsets[mid] ?? 0) + (heights[mid] ?? compactH);
      if (bottom < scrollTop) lo = mid + 1;
      else hi = mid;
    }
    start = Math.max(0, lo - OVERSCAN);
  }
  let end = start;
  {
    const viewBottom = scrollTop + viewportH;
    while (
      end < events.length &&
      (offsets[end] ?? 0) < viewBottom + OVERSCAN * compactH
    ) {
      end++;
    }
    end = Math.min(events.length, end + OVERSCAN);
  }
  const slice = useMemo(() => events.slice(start, end), [events, start, end]);

  if (events.length === 0) {
    return (
      <div
        className="log-explorer__rows log-explorer__empty"
        role="list"
        aria-label={ariaLabel}
      >
        No events match filters
      </div>
    );
  }

  return (
    <div
      ref={setRef}
      className="log-explorer__rows log-explorer__rows--virtual"
      role="list"
      aria-label={ariaLabel}
      data-testid="virtualized-event-list"
      data-virtualized="true"
      data-total={events.length}
      data-rendered={slice.length}
      data-total-height={totalH}
      data-edge-trigger-rows={EDGE_TRIGGER_ROWS}
      onScroll={onScroll}
    >
      <div
        className="log-explorer__virtual-spacer"
        style={{ height: totalH, position: "relative" }}
      >
        {slice.map((e, i) => {
          const index = start + i;
          const tq = e.timeQuality ?? timeQuality;
          const rowExpanded = expandedSeqs?.has(e.seq) ?? false;
          const wrapText =
            lineMode === "full" || lineMode === "wrap" || rowExpanded;
          const visiblePreviewLines =
            lineMode === "full" && !rowExpanded
              ? Math.min(24, boundedPreviewLines * 2)
              : boundedPreviewLines;
          const h = heights[index] ?? compactH;
          const top = offsets[index] ?? index * compactH;
          const long = e.message.length > 80 || e.message.includes("\n");
          const matchExcerpt = matchExcerpts?.[e.seq];
          const filterExcerpt =
            !matchExcerpt && filterKeyword
              ? centeredLiteralExcerpt(e.message, filterKeyword)
              : null;
          const visibleMessage = matchExcerpt ?? filterExcerpt ?? e.message;
          const excerpted = visibleMessage !== e.message;
          const previewTruncated =
            !wrapText
              ? long
              : e.message.split(/\r?\n/).length > visiblePreviewLines ||
                e.message.length > visiblePreviewLines * 100;
          return (
            <div
              key={e.seq}
              role="listitem"
              tabIndex={0}
              data-seq={e.seq}
              data-index={index}
              data-expanded={wrapText ? "true" : "false"}
              data-truncated={previewTruncated ? "true" : "false"}
              data-match-excerpt={excerpted ? "true" : "false"}
              className={[
                "log-explorer__row",
                selected.has(e.seq) ? "log-explorer__row--selected" : "",
                highlight.has(e.seq) ? "log-explorer__row--highlight" : "",
                wrapText ? "log-explorer__row--expanded" : "",
                wrapText ? "log-explorer__row--wrap" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                position: "absolute",
                top,
                left: 0,
                right: 0,
                minHeight: h,
                height: h,
                gridTemplateColumns: gridCols,
              }}
              onClick={(ev) =>
                onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey)
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey);
                }
                if (ev.key === "x" || ev.key === "X") {
                  ev.preventDefault();
                  onToggleExpand?.(e.seq);
                }
              }}
            >
              <span
                className="log-explorer__ts"
                title={formatEventTimeTitle(e.ts, tq)}
                aria-label={formatEventTimeTitle(e.ts, tq)}
                tabIndex={0}
                data-testid={`event-time-${e.seq}`}
              >
                {formatEventTime(e.ts, tq, timeRange)}
              </span>
              <span className={levelClass(e.level)}>{e.level}</span>
              <span className="log-explorer__source" title={e.source}>
                {e.source}
              </span>
              <span className="log-explorer__msg-cell">
                <span
                  className={
                    wrapText
                      ? "log-explorer__msg log-explorer__msg--wrap"
                      : "log-explorer__msg"
                  }
                  title={e.message}
                  aria-label={
                    excerpted
                      ? `Match-centered excerpt: ${visibleMessage}. Open the event inspector for the complete message.`
                      : undefined
                  }
                  style={
                    wrapText
                      ? { maxHeight: `${visiblePreviewLines * 1.35}em` }
                      : undefined
                  }
                >
                  {visibleMessage}
                </span>
                {long && lineMode === "compact" ? (
                  <button
                    type="button"
                    className="log-explorer__expand-btn"
                    data-testid={`expand-row-${e.seq}`}
                    aria-expanded={rowExpanded}
                    aria-label={
                      rowExpanded
                        ? `Collapse long message seq ${e.seq}`
                        : `Expand long message seq ${e.seq}`
                    }
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onToggleExpand?.(e.seq);
                    }}
                  >
                    {rowExpanded ? "Collapse" : "Expand"}
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
