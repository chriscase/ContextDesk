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
  useEffect,
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
import type { AlignedLaneRow } from "../../lib/logExplorer/alignment";

const DEFAULT_ROW = 28;
const OVERSCAN = 12;
const PREVIEW_LINE_HEIGHT = 18;
const PREVIEW_VERTICAL_CHROME = 12;
const APPROX_PREVIEW_CHARS_PER_LINE = 80;

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
  /** Shared time-slot model used only by fail-closed wall-clock Align mode. */
  alignedRows?: AlignedLaneRow<ExplorerEventDto>[];
  /** Shared scroll coordinate for aligned lanes. */
  linkedScrollTop?: number;
  onLinkedScrollTop?: (scrollTop: number) => void;
  /** Keep the lane-local column heading aligned with horizontal row scroll. */
  onHorizontalScroll?: (scrollLeft: number) => void;
  scrollToSeq?: number | null;
  /** One-shot keyboard focus target paired with an explicit seek. */
  focusToSeq?: number | null;
  /** Called after the requested row is mounted and receives focus. */
  onFocusToSeq?: (seq: number) => void;
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

export function eventRowHeight(
  e: ExplorerEventDto,
  lineMode: LineMode,
  expanded: boolean,
  compactH: number,
  previewLines: number,
  displayedMessage = e.message,
): number {
  const rowExpanded = expanded;
  const wrapText = lineMode === "full" || lineMode === "wrap" || rowExpanded;
  if (!wrapText) return compactH;
  const maxLines =
    lineMode === "full" && !rowExpanded
      ? Math.min(24, previewLines * 2)
      : previewLines;
  const lines = Math.min(
    maxLines,
    displayedMessage.split(/\r?\n/).reduce(
      (total, line) =>
        total +
        Math.max(1, Math.ceil(line.length / APPROX_PREVIEW_CHARS_PER_LINE)),
      0,
    ),
  );
  if (lines <= 1) return compactH;
  return Math.max(
    compactH,
    lines * PREVIEW_LINE_HEIGHT + PREVIEW_VERTICAL_CHROME,
  );
}

