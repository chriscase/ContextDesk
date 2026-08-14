import type { TurnProgressView } from "../lib/turn";

function elapsedLabel(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `+${Math.round(elapsedMs)} ms`;
  return `+${(elapsedMs / 1_000).toFixed(1)} s`;
}

/**
 * Read-only timeline over core's shared progress projection. Activity explains
 * execution only; it is never an evidence or citation surface.
 */
export function TurnProgressTimeline({
  events,
  live,
}: {
  events: TurnProgressView[];
  live: boolean;
}) {
  if (events.length === 0) return null;
  return (
    <details
      className="turn-progress"
      open={live}
      data-testid="turn-progress-timeline"
    >
      <summary>
        Investigation activity · {events.length} {events.length === 1 ? "event" : "events"}
      </summary>
      <ol className="turn-progress__list">
        {events.map((event, index) => {
          const diagnostics =
            event.detail || event.status || event.candidateId;
          return (
            <li
              key={`${event.stage}-${event.phase}-${event.elapsedMs}-${index}`}
              className="turn-progress__event"
              data-active={live && index === events.length - 1 ? "true" : undefined}
            >
              <span className="turn-progress__elapsed">
                {elapsedLabel(event.elapsedMs)}
              </span>
              <span className="turn-progress__label">{event.label}</span>
              {diagnostics ? (
                <details className="turn-progress__diagnostics">
                  <summary>Diagnostics</summary>
                  <dl>
                    <div>
                      <dt>Stage</dt>
                      <dd>{event.stage}</dd>
                    </div>
                    <div>
                      <dt>Phase</dt>
                      <dd>{event.phase}</dd>
                    </div>
                    {event.status ? (
                      <div>
                        <dt>Status</dt>
                        <dd>{event.status}</dd>
                      </div>
                    ) : null}
                    {event.candidateId ? (
                      <div>
                        <dt>Candidate</dt>
                        <dd>{event.candidateId}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {event.detail ? <pre>{event.detail}</pre> : null}
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
