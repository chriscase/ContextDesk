/**
 * Shared Activity Inspector content, rendered inside both the Drawer overlay
 * and the Docked rail so the two surfaces cannot drift.
 *
 * Requirement 7's shape: the Summary panel is plain-language progress and is
 * what opens by default. "Technical detail" is a sibling panel a reader opts
 * into, and the per-row disclosures inside the timeline go one level deeper
 * still. A non-power user who opens this sees sentences, not a schema.
 *
 * Every value is live-or-unknown. There is no placeholder data and no
 * fixture import; a fact the host did not report renders as "not reported".
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { nextRovingIndex } from "../../lib/a11y";
import { ActivityEventList } from "./ActivityEventList";
import { ActivityOriginBadge } from "./ActivityOriginBadge";
import { isNondeterministicOrigin, type ActivityTurn } from "../../lib/activity/types";

export type ActivityTabId = "summary" | "technical";

const TAB_LABEL: Record<ActivityTabId, string> = {
  summary: "What happened",
  technical: "Technical detail",
};

function formatElapsed(ms: number | null): string {
  if (ms == null) return "duration not reported";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Unknown is spelled out, never rendered as 0 or a dash with no meaning. */
function fact(n: number | null, unit: string): string {
  if (n == null) return "not reported";
  return `${n.toLocaleString()} ${unit}${n === 1 ? "" : "s"}`;
}