export function centeredLiteralExcerpt(
  message: string,
  keyword: string,
): string {
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
  alignedRows,
  linkedScrollTop,
  onLinkedScrollTop,
  onHorizontalScroll,
  scrollToSeq,
  focusToSeq,
  onFocusToSeq,
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
  const maxPreviewLines =
    lineMode === "full"
      ? Math.min(24, boundedPreviewLines * 2)
      : boundedPreviewLines;
  const edgeRowH =
    lineMode === "compact"
      ? baseRowH
      : Math.max(
          baseRowH,
          maxPreviewLines * PREVIEW_LINE_HEIGHT + PREVIEW_VERTICAL_CHROME,
        );
  const displayRows = useMemo<AlignedLaneRow<ExplorerEventDto>[]>(
    () =>
      alignedRows ??
      events.map((event) => {
        const matchExcerpt = matchExcerpts?.[event.seq];
        const filterExcerpt =
          !matchExcerpt && filterKeyword
            ? centeredLiteralExcerpt(event.message, filterKeyword)
            : null;
        return {
          key: String(event.seq),
          ts: event.ts,
          event,
          height: eventRowHeight(
            event,
            lineMode,
            expandedSeqs?.has(event.seq) ?? false,
            compactH,
            boundedPreviewLines,
            matchExcerpt ?? filterExcerpt ?? event.message,
          ),
        };
      }),
    [
      alignedRows,
      boundedPreviewLines,
      compactH,
      events,
      expandedSeqs,
      filterKeyword,
      lineMode,
      matchExcerpts,
    ],
  );

  const timeRange = useMemo(() => {
    if (displayRows.length === 0) {
      return { minTs: undefined, maxTs: undefined };
    }
    return {
      minTs: displayRows[0]!.ts,
      maxTs: displayRows[displayRows.length - 1]!.ts,
    };
  }, [displayRows]);
  const gridCols = `${colWidths[0]}rem ${colWidths[1]}rem minmax(${colWidths[2]}rem, ${colWidths[2] + 2}rem) minmax(${colWidths[3]}rem, 1fr)`;
  const parentRef = useRef<HTMLDivElement>(null);
  const onHorizontalScrollRef = useRef(onHorizontalScroll);
  onHorizontalScrollRef.current = onHorizontalScroll;
  const onNearBottomRef = useRef(onNearBottom);
  onNearBottomRef.current = onNearBottom;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const edgeCooldown = useRef(0);

  const { heights, offsets, totalH } = useMemo(() => {
    const heights: number[] = new Array(displayRows.length);
    const offsets: number[] = new Array(displayRows.length);
    let acc = 0;
    for (let i = 0; i < displayRows.length; i++) {
      offsets[i] = acc;
      const row = displayRows[i]!;
      heights[i] = row.height;
      acc += row.height;
    }
    return { heights, offsets, totalH: acc };
  }, [displayRows]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
      onLinkedScrollTop?.(el.scrollTop);
      onHorizontalScroll?.(el.scrollLeft);
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
    [
      onHorizontalScroll,
      onLinkedScrollTop,
      onNearBottom,
      onNearTop,
      edgeRowH,
    ],
  );

  useEffect(() => {
    const el = parentRef.current;
    if (!el || !onNearBottomRef.current || el.clientHeight <= 0) return;
    // A short first page may not create a scrollbar. Prefetch until the
    // viewport is useful (or the parent reports the end) so removing routine
    // paging buttons cannot strand the user.
    if (el.scrollHeight > el.clientHeight + edgeRowH) return;
    const now = Date.now();
    if (now - edgeCooldown.current < 200) return;
    edgeCooldown.current = now;
    onNearBottomRef.current();
  }, [displayRows.length, edgeRowH, viewportH]);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el) setViewportH(el.clientHeight || 400);
  }, []);

  useLayoutEffect(() => {
    onHorizontalScrollRef.current?.(parentRef.current?.scrollLeft ?? 0);
    return () => onHorizontalScrollRef.current?.(0);
  }, []);

  useLayoutEffect(() => {
    if (displayRows.length === 0) {
      onHorizontalScrollRef.current?.(0);
    }
  }, [displayRows.length]);

  const previousLayout = useRef<{
    keys: string[];
    offsets: number[];
    heights: number[];
  } | null>(null);
  useLayoutEffect(() => {
    const el = parentRef.current;
    const prior = previousLayout.current;
    if (el && prior && prior.keys.length > 0) {
      const oldTop = el.scrollTop;
      let anchorIndex = prior.keys.length - 1;
      for (let index = 0; index < prior.keys.length; index += 1) {
        const bottom =
          (prior.offsets[index] ?? 0) + (prior.heights[index] ?? compactH);
        if (bottom > oldTop) {
          anchorIndex = index;
          break;
        }
      }
      const anchorKey = prior.keys[anchorIndex];
      const nextIndex = displayRows.findIndex((row) => row.key === anchorKey);
      if (nextIndex >= 0) {
        const withinRow = oldTop - (prior.offsets[anchorIndex] ?? 0);
        const nextTop = Math.max(0, (offsets[nextIndex] ?? 0) + withinRow);
        if (nextTop !== oldTop) {
          el.scrollTop = nextTop;
          setScrollTop(nextTop);
        }
      }
    }
    previousLayout.current = {
      keys: displayRows.map((row) => row.key),
      offsets: [...offsets],
      heights: [...heights],
    };
  }, [displayRows, offsets, heights, compactH]);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el == null || linkedScrollTop == null) return;
    if (Math.abs(el.scrollTop - linkedScrollTop) <= 1) return;
    el.scrollTop = linkedScrollTop;
    setScrollTop(linkedScrollTop);
  }, [linkedScrollTop]);

  const lastScrollSeq = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (scrollToSeq == null || scrollToSeq === lastScrollSeq.current) return;
    const el = parentRef.current;
    const idx = displayRows.findIndex((row) => row.event?.seq === scrollToSeq);
    // A backend seek usually announces its target before the replacement
    // resident page commits. Do not consume the target against stale rows.
    if (!el || idx < 0) return;
    const top = Math.max(0, (offsets[idx] ?? 0) - viewportH / 3);
    el.scrollTop = top;
    setScrollTop(top);
    lastScrollSeq.current = scrollToSeq;
  }, [displayRows, offsets, scrollToSeq, viewportH]);

  let start = 0;
  {
    let lo = 0;
    let hi = displayRows.length;
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
      end < displayRows.length &&
      (offsets[end] ?? 0) < viewBottom + OVERSCAN * compactH
    ) {
      end++;
    }
    end = Math.min(displayRows.length, end + OVERSCAN);
  }
  const slice = useMemo(
    () => displayRows.slice(start, end),
    [displayRows, start, end],
  );

  useLayoutEffect(() => {
    if (focusToSeq == null) return;
    const row = parentRef.current?.querySelector<HTMLElement>(
      `[data-seq="${focusToSeq}"]`,
    );
    if (!row) return;
    row.focus();
    onFocusToSeq?.(focusToSeq);
  }, [focusToSeq, onFocusToSeq, slice]);

  if (displayRows.length === 0) {
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
      data-aligned-slots={alignedRows?.length}
      data-rendered={slice.length}
      data-total-height={totalH}
      data-edge-trigger-rows={EDGE_TRIGGER_ROWS}
      onScroll={onScroll}
    >
      <div
        className="log-explorer__virtual-spacer"
        style={{ height: totalH, position: "relative" }}
      >
        {slice.map((row, i) => {
          const index = start + i;
          const h = heights[index] ?? compactH;
          const top = offsets[index] ?? index * compactH;
          const e = row.event;
          if (e == null) {
            return (
              <div
                key={row.key}
                className="log-explorer__aligned-gap"
                data-testid="aligned-gap"
                data-align-key={row.key}
                data-ts={row.ts}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top,
                  left: 0,
                  right: 0,
                  height: h,
                }}
              />
            );
          }
          const tq = e.timeQuality ?? timeQuality;
          const rowExpanded = expandedSeqs?.has(e.seq) ?? false;
          const wrapText =
            lineMode === "full" || lineMode === "wrap" || rowExpanded;
          const visiblePreviewLines =
            lineMode === "full" && !rowExpanded
              ? Math.min(24, boundedPreviewLines * 2)
              : boundedPreviewLines;
          const long = e.message.length > 80 || e.message.includes("\n");
          const matchExcerpt = matchExcerpts?.[e.seq];
          const filterExcerpt =
            !matchExcerpt && filterKeyword
              ? centeredLiteralExcerpt(e.message, filterKeyword)
              : null;
          const visibleMessage = matchExcerpt ?? filterExcerpt ?? e.message;
          const excerpted = visibleMessage !== e.message;
          const previewTruncated = !wrapText
            ? long
            : e.message.split(/\r?\n/).length > visiblePreviewLines ||
              e.message.length > visiblePreviewLines * 100;
          return (
            <div
              key={row.key}
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
