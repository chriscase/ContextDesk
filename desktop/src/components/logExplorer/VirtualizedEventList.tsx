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
  /** Rows prepended — keep visual anchor stable (#538). */
  scrollAnchorAdjust?: number;
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
  scrollToSeq,
  scrollAnchorAdjust = 0,
  onRowClick,
  onNearTop,
  onNearBottom,
  "aria-label": ariaLabel = "Log events",
}: Props) {
  const rowH = density === "compact" ? 22 : DEFAULT_ROW;
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
