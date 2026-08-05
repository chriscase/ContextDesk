/**
 * Timeline list for ContextDesk activity events.
 *
 * Reuses the chat transcript's hand-rolled windowing (`computeWindowPlan`)
 * rather than adding a second virtualizer, so behaviour and performance stay
 * consistent across the app and the default build stays dependency-free.
 *
 * Requirement 7 in one place: each row leads with plain language — what
 * happened, and whether it was deterministic host work or model/external
 * work — and the technical detail (operation id, scope, evidence refs,
 * per-round context shape) is behind a per-row disclosure that a keyboard
 * user can reach in tab order.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OVERSCAN,
  computeWindowPlan,
} from "../shell/messageWindow";
import { ActivityOriginBadge } from "./ActivityOriginBadge";
import { determinismLabel } from "../../lib/activity/originMeta";
import {
  clockQualityLabel,
  type ActivityEvent,
} from "../../lib/activity/types";

const EVENT_ROW_ESTIMATE_PX = 64;
/** Below this count, mount every row. */
export const ACTIVITY_VIRTUALIZE_THRESHOLD = 30;

function formatClock(event: ActivityEvent): string {
  const clock = event.clock;
  switch (clock.kind) {
    case "wall": {
      const d = new Date(clock.atMs);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
    }
    case "elapsed":
      return clock.elapsedMs < 1000
        ? `+${clock.elapsedMs}ms`
        : `+${(clock.elapsedMs / 1000).toFixed(1)}s`;
    case "sequence":
      // No date, no duration — the only honest rendering is the ordinal.
      return `#${clock.seq + 1}`;
  }
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="activity-event-row"
      role="listitem"
      data-testid="activity-event-row"
      data-origin={event.origin}
      data-status={event.status}
      data-clock={event.clock.kind}
    >
      <div className="activity-event-row__head">
        <span
          className="activity-event-row__time"
          title={clockQualityLabel(event.clock)}
        >
          {formatClock(event)}
        </span>
        <ActivityOriginBadge origin={event.origin} />
        <span className="activity-event-row__label">{event.label}</span>
        {event.status !== "ok" ? (
          <span className="activity-event-row__status">{event.status}</span>
        ) : null}
        <button
          type="button"
          className="activity-event-row__more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="activity-event-details-toggle"
        >
          {open ? "Less" : "Detail"}
        </button>
      </div>
      {event.detail ? (
        <p className="activity-event-row__detail">{event.detail}</p>
      ) : null}
      {event.hook ? (
        <p className="activity-event-row__hook">
          Trigger: {event.hook.trigger} · Data scope: {event.hook.dataScope}
        </p>
      ) : null}
      {open ? (
        <dl
          className="activity-event-row__technical"
          data-testid="activity-event-technical"
        >
          <div>
            <dt>Reproducibility</dt>
            <dd>{determinismLabel(event.determinism)}</dd>
          </div>
          <div>
            <dt>Time basis</dt>
            <dd>{clockQualityLabel(event.clock)}</dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{event.operationId}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{event.scope.label}</dd>
          </div>
          {event.context ? (
            <div>
              <dt>Round context</dt>
              <dd>
                {event.context.messageCount} messages ·{" "}
                {event.context.contextUsedChars.toLocaleString()} chars
                {event.context.messagesCapped ? " (captured prefix only)" : ""}
                {event.context.toolNames.length > 0
                  ? ` · offered: ${event.context.toolNames.join(", ")}`
                  : ""}
              </dd>
            </div>
          ) : null}
          {event.evidence && event.evidence.length > 0 ? (
            <div>
              <dt>Evidence</dt>
              <dd>
                {event.evidence
                  .map((e) => `${e.kind}:${e.id}${e.locator ? `@${e.locator}` : ""}`)
                  .join(", ")}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

export function ActivityEventList({
  events,
  emptyLabel = "No ContextDesk activity recorded for this turn.",
  maxHeightPx = 320,
  omittedNote,
}: {
  events: ActivityEvent[];
  emptyLabel?: string;
  maxHeightPx?: number;
  /** Retention/bound disclosure, when entries were dropped. */
  omittedNote?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(maxHeightPx);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setClientHeight(el.clientHeight || maxHeightPx);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [maxHeightPx]);

  const heights = useMemo(
    () => events.map(() => EVENT_ROW_ESTIMATE_PX),
    [events],
  );

  const useVirtualization = events.length > ACTIVITY_VIRTUALIZE_THRESHOLD;

  const plan = useMemo(
    () =>
      computeWindowPlan({
        count: events.length,
        scrollTop,
        clientHeight,
        heights,
        estimatePx: EVENT_ROW_ESTIMATE_PX,
        overscan: DEFAULT_OVERSCAN,
      }),
    [events.length, scrollTop, clientHeight, heights],
  );

  if (events.length === 0) {
    return (
      <p className="activity-empty" role="status">
        {emptyLabel}
      </p>
    );
  }

  const indices = useVirtualization
    ? plan.indices
    : events.map((_, i) => i);

  return (
    <>
      {omittedNote ? (
        <p
          className="activity-feed__omitted"
          role="note"
          data-testid="activity-omitted-note"
        >
          {omittedNote}
        </p>
      ) : null}
      <div
        className="activity-event-list"
        ref={scrollRef}
        style={{ maxHeight: maxHeightPx, overflowY: "auto" }}
        data-virtualized={useVirtualization ? "true" : "false"}
        data-mounted-count={indices.length}
        data-total-count={events.length}
        data-testid="activity-event-list"
        role="list"
        aria-label="ContextDesk activity timeline"
      >
        <div
          style={
            useVirtualization
              ? { position: "relative", height: plan.totalHeight }
              : undefined
          }
        >
          {indices.map((i) => {
            const ev = events[i]!;
            return (
              <div
                key={ev.id}
                style={
                  useVirtualization
                    ? {
                        position: "absolute",
                        top: plan.offsets[i] ?? 0,
                        left: 0,
                        right: 0,
                      }
                    : undefined
                }
              >
                <ActivityRow event={ev} />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
