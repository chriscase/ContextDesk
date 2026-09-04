import {
  INVESTIGATION_ACTIVITY_KINDS,
  INVESTIGATION_STAGES,
  type InvestigationActivityFilterV1,
  type InvestigationActivityItemV1,
} from "@cd-collab/contracts/investigation-activity";
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { groupRepeatedActivity, repeatLabel } from "../activity-grouping.js";
import { EmptyState } from "../graphics.js";
import { statusCounts } from "../investigation-search.js";
import { useActivityCenter } from "./use-activity-center.js";
import type { OverviewGateway } from "./gateway.js";

const STATUS_ORDER = ["open", "monitoring", "resolved", "archived"] as const;
const OPEN_THREAD_KINDS = new Set([
  "workstream_failed", "workstream_partially_completed", "workstream_canceled",
  "comparison_disagreement", "comparison_unknown", "decision_proposed", "decision_revised",
]);

export interface ActivityCenterProps {
  readonly canRead: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly onOpenRoute: (pathname: string) => void;
  readonly onOpenInvestigations: () => void;
  readonly gateway?: OverviewGateway;
}

function titleCase(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Recorded time unavailable" : date.toLocaleString();
}

function provenance(item: InvestigationActivityItemV1): string {
  if (item.provenanceClass === "ai_generated") return "AI-assisted · not a human finding";
  if (item.provenanceClass === "imported") return "Imported · not a human finding";
  if (item.provenanceClass === "historical_restored") return "Restored history · attribution only";
  if (item.provenanceClass === "system") return "Recorded by the system";
  return "Human-authored";
}

function privacy(item: InvestigationActivityItemV1): string | null {
  if (item.privacyVisibility === "owner_only") return "Private to this investigation";
  if (item.privacyVisibility === "redacted") return "Redacted";
  if (item.privacyVisibility === "omitted") return "Content omitted";
  return null;
}

function displayItems(resource: ReturnType<typeof useActivityCenter>["activity"]): readonly InvestigationActivityItemV1[] {
  if (resource.status === "ready") return resource.items;
  if ((resource.status === "loading" || resource.status === "failed") && resource.previous) return resource.previous;
  return [];
}

function failureCopy(kind: string): string {
  if (kind === "invalid_filter") return "Those filters are not valid. Clear them or choose a different range.";
  if (kind === "protocol") return "The activity response could not be validated. Previously loaded activity was not replaced.";
  return "Activity could not be refreshed. Previously loaded activity remains visible when available.";
}

