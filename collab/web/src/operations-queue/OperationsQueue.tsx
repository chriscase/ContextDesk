import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DEFAULT_OPERATIONS_QUEUE_QUERY,
  pathFor,
  type OperationsQueueLocationQuery,
} from "../app-location.js";
import type {
  InvestigationOperationsQueueCoordinationScopeV1,
  InvestigationOperationsQueueRowV1,
} from "../investigations/runtime/public.js";
import { useOperationsQueue } from "./useOperationsQueue.js";

export interface OperationsQueueProps {
  readonly query: OperationsQueueLocationQuery;
  readonly onQueryChange: (query: OperationsQueueLocationQuery) => void;
  readonly onOpenInvestigation: (investigationId: string) => void;
}

const STATUS_OPTIONS = ["open", "monitoring", "resolved", "archived"] as const;
const SCOPE_OPTIONS: readonly {
  scope: InvestigationOperationsQueueCoordinationScopeV1;
  label: string;
  count: "allVisible" | "mine" | "unassigned";
}[] = [
  { scope: "all_visible", label: "All visible", count: "allVisible" },
  { scope: "mine", label: "Mine", count: "mine" },
  { scope: "unassigned", label: "Unassigned", count: "unassigned" },
];

function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;
}

function scopeHref(
  query: OperationsQueueLocationQuery,
  coordinationScope: InvestigationOperationsQueueCoordinationScopeV1,
): string {
  return pathFor({
    area: "operations",
    caseId: null,
    stage: "situation",
    operationsQueueQuery: { ...query, coordinationScope },
  });
}

function investigationHref(id: string): string {
  return `/investigations/${encodeURIComponent(id)}/situation`;
}

function QueueRow({
  row,
  onOpen,
}: {
  readonly row: InvestigationOperationsQueueRowV1;
  readonly onOpen: (id: string) => void;
}) {
  const coordinator = row.coordination.coordinator?.username ?? null;
  const title = row.investigation.title.trim() || "Untitled investigation";
  return (
    <li className="operations-queue__row">
      <a
        className="operations-queue__row-link"
        href={investigationHref(row.investigation.id)}
        onClick={(event) => {
          if (!isPlainPrimaryClick(event)) return;
          event.preventDefault();
          onOpen(row.investigation.id);
        }}
      >
        <span className="operations-queue__row-title">{title}</span>
        <span className="operations-queue__row-facts">
          <span className={`operations-queue__status operations-queue__status--${row.investigation.status}`}>
            {row.investigation.status}
          </span>
          <span>Coordinator: {coordinator ?? "Not recorded"}</span>
        </span>
      </a>
    </li>
  );
}

