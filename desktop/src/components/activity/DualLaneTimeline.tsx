/**
 * The Explorer's docked dual-group view: customer evidence lanes and
 * ContextDesk activity lanes, drawn together.
 *
 * The whole point of this component is the thing it *refuses* to do. It asks
 * `resolveDualLaneAlignment` whether the two groups may share an axis, and:
 *
 *  - `shared_wall_clock` — both sides carry calendar time. One axis, real
 *    dates, and a ContextDesk marker at position X genuinely occurred at X.
 *  - `separate_tracks` — at least one side does not. Two stacked tracks, the
 *    ContextDesk one explicitly labelled "ordered by cause, not by clock",
 *    with the reason stated in words. Activity is still shown in order; it is
 *    simply not dated.
 *
 * The two groups also stay separate in *state*: the customer band is driven
 * by corpus/source/filter/suppression props, and the activity band by
 * correlation identity. Nothing here writes into the corpus, the facets, the
 * search results, or the citation set — it only reads.
 */
import { useMemo } from "react";
import {
  fractionWithinDomain,
  resolveDualLaneAlignment,
} from "../../lib/activity/dualLaneAxis";
import { timeQualityLabel } from "../../lib/activity/importLedger";
import { ActivityOriginBadge } from "./ActivityOriginBadge";
import {
  isWallClock,
  type ActivityEvent,
  type ClientIncidentClock,
} from "../../lib/activity/types";

function formatUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** The customer band's own summary — evidence extent and its honesty level. */
function CustomerBand({
  clock,
  fraction,
}: {
  clock: ClientIncidentClock;
  fraction: number | null;
}) {
  const quality = timeQualityLabel(clock.timeQuality);
  const extent =
    clock.timeQuality === "order_only"
      ? "order only — this evidence carries no calendar time"
      : clock.tsMinMs != null && clock.tsMaxMs != null
        ? `${formatUtc(clock.tsMinMs)} → ${formatUtc(clock.tsMaxMs)}`
        : "no evidence time range reported";
  return (
    <div
      className="dual-lane__band"
      data-group="customer"
      data-testid="dual-lane-customer"
      data-time-quality={clock.timeQuality}
    >
      <div className="dual-lane__band-head">
        <span className="dual-lane__band-title">Customer evidence</span>
        <span className="dual-lane__band-quality">({quality})</span>
      </div>
      <div className="dual-lane__band-extent">{extent}</div>
      <div className="dual-lane__track" aria-hidden="true">
        <div className="dual-lane__track-line" />
        {fraction != null ? (
          <span
            className="dual-lane__marker dual-lane__marker--selected"
            style={{ left: `${fraction * 100}%` }}
            data-testid="dual-lane-selected-marker"
          />
        ) : null}
      </div>
      {clock.selectedTsMs != null && clock.timeQuality !== "order_only" ? (
        <div className="dual-lane__band-selected">
          Selected event: {formatUtc(clock.selectedTsMs)}
        </div>
      ) : null}
    </div>
  );
}

export function DualLaneTimeline({
  clientClock,
  activityEvents,
  onSelectCorrelation,
  selectedCorrelationId,
}: {
  clientClock: ClientIncidentClock;
  activityEvents: readonly ActivityEvent[];
  /** Selecting an activity row highlights its causal chain — activity only. */
  onSelectCorrelation?: (correlationId: string | null) => void;
  selectedCorrelationId?: string | null;
}) {
  const alignment = useMemo(
    () => resolveDualLaneAlignment(clientClock, activityEvents),
    [clientClock, activityEvents],
  );

  const shared = alignment.kind === "shared_wall_clock" ? alignment : null;

  const selectedFraction =
    shared && clientClock.selectedTsMs != null
      ? fractionWithinDomain(clientClock.selectedTsMs, shared.domain)
      : null;

  return (
    <div
      className="dual-lane"
      data-testid="dual-lane-timeline"
      data-alignment={alignment.kind}
    >
      <div
        className="dual-lane__axis-note"
        role="note"
        data-testid="dual-lane-axis-note"
      >
        <strong>{alignment.label}</strong>
        {alignment.kind === "separate_tracks" ? (
          <span className="dual-lane__axis-reason"> — {alignment.reason}</span>
        ) : (
          <span className="dual-lane__axis-reason">
            {" "}
            — {formatUtc(shared!.domain.startMs)} →{" "}
            {formatUtc(shared!.domain.endMs)}
          </span>
        )}
      </div>

      <CustomerBand clock={clientClock} fraction={selectedFraction} />

      <div
        className="dual-lane__band"
        data-group="contextdesk"
        data-testid="dual-lane-contextdesk"
      >
        <div className="dual-lane__band-head">
          <span className="dual-lane__band-title">ContextDesk activity</span>
          <span className="dual-lane__band-quality">
            {shared
              ? "(placed on the shared wall clock)"
              : "(ordered by cause — not calendar time)"}
          </span>
        </div>
        {activityEvents.length === 0 ? (
          <p className="activity-empty" role="status">
            No ContextDesk activity recorded in this view yet.
          </p>
        ) : shared ? (
          <div className="dual-lane__track" data-testid="dual-lane-shared-track">
            <div className="dual-lane__track-line" aria-hidden="true" />
            {activityEvents.map((event) => {
              // Guaranteed wall by `resolveDualLaneAlignment`, which refuses a
              // shared axis unless EVERY activity event carries one.
              const at = isWallClock(event.clock) ? event.clock.atMs : null;
              const fraction =
                at == null ? null : fractionWithinDomain(at, shared.domain);
              return (
                <button
                  key={event.id}
                  type="button"
                  className="dual-lane__marker dual-lane__marker--activity"
                  style={{ left: `${(fraction ?? 0) * 100}%` }}
                  data-origin={event.origin}
                  data-testid="dual-lane-activity-marker"
                  aria-pressed={selectedCorrelationId === event.correlationId}
                  title={`${event.label} — ${at == null ? "" : formatUtc(at)}`}
                  onClick={() =>
                    onSelectCorrelation?.(
                      selectedCorrelationId === event.correlationId
                        ? null
                        : event.correlationId,
                    )
                  }
                >
                  <span className="sr-only">{event.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <ol
            className="dual-lane__sequence"
            data-testid="dual-lane-sequence"
            aria-label="ContextDesk activity in causal order"
          >
            {activityEvents.map((event) => (
              <li key={event.id} data-origin={event.origin}>
                <button
                  type="button"
                  className="dual-lane__sequence-row"
                  aria-pressed={selectedCorrelationId === event.correlationId}
                  data-testid="dual-lane-sequence-row"
                  onClick={() =>
                    onSelectCorrelation?.(
                      selectedCorrelationId === event.correlationId
                        ? null
                        : event.correlationId,
                    )
                  }
                >
                  <ActivityOriginBadge origin={event.origin} />
                  <span className="dual-lane__sequence-label">
                    {event.label}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
