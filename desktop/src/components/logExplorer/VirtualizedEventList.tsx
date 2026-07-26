/**
 * Windowed virtual list for log events (#483).
 * Only renders rows in the visible scroll window (+ overscan).
 * Edge proximity notifies parent for bidirectional paging (#538).
 */
import {
  useCallback,
  useEffect,
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
const EXPANDED_ROW = 96;

export type LineMode = "compact" | "wrap" | "full";

type Props = {
  events: ExplorerEventDto[];
  timeQuality: TimeQuality;
  selected: Set<number>;
  highlight: Set<number>;
  density: "comfortable" | "compact";
  lineMode?: LineMode;
  /** Column widths in rem: [ts, level, source, message]. */
  colWidths?: [number, number, number, number];
  scrollToSeq?: number | null;
  /** Rows prepended — keep visual anchor stable (#538). */
  scrollAnchorAdjust?: number;
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

export function VirtualizedEventList({
  events,
  timeQuality,
  selected,
  highlight,
  density,
  lineMode = "compact",
  colWidths = [7.5, 3.5, 8, 1],
  scrollToSeq,
  scrollAnchorAdjust = 0,
  expandedSeqs,
  onToggleExpand,
  onRowClick,
  onNearTop,
  onNearBottom,
  "aria-label": ariaLabel = "Log events",
}: Props) {
  const baseRowH = density === "compact" ? 22 : DEFAULT_ROW;
  const rowH = lineMode === "wrap" ? Math.max(baseRowH, 44) : baseRowH;
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
  const gridCols = `${colWidths[0]}rem ${colWidths[1]}rem minmax(${colWidths[2]}rem, ${colWidths[2] + 2}rem) minmax(8rem, 1fr)`;
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const edgeCooldown = useRef(0);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
      const now = Date.now();
      if (now - edgeCooldown.current < 200) return;
      if (nearTop(el.scrollTop, rowH)) {
        edgeCooldown.current = now;
        onNearTop?.();
      } else if (
        nearBottom(el.scrollTop, el.clientHeight, el.scrollHeight, rowH)
      ) {
        edgeCooldown.current = now;
        onNearBottom?.();
      }
    },
    [onNearBottom, onNearTop, rowH],
  );

  // Measure viewport once mounted / on resize
  const setRef = useCallback((el: HTMLDivElement | null) => {
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el) setViewportH(el.clientHeight || 400);
  }, []);

  // Preserve visual position when older rows are prepended (#538).
  const lastAnchor = useRef(0);
  useEffect(() => {
    if (scrollAnchorAdjust > 0 && parentRef.current) {
      if (scrollAnchorAdjust !== lastAnchor.current) {
        parentRef.current.scrollTop += scrollAnchorAdjust * rowH;
        lastAnchor.current = scrollAnchorAdjust;
      }
    }
  }, [scrollAnchorAdjust, rowH]);

  // Scroll to seq when requested
  const lastScrollSeq = useRef<number | null>(null);
  if (scrollToSeq != null && scrollToSeq !== lastScrollSeq.current) {
    lastScrollSeq.current = scrollToSeq;
    const idx = events.findIndex((e) => e.seq === scrollToSeq);
    if (idx >= 0 && parentRef.current) {
      const top = Math.max(0, idx * rowH - viewportH / 3);
      // Defer to after paint
      queueMicrotask(() => {
        parentRef.current?.scrollTo({ top, behavior: "smooth" });
      });
    }
  }

  const totalH = events.length * rowH;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2;
  const end = Math.min(events.length, start + visibleCount);
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
          const wrapText = lineMode !== "compact" || rowExpanded;
          const h = wrapText ? EXPANDED_ROW : rowH;
          const long = e.message.length > 80 || e.message.includes("\n");
          return (
            <div
              key={e.seq}
              role="listitem"
              tabIndex={0}
              data-seq={e.seq}
              data-index={index}
              data-expanded={wrapText ? "true" : "false"}
              data-truncated={long && !wrapText ? "true" : "false"}
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
                top: index * rowH,
                left: 0,
                right: 0,
                minHeight: h,
                height: wrapText ? "auto" : rowH,
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
                >
                  {e.message}
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