export function ActivityCenter({
  canRead, identityKey, authorityKey, onOpenRoute, onOpenInvestigations, gateway,
}: ActivityCenterProps) {
  const [draftKind, setDraftKind] = useState("");
  const [draftStage, setDraftStage] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [filter, setFilter] = useState<InvestigationActivityFilterV1>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const controller = useActivityCenter({ enabled: canRead, identityKey, authorityKey, filter, ...(gateway ? { gateway } : {}) });
  const items = displayItems(controller.activity);
  const grouped = useMemo(() => groupRepeatedActivity(items), [items]);
  const handoffs = grouped.filter(({ activityKind }) => activityKind === "handoff_recorded");
  const openThreads = grouped.filter(({ activityKind, provenanceClass }) =>
    provenanceClass !== "historical_restored" && OPEN_THREAD_KINDS.has(activityKind));
  const counts = statusCounts(controller.investigations, STATUS_ORDER);
  const filtersActive = Object.keys(filter).length > 0;
  const hasLoadedActivityWindow = controller.activity.status === "ready" || items.length > 0;

  useEffect(() => {
    const refreshRecordedActivity = () => controller.refresh();
    window.addEventListener("contextdesk:triage-run-changed", refreshRecordedActivity);
    return () => window.removeEventListener("contextdesk:triage-run-changed", refreshRecordedActivity);
  }, [controller.refresh]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setFilter({
      ...(draftKind ? { activityKind: draftKind as NonNullable<InvestigationActivityFilterV1["activityKind"]> } : {}),
      ...(draftStage ? { stage: draftStage as NonNullable<InvestigationActivityFilterV1["stage"]> } : {}),
      ...(draftFrom ? { from: `${draftFrom}T00:00:00.000Z` } : {}),
      ...(draftTo ? { to: `${draftTo}T23:59:59.999Z` } : {}),
    });
  }

  function clearFilters() {
    setDraftKind("");
    setDraftStage("");
    setDraftFrom("");
    setDraftTo("");
    setFilter({});
  }

  async function openItem(event: MouseEvent<HTMLAnchorElement>, item: InvestigationActivityItemV1) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpeningId(item.activityId);
    const route = await controller.open(item.locator);
    setOpeningId(null);
    if (route) onOpenRoute(route);
  }

  if (!canRead) {
    return (
      <section className="not-found" aria-labelledby="overview-denied-title" aria-busy="false">
        <h2 className="not-found__title" id="overview-denied-title">Overview unavailable</h2>
        <p className="not-found__copy" role="status">
          Your current account cannot read investigations, so no investigation or activity data was requested.
        </p>
      </section>
    );
  }

  return (
    <section className="overview activity-center" aria-labelledby="overview-title">
      <header className="overview__head activity-center__head">
        <div>
          <p className="overview__eyebrow">Activity Center</p>
          <h2 className="app__area-title" id="overview-title">Operating picture</h2>
          <p className="app__area-copy">
            Recorded work across the War Room. Activity is a projection of investigation records, never a separate source of truth.
          </p>
        </div>
        <button type="button" onClick={controller.refresh}>Refresh</button>
      </header>

      {controller.investigationsLoading ? (
        <p className="overview__counts-status" role="status">Loading recorded investigation counts…</p>
      ) : controller.investigationsFailed ? (
        <p className="case-memory__error" role="status">
          Recorded status counts are temporarily unavailable. Activity remains independent.
        </p>
      ) : (
        <div className="overview__counts-row">
          <dl className="overview__counts" aria-label="Investigations by recorded status">
            {counts.map(([status, count]) => (
              <div key={status} className="overview__count" data-status={status}>
                <dt>{status}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <div className="overview__counts-action">
            <button type="button" onClick={() => onOpenInvestigations()}>View investigations</button>
          </div>
        </div>
      )}

      <form className="activity-center__filters" aria-label="Filter recorded activity" onSubmit={applyFilters}>
        <label>Activity
          <select value={draftKind} onChange={(event) => setDraftKind(event.currentTarget.value)}>
            <option value="">All recorded activity</option>
            {INVESTIGATION_ACTIVITY_KINDS.map((kind) => <option key={kind} value={kind}>{titleCase(kind)}</option>)}
          </select>
        </label>
        <label>Stage
          <select value={draftStage} onChange={(event) => setDraftStage(event.currentTarget.value)}>
            <option value="">All stages</option>
            {INVESTIGATION_STAGES.map((stage) => <option key={stage} value={stage}>{titleCase(stage)}</option>)}
          </select>
        </label>
        <label>From (UTC) <input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.currentTarget.value)} /></label>
        <label>Through (UTC) <input type="date" value={draftTo} onChange={(event) => setDraftTo(event.currentTarget.value)} /></label>
        <div className="activity-center__filter-actions">
          <button type="submit">Apply filters</button>
          <button type="button" onClick={clearFilters} disabled={!filtersActive && !draftKind && !draftStage && !draftFrom && !draftTo}>Clear</button>
        </div>
      </form>

      {controller.activity.status === "failed" ? (
        <div className="case-memory__error activity-center__failure" role="alert">
          <p>{failureCopy(controller.activity.error.kind)}</p>
          <button type="button" onClick={controller.refresh}>Retry</button>
        </div>
      ) : null}
      {controller.openFailure ? (
        <p className="case-memory__error" role="alert">
          That recorded destination could not be opened. Your access may have changed; no other record was shown.
        </p>
      ) : null}

      <div className="overview__grid">
        <section className="overview__activity" aria-labelledby="overview-activity-title" aria-busy={controller.activity.status === "loading"}>
          <header className="overview__section-head">
            <div><p className="overview__eyebrow">Across the War Room</p><h3 id="overview-activity-title">Latest activity</h3>
              <p>Newest recorded changes, with an authorized path back to their source.</p></div>
          </header>
          {controller.activity.status === "loading" && items.length > 0 ? (
            <p className="activity-center__refreshing" role="status">Refreshing recorded activity…</p>
          ) : null}
          {controller.activity.status === "loading" && items.length === 0 ? (
            <p className="overview__empty" role="status">Loading recorded activity…</p>
          ) : grouped.length === 0 && controller.activity.status === "ready" ? (
            <EmptyState art="activity"><p>{filtersActive ? "No recorded activity matches these filters." : "No activity has been recorded yet."}</p></EmptyState>
          ) : grouped.length > 0 ? (
            <ol className="activity-feed" role="list">
              {grouped.map((item) => (
                <li key={item.activityId} className="activity-feed__item">
                  <a href={item.resolvedRoute} className="activity-feed__open" onClick={(event) => void openItem(event, item)} aria-busy={openingId === item.activityId}>
                    <span className="activity-feed__verb"><strong>{item.actorLabel}</strong> {item.summary}</span>
                    <span className="activity-feed__case">{item.investigationTitle}</span>
                    <span className="activity-feed__meta"><time dateTime={item.occurredAt}>{timeLabel(item.occurredAt)}</time>
                      {repeatLabel(item) ? <span className="activity-feed__repeat">{repeatLabel(item)}</span> : null}
                      {item.secondaryContext ? <span className="activity-feed__stage">{item.secondaryContext.label}: {item.secondaryContext.value}</span> : null}
                      {privacy(item) ? <span className="activity-feed__restricted">{privacy(item)}</span> : null}
                    </span>
                    <span className="triage-chip">{provenance(item)}</span>
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
          {controller.nextCursor ? (
            <div className="activity-center__load-more">
              <button type="button" onClick={controller.loadMore} disabled={controller.loadingMore}>{controller.loadingMore ? "Loading…" : "Load more activity"}</button>
              <p role="status">{controller.loadingMore ? "Loading the next recorded page." : ""}</p>
            </div>
          ) : null}
        </section>

        <aside className="overview__attention" aria-labelledby="overview-follow-up-title">
          <header className="overview__section-head"><div><p className="overview__eyebrow">Across the loaded window</p><h3 id="overview-follow-up-title">Recorded follow-up</h3>
            <p>Explicitly recorded threads and handoffs. This is not a priority score or a completeness claim.</p></div></header>
          <section className="activity-center__threads" aria-labelledby="overview-open-title">
            <h4 id="overview-open-title">Open threads</h4>
            <p>Recent records that stopped, disagreed, or still await a person.</p>
          {!hasLoadedActivityWindow ? <p className="overview__empty" role="status">Open threads will appear after recorded activity is available.</p> : openThreads.length === 0 ? <p className="overview__empty">No open thread is recorded in this loaded activity window.</p> : (
            <><ul className="overview__thread-list" role="list">{openThreads.slice(0, 6).map((item) => <li key={item.activityId}><a href={item.resolvedRoute} onClick={(event) => void openItem(event, item)}><strong>{item.investigationTitle}</strong><span>{item.summary}</span></a></li>)}</ul>
            {openThreads.length > 6 ? <p className="overview__thread-more">Showing 6 of {openThreads.length} open threads in this loaded activity window.</p> : null}</>
          )}
          </section>
          <section className="activity-center__handoffs" aria-labelledby="recorded-handoffs-title">
            <h4 id="recorded-handoffs-title">Recorded handoffs</h4>
            <p>Shift notes explicitly saved by collaborators—never inferred from inactivity.</p>
            {!hasLoadedActivityWindow ? <p className="overview__empty" role="status">Handoffs will appear after recorded activity is available.</p> : handoffs.length === 0 ? <p className="overview__empty">No handoff is recorded in this loaded activity window.</p> : (
              <><ul className="overview__thread-list" role="list">{handoffs.slice(0, 5).map((item) => <li key={item.activityId}><a href={item.resolvedRoute} onClick={(event) => void openItem(event, item)}><strong>{item.investigationTitle}</strong><span>{item.summary}</span></a></li>)}</ul>
              {handoffs.length > 5 ? <p className="overview__thread-more">Showing 5 of {handoffs.length} handoffs in this loaded activity window.</p> : null}</>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