export function OperationsQueue({ query, onQueryChange, onOpenInvestigation }: OperationsQueueProps) {
  const queue = useOperationsQueue(query);
  const [searchDraft, setSearchDraft] = useState(query.q);
  const [continuationAttempt, setContinuationAttempt] = useState(0);
  const completionRef = useRef<HTMLParagraphElement>(null);
  const continuationFailureRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const continuationInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const observedInFlightAttemptRef = useRef(0);
  const focusedOutcomeAttemptRef = useRef(0);
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  useEffect(() => setSearchDraft(query.q), [query.q]);
  useEffect(() => {
    setContinuationAttempt(0);
    observedInFlightAttemptRef.current = 0;
    focusedOutcomeAttemptRef.current = 0;
    continuationInitiatorRef.current = null;
  }, [queryKey]);

  const available = queue.view.availability === "available";
  const refreshState = available ? queue.view.refresh : null;
  const hasNextPage = available && queue.view.value.nextCursor !== null;
  const continuationLoading = queue.continuationInFlight;
  const paginationDisabled = continuationLoading || refreshState === "loading";

  useEffect(() => {
    if (continuationAttempt === 0) return;
    if (continuationLoading) {
      observedInFlightAttemptRef.current = continuationAttempt;
      return;
    }
    if (
      observedInFlightAttemptRef.current !== continuationAttempt
      || focusedOutcomeAttemptRef.current === continuationAttempt
    ) return;
    const activeElement = document.activeElement;
    const shouldRecoverFocus = activeElement === document.body
      || activeElement === continuationInitiatorRef.current;
    focusedOutcomeAttemptRef.current = continuationAttempt;
    if (!shouldRecoverFocus) return;
    if (queue.continuationFailed) {
      continuationFailureRef.current?.focus();
      return;
    }
    if (available && refreshState === "settled") {
      if (hasNextPage) loadMoreRef.current?.focus();
      else completionRef.current?.focus();
    }
  }, [available, continuationAttempt, continuationLoading, hasNextPage, queue.continuationFailed, refreshState]);

  const requestNextPage = (event: MouseEvent<HTMLButtonElement>) => {
    if (paginationDisabled) return;
    continuationInitiatorRef.current = event.currentTarget;
    setContinuationAttempt((current) => current + 1);
    queue.nextPage();
  };

  const update = (next: Partial<OperationsQueueLocationQuery>) => {
    onQueryChange({ ...query, ...next });
  };

  const counts = available ? queue.view.value.coordinationScopeCounts : null;
  const items = available ? queue.view.value.items : [];
  const hasFilters = query.q.trim().length > 0 || query.status.length > 0;

  return (
    <section className="operations-queue" aria-labelledby="operations-queue-title">
      <header className="operations-queue__header">
        <div>
          <p className="operations-queue__eyebrow">Coordination</p>
          <h2 id="operations-queue-title">Operations Queue</h2>
          <p>Review the server-recorded coordination view. Open an investigation to make changes there.</p>
        </div>
        {available ? (
          <button
            type="button"
            className="operations-queue__refresh"
            onClick={queue.refresh}
            aria-disabled={queue.view.refresh === "loading"}
          >
            {queue.view.refresh === "loading" && !continuationLoading ? "Refreshing…" : "Refresh"}
          </button>
        ) : null}
      </header>

      {queue.commandAvailability === "absent" ? (
        <div className="operations-queue__message" role="status">
          <h3>Operations Queue is not available in this build</h3>
          <p>The public investigation runtime does not provide the queue command.</p>
        </div>
      ) : null}
      {queue.commandAvailability === "denied" ? (
        <div className="operations-queue__message" role="status">
          <h3>Operations Queue unavailable for this account</h3>
          <p>Your current account cannot read investigations, so no queue data was requested.</p>
        </div>
      ) : null}

      {queue.commandAvailability === "available" ? (
        <>
          <form
            className="operations-queue__filters"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              update({ q: searchDraft });
            }}
          >
            <label className="operations-queue__search">
              <span>Search</span>
              <input
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Title, context, or investigation ID"
              />
            </label>
            <button type="submit">Search queue</button>
            <fieldset>
              <legend>Status</legend>
              {STATUS_OPTIONS.map((status) => (
                <label key={status}>
                  <input
                    type="checkbox"
                    checked={query.status.includes(status)}
                    onChange={(event) => update({
                      status: event.target.checked
                        ? [...query.status, status]
                        : query.status.filter((current) => current !== status),
                    })}
                  />
                  <span>{status}</span>
                </label>
              ))}
            </fieldset>
            <label className="operations-queue__include-archived">
              <input
                type="checkbox"
                checked={query.includeArchived}
                onChange={(event) => update({ includeArchived: event.target.checked })}
              />
              <span>Include archived</span>
            </label>
          </form>

          <nav className="operations-queue__scopes" aria-label="Coordination scope">
            {SCOPE_OPTIONS.map((option) => (
              <a
                key={option.scope}
                href={scopeHref(query, option.scope)}
                aria-current={query.coordinationScope === option.scope ? "page" : undefined}
                onClick={(event) => {
                  if (!isPlainPrimaryClick(event)) return;
                  event.preventDefault();
                  update({ coordinationScope: option.scope });
                }}
              >
                <span>{option.label}</span>
                {counts ? <strong>{counts[option.count]}</strong> : null}
              </a>
            ))}
          </nav>

          {queue.view.availability === "idle" ? (
            <p className="operations-queue__message" role="status">Queue request has not started.</p>
          ) : null}
          {queue.view.availability === "loading" ? (
            <p className="operations-queue__message" role="status" aria-busy="true">
              Loading operations queue…
            </p>
          ) : null}
          {queue.view.availability === "unavailable" && queue.view.error.kind === "auth_lost" ? (
            <div className="operations-queue__message" role="alert">
              <h3>Operations Queue access ended</h3>
              <p>Your session or investigation access changed. Sign in again to continue.</p>
            </div>
          ) : null}
          {queue.view.availability === "unavailable" && queue.view.error.kind !== "auth_lost" ? (
            <div className="operations-queue__message" role="alert">
              <h3>{queue.view.error.kind === "unavailable"
                ? "Operations Queue service is unavailable"
                : "Operations Queue could not be loaded"}</h3>
              <p>No legacy investigation list was substituted for this queue response.</p>
              <button type="button" onClick={queue.refresh}>Try again</button>
            </div>
          ) : null}

          {available && queue.view.refresh === "failed" && !queue.continuationFailed ? (
            <div className="operations-queue__message operations-queue__message--inline" role="alert">
              <p>The latest refresh failed. The previously loaded queue is still shown in server order.</p>
              <button type="button" onClick={queue.refresh}>Try again</button>
            </div>
          ) : null}
          {available && queue.view.value.hiddenArchivedCount > 0 && !query.includeArchived ? (
            <p className="operations-queue__archive-note" role="status">
              {queue.view.value.hiddenArchivedCount} archived investigation{
                queue.view.value.hiddenArchivedCount === 1 ? " is" : "s are"
              } hidden. Include archived to show them.
            </p>
          ) : null}
          {available && items.length === 0 ? (
            <p className="operations-queue__message" role="status">
              {hasFilters
                ? "No operations match the current search or status filter."
                : query.coordinationScope === "mine"
                  ? "No visible investigations are coordinated by you."
                  : query.coordinationScope === "unassigned"
                    ? "No visible investigations are unassigned."
                    : queue.view.value.hiddenArchivedCount > 0 && !query.includeArchived
                      ? "No non-archived investigations are visible in Operations."
                    : "No investigations are visible in Operations."}
            </p>
          ) : null}
          {items.length > 0 ? (
            <ul className="operations-queue__rows" aria-label="Operations queue investigations">
              {items.map((row) => (
                <QueueRow
                  key={row.investigation.id}
                  row={row}
                  onOpen={onOpenInvestigation}
                />
              ))}
            </ul>
          ) : null}

          {available && queue.continuationFailed ? (
            <div
              className="operations-queue__message operations-queue__message--inline"
              role="alert"
              tabIndex={-1}
              ref={continuationFailureRef}
            >
              <p>More operations could not be loaded. Previously loaded rows remain in server order.</p>
              <button type="button" onClick={requestNextPage}>Try loading more</button>
            </div>
          ) : null}
          {available && hasNextPage ? (
            <nav className="operations-queue__pagination" aria-label="Operations Queue pages">
              <button
                type="button"
                aria-disabled={paginationDisabled}
                ref={loadMoreRef}
                onClick={requestNextPage}
              >
                {continuationLoading ? "Loading more operations…" : "Load more operations"}
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {continuationLoading
                  ? "Loading more operations. Previously loaded rows remain available."
                  : ""}
              </span>
            </nav>
          ) : null}
          {available && continuationAttempt > 0 && !hasNextPage && queue.view.refresh === "settled" ? (
            <p className="operations-queue__completion" role="status" tabIndex={-1} ref={completionRef}>
              All operations are shown.
            </p>
          ) : null}
          {available
          && queue.view.refresh === "settled"
          && !(continuationAttempt > 0 && !hasNextPage) ? (
            <span className="sr-only" role="status" aria-live="polite">
              {items.length} {items.length === 1 ? "operation" : "operations"} shown.
            </span>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export { DEFAULT_OPERATIONS_QUEUE_QUERY };