export function ActivityInspectorBody({
  turn,
  titleId,
  onClose,
  closeLabel = "Close",
}: {
  turn: ActivityTurn;
  titleId?: string;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const tabs: ActivityTabId[] = ["summary", "technical"];
  const [active, setActive] = useState<ActivityTabId>("summary");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panelId = useId();

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = tabs.indexOf(active);
    const next = nextRovingIndex(idx, tabs.length, e.key);
    if (next == null) return;
    e.preventDefault();
    const id = tabs[next]!;
    setActive(id);
    tabRefs.current[id]?.focus();
  };

  const deterministic = turn.events.filter(
    (e) => !isNondeterministicOrigin(e.origin),
  ).length;
  const nondeterministic = turn.events.length - deterministic;

  const groundedText =
    turn.summary.grounded === true
      ? "The answer cites sources you can open."
      : turn.summary.grounded === false
        ? "The answer cited no resolvable source."
        : "Grounding is not known for this turn.";

  return (
    <div className="activity-inspector" data-testid="activity-inspector">
      <header className="activity-inspector__head">
        <div className="activity-inspector__title-row">
          <span className="activity-inspector__eyebrow">
            ContextDesk activity
          </span>
          {!turn.liveRecord ? (
            <span
              className="activity-inspector__unrecorded"
              data-testid="activity-not-recorded"
              title="The host did not record a turn activity record for this message. Only what this window observed is shown."
            >
              not recorded by host
            </span>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="activity-inspector__close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              ✕
            </button>
          ) : null}
        </div>
        <div id={titleId} className="activity-inspector__turn-label">
          {turn.label}
        </div>
        <div
          role="tablist"
          aria-label="Activity detail level"
          className="activity-inspector__tabs"
        >
          {tabs.map((id) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`activity-tab-${id}`}
              aria-selected={active === id}
              aria-controls={`${panelId}-${id}`}
              tabIndex={active === id ? 0 : -1}
              className="activity-inspector__tab"
              data-active={active === id ? "true" : "false"}
              data-testid={`activity-tab-${id}`}
              onClick={() => setActive(id)}
              onKeyDown={onTabKeyDown}
            >
              {TAB_LABEL[id]}
            </button>
          ))}
        </div>
      </header>

      <div className="activity-inspector__body">
        {active === "summary" ? (
          <div
            role="tabpanel"
            id={`${panelId}-summary`}
            aria-labelledby="activity-tab-summary"
            className="activity-inspector__panel"
            data-testid="activity-panel-summary"
          >
            <ul className="activity-plain-summary">
              <li>
                This turn took {formatElapsed(turn.elapsedMs)} and made{" "}
                {fact(turn.summary.modelRounds, "model request")}.
              </li>
              <li>
                {deterministic} step{deterministic === 1 ? "" : "s"} were fixed
                app work; {nondeterministic} involved a model or an outside
                system.
              </li>
              <li>{groundedText}</li>
              {turn.droppedEvents > 0 ? (
                <li data-testid="activity-truncated">
                  This is a partial record — {turn.droppedEvents} later step
                  {turn.droppedEvents === 1 ? " was" : "s were"} dropped by the
                  per-turn retention bound.
                </li>
              ) : null}
            </ul>
            <ActivityEventList events={turn.events} />
          </div>
        ) : null}

        {active === "technical" ? (
          <div
            role="tabpanel"
            id={`${panelId}-technical`}
            aria-labelledby="activity-tab-technical"
            className="activity-inspector__panel"
            data-testid="activity-panel-technical"
          >
            <dl className="activity-technical">
              <div>
                <dt>Context sent</dt>
                <dd>
                  {turn.budget.usedChars == null
                    ? "not reported"
                    : `${turn.budget.usedChars.toLocaleString()} characters`}
                  {turn.budget.totalChars == null
                    ? " (no reported ceiling)"
                    : ` of ${turn.budget.totalChars.toLocaleString()}`}
                </dd>
              </div>
              <div>
                <dt>Contract version</dt>
                <dd>{turn.contractVersion ?? "not recorded"}</dd>
              </div>
              <div>
                <dt>Turn status</dt>
                <dd>{turn.summary.status ?? "not reported"}</dd>
              </div>
            </dl>
            {turn.budget.truncationNote ? (
              <p className="activity-budget__truncation">
                {turn.budget.truncationNote}
              </p>
            ) : null}

            <h4 className="activity-inspector__section-title">Model rounds</h4>
            {turn.requestRounds.length === 0 ? (
              <p className="activity-empty" role="status">
                No provider rounds were recorded for this turn.
              </p>
            ) : (
              <ul className="activity-rounds">
                {turn.requestRounds.map((r) => (
                  <li key={r.id} className="activity-round">
                    <div className="activity-round__head">
                      <ActivityOriginBadge origin="probabilistic_model" />
                      <span>Round {r.index}</span>
                      <span className="activity-round__status">{r.status}</span>
                    </div>
                    <div className="activity-round__tools">
                      <span>
                        Offered:{" "}
                        {r.toolsOffered.length ? r.toolsOffered.join(", ") : "none"}
                      </span>
                      <span>
                        Ran: {r.toolsRun.length ? r.toolsRun.join(", ") : "none"}
                      </span>
                      <span>
                        Context:{" "}
                        {r.contextUsedChars == null
                          ? "not reported"
                          : `${r.contextUsedChars.toLocaleString()} chars`}
                        {r.messagesCapped ? " (prefix)" : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h4 className="activity-inspector__section-title">
              Grounding evidence
            </h4>
            {turn.citations.length === 0 ? (
              <p className="activity-empty" role="status">
                No citations were attached to this answer.
              </p>
            ) : (
              <ul className="activity-citations">
                {turn.citations.map((c) => (
                  <li key={c.id}>
                    <ActivityOriginBadge origin="client_evidence" />{" "}
                    {c.title || c.label}
                  </li>
                ))}
              </ul>
            )}

            <h4 className="activity-inspector__section-title">
              Permission prompts
            </h4>
            {turn.permissions.length === 0 ? (
              <p className="activity-empty" role="status">
                No permission decision was recorded for this turn.
              </p>
            ) : (
              <ul className="activity-permissions">
                {turn.permissions.map((p) => (
                  <li key={p.id}>
                    <ActivityOriginBadge origin="user_decision" /> {p.toolName} —{" "}
                    {p.target} ({p.decision ?? "pending"})
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
