/**
 * Windowed virtual list for log events (#483).
 * Only renders rows in the visible scroll window (+ overscan).
 */
import { useCallback, useMemo, useRef, useState, type UIEvent } from "react";
import type { ExplorerEventDto, TimeQuality } from "../../lib/host";
import { formatEventTime, timeQualityLabel } from "../../lib/logExplorer/types";

const DEFAULT_ROW = 28;
const OVERSCAN = 12;

type Props = {
  events: ExplorerEventDto[];
  timeQuality: TimeQuality;
  selected: Set<number>;
  highlight: Set<number>;
  density: "comfortable" | "compact";
  scrollToSeq?: number | null;
  onRowClick: (e: ExplorerEventDto, multi: boolean) => void;
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
  scrollToSeq,
  onRowClick,
  "aria-label": ariaLabel = "Log events",
}: Props) {
  const rowH = density === "compact" ? 22 : DEFAULT_ROW;
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  // Measure viewport once mounted / on resize
  const setRef = useCallback((el: HTMLDivElement | null) => {
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el) setViewportH(el.clientHeight || 400);
  }, []);

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
      onScroll={onScroll}
    >
      <div
        className="log-explorer__virtual-spacer"
        style={{ height: totalH, position: "relative" }}
      >
        {slice.map((e, i) => {
          const index = start + i;
          const tq = e.timeQuality ?? timeQuality;
          return (
            <div
              key={e.seq}
              role="listitem"
              tabIndex={0}
              data-seq={e.seq}
              data-index={index}
              className={[
                "log-explorer__row",
                selected.has(e.seq) ? "log-explorer__row--selected" : "",
                highlight.has(e.seq) ? "log-explorer__row--highlight" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                position: "absolute",
                top: index * rowH,
                left: 0,
                right: 0,
                height: rowH,
              }}
              onClick={(ev) =>
                onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey)
              }
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onRowClick(e, ev.metaKey || ev.ctrlKey || ev.shiftKey);
                }
              }}
            >
              <span className="log-explorer__ts" title={timeQualityLabel(tq)}>
                {formatEventTime(e.ts, tq)}
              </span>
              <span className={levelClass(e.level)}>{e.level}</span>
              <span className="log-explorer__source" title={e.source}>
                {e.source}
              </span>
              <span className="log-explorer__msg" title={e.message}>
                {e.message}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
