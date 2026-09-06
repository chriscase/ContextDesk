import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
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
import {
  loadOperationsQueueSavedViews,
  operationsQueueSavedViewLimit,
  operationsQueueSavedViewNameLimit,
  operationsQueueSavedViewQuery,
  operationsQueueSavedViewsKey,
  writeOperationsQueueSavedViews,
  type OperationsQueueSavedView,
} from "./saved-views.js";

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
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViews, setSavedViews] = useState<OperationsQueueSavedView[]>([]);
  const [savedViewsNotice, setSavedViewsNotice] = useState("");
  const [savedViewRecovery, setSavedViewRecovery] = useState<{
    readonly kind: "save" | "apply" | "remove";
    readonly fromQueryKey: string;
    readonly toQueryKey: string;
    readonly scopeToken: object;
    readonly identityKey: string | null;
    readonly viewId: string | null;
  } | null>(null);
  const [continuationAttempt, setContinuationAttempt] = useState(0);
  const [unavailableRetry, setUnavailableRetry] = useState<{
    readonly error: unknown;
    readonly observedLoading: boolean;
    readonly queryKey: string;
    readonly scopeToken: object;
  } | null>(null);
  const [refreshRetry, setRefreshRetry] = useState<{
    readonly baselineRequestGeneration: number;
    readonly observedLoading: boolean;
    readonly queryKey: string;
    readonly scopeToken: object;
  } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const completionRef = useRef<HTMLParagraphElement>(null);
  const continuationFailureRef = useRef<HTMLDivElement>(null);
  const refreshFailureRef = useRef<HTMLDivElement>(null);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const unavailableRetryInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const refreshRetryInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const continuationInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const focusedOutcomeRef = useRef(0);
  const savedViewInitiatorRef = useRef<HTMLElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const savedViewNameRef = useRef<HTMLInputElement>(null);
  const applyButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const identityRef = useRef(queue.identity);
  identityRef.current = queue.identity;
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const identityStorageKey = useMemo(
    () => operationsQueueSavedViewsKey(queue.identity),
    [queue.identity],
  );

  useEffect(() => setSearchDraft(query.q), [query.q]);
  useEffect(() => {
    savedViewInitiatorRef.current = null;
    setSavedViewRecovery(null);
    setSavedViews(loadOperationsQueueSavedViews(identityRef.current));
    setSavedViewName("");
    setSavedViewsNotice(identityStorageKey === null
      ? "Saved views become available after you sign in."
      : "");
  }, [identityStorageKey]);
  useEffect(() => {
    setContinuationAttempt(0);
    focusedOutcomeRef.current = 0;
    continuationInitiatorRef.current = null;
    unavailableRetryInitiatorRef.current = null;
    refreshRetryInitiatorRef.current = null;
    setUnavailableRetry(null);
    setRefreshRetry(null);
  }, [queryKey, queue.scopeToken]);

  const available = queue.view.availability === "available";
  const refreshState = available ? queue.view.refresh : null;
  const hasNextPage = available && queue.view.value.nextCursor !== null;
  const continuationLoading = queue.continuationInFlight;
  const paginationDisabled = continuationLoading || refreshState === "loading";

  useEffect(() => {
    if (queue.continuationOutcome === 0 || focusedOutcomeRef.current === queue.continuationOutcome) return;
    const activeElement = document.activeElement;
    const shouldRecoverFocus = activeElement === document.body
      || activeElement === continuationInitiatorRef.current;
    focusedOutcomeRef.current = queue.continuationOutcome;
    if (!shouldRecoverFocus) return;
    if (queue.view.availability === "unavailable") {
      unavailableRef.current?.focus();
      return;
    }
    if (queue.continuationFailed) {
      continuationFailureRef.current?.focus();
      return;
    }
    if (available && refreshState === "settled") {
      if (hasNextPage) loadMoreRef.current?.focus();
      else completionRef.current?.focus();
    }
  }, [available, hasNextPage, queue.continuationFailed, queue.continuationOutcome, queue.view.availability, refreshState]);

  useEffect(() => {
    if (unavailableRetry === null) return;
    if (unavailableRetry.scopeToken !== queue.scopeToken || unavailableRetry.queryKey !== queryKey) {
      unavailableRetryInitiatorRef.current = null;
      setUnavailableRetry(null);
      return;
    }
    if (queue.view.availability === "idle") return;
    if (queue.view.availability === "loading") {
      if (!unavailableRetry.observedLoading) {
        setUnavailableRetry({ ...unavailableRetry, observedLoading: true });
      }
      return;
    }
    if (
      queue.view.availability === "unavailable"
      && queue.view.error === unavailableRetry.error
      && !unavailableRetry.observedLoading
    ) return;
    const activeElement = document.activeElement;
    const shouldRecoverFocus = activeElement === document.body
      || activeElement === unavailableRetryInitiatorRef.current;
    unavailableRetryInitiatorRef.current = null;
    setUnavailableRetry(null);
    if (!shouldRecoverFocus) return;
    if (queue.view.availability === "unavailable") unavailableRef.current?.focus();
    else titleRef.current?.focus();
  }, [queryKey, queue.scopeToken, queue.view, unavailableRetry]);

  useEffect(() => {
    if (refreshRetry === null) return;
    if (refreshRetry.scopeToken !== queue.scopeToken || refreshRetry.queryKey !== queryKey) {
      refreshRetryInitiatorRef.current = null;
      setRefreshRetry(null);
      return;
    }
    if (queue.view.availability === "idle") return;
    if (queue.view.availability === "loading"
      || (queue.view.availability === "available" && queue.view.refresh === "loading")) {
      if (!refreshRetry.observedLoading) {
        setRefreshRetry({ ...refreshRetry, observedLoading: true });
      }
      return;
    }
    if (
      !refreshRetry.observedLoading
      && queue.requestGeneration <= refreshRetry.baselineRequestGeneration
    ) return;
    const activeElement = document.activeElement;
    const shouldRecoverFocus = activeElement === document.body
      || activeElement === refreshRetryInitiatorRef.current;
    refreshRetryInitiatorRef.current = null;
    setRefreshRetry(null);
    if (!shouldRecoverFocus) return;
    if (queue.view.availability === "unavailable") unavailableRef.current?.focus();
    else if (queue.view.refresh === "failed") refreshFailureRef.current?.focus();
    else titleRef.current?.focus();
  }, [queryKey, queue.requestGeneration, queue.scopeToken, queue.view, refreshRetry]);

  useEffect(() => {
    if (savedViewRecovery === null) return;
    if (
      savedViewRecovery.scopeToken !== queue.scopeToken
      || savedViewRecovery.identityKey !== identityStorageKey
    ) {
      savedViewInitiatorRef.current = null;
      setSavedViewRecovery(null);
      return;
    }
    const matchesOriginal = savedViewRecovery.fromQueryKey === queryKey;
    const matchesApplied = savedViewRecovery.toQueryKey === queryKey;
    if (savedViewRecovery.kind === "apply" && matchesOriginal && !matchesApplied) return;
    if (!matchesOriginal && !matchesApplied) {
      savedViewInitiatorRef.current = null;
      setSavedViewRecovery(null);
      return;
    }
    const activeElement = document.activeElement;
    const shouldRecover = activeElement === document.body
      || activeElement === savedViewInitiatorRef.current;
    savedViewInitiatorRef.current = null;
    setSavedViewRecovery(null);
    if (!shouldRecover) return;
    if (savedViewRecovery.viewId) {
      applyButtonRefs.current.get(savedViewRecovery.viewId)?.focus();
      return;
    }
    savedViewNameRef.current?.focus();
  }, [identityStorageKey, queryKey, queue.scopeToken, savedViewRecovery]);

  const requestNextPage = (event: MouseEvent<HTMLButtonElement>) => {
    if (paginationDisabled) return;
    continuationInitiatorRef.current = event.currentTarget;
    setContinuationAttempt((current) => current + 1);
    queue.nextPage();
  };

  const retryUnavailable = (event: MouseEvent<HTMLButtonElement>) => {
    if (queue.view.availability !== "unavailable") return;
    unavailableRetryInitiatorRef.current = event.currentTarget;
    setUnavailableRetry({
      error: queue.view.error,
      observedLoading: false,
      queryKey,
      scopeToken: queue.scopeToken,
    });
    queue.refresh();
  };

  const retryRefresh = (event: MouseEvent<HTMLButtonElement>) => {
    if (queue.view.availability !== "available" || queue.view.refresh !== "failed") return;
    refreshRetryInitiatorRef.current = event.currentTarget;
    setRefreshRetry({
      baselineRequestGeneration: queue.requestGeneration,
      observedLoading: false,
      queryKey,
      scopeToken: queue.scopeToken,
    });
    queue.refresh();
  };

  const update = (next: Partial<OperationsQueueLocationQuery>) => {
    onQueryChange({ ...query, ...next });
  };

  const saveCurrentView = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = savedViewName.trim();
    if (!name || identityStorageKey === null) return;
    const persistable = operationsQueueSavedViewQuery(query);
    if (persistable === null) {
      setSavedViewsNotice("This browser could not save the view. Your current queue is unchanged.");
      return;
    }
    const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const next = [
      { id, name, query: persistable },
      ...savedViews.filter((view) => view.name.toLocaleLowerCase() !== name.toLocaleLowerCase()),
    ].slice(0, operationsQueueSavedViewLimit());
    savedViewInitiatorRef.current = saveButtonRef.current;
    if (!writeOperationsQueueSavedViews(queue.identity, next)) {
      savedViewInitiatorRef.current = null;
      setSavedViewsNotice("This browser could not save the view. Your current queue is unchanged.");
      return;
    }
    setSavedViews(next);
    setSavedViewName("");
    setSavedViewsNotice(`Saved “${name}” for this account on this browser.`);
    setSavedViewRecovery({
      kind: "save",
      fromQueryKey: queryKey,
      toQueryKey: queryKey,
      scopeToken: queue.scopeToken,
      identityKey: identityStorageKey,
      viewId: id,
    });
  };

  const applySavedView = (view: OperationsQueueSavedView, event: MouseEvent<HTMLButtonElement>) => {
    savedViewInitiatorRef.current = event.currentTarget;
    setSavedViewRecovery({
      kind: "apply",
      fromQueryKey: queryKey,
      toQueryKey: JSON.stringify(view.query),
      scopeToken: queue.scopeToken,
      identityKey: identityStorageKey,
      viewId: view.id,
    });
    onQueryChange(view.query);
    setSavedViewsNotice(`Applied “${view.name}”.`);
  };

  const deleteSavedView = (view: OperationsQueueSavedView, event: MouseEvent<HTMLButtonElement>) => {
    const next = savedViews.filter((current) => current.id !== view.id);
    savedViewInitiatorRef.current = event.currentTarget;
    if (!writeOperationsQueueSavedViews(queue.identity, next)) {
      savedViewInitiatorRef.current = null;
      setSavedViewsNotice("This browser could not remove the saved view.");
      return;
    }
    setSavedViews(next);
    setSavedViewsNotice(`Removed “${view.name}”.`);
    setSavedViewRecovery({
      kind: "remove",
      fromQueryKey: queryKey,
      toQueryKey: queryKey,
      scopeToken: queue.scopeToken,
      identityKey: identityStorageKey,
      viewId: null,
    });
  };

  const counts = available ? queue.view.value.coordinationScopeCounts : null;
  const items = available ? queue.view.value.items : [];
  const hasFilters = query.q.trim().length > 0 || query.status.length > 0;

  return (
    <section className="operations-queue" aria-labelledby="operations-queue-title">
      <header className="operations-queue__header">
        <div>
          <p className="operations-queue__eyebrow">Coordination</p>
          <h2 id="operations-queue-title" tabIndex={-1} ref={titleRef}>Operations Queue</h2>
          <p>Review the server-recorded coordination view. Open an investigation to make changes there.</p>
        </div>
        {available ? (
          <button
            type="button"
            className="operations-queue__refresh"
            onClick={queue.refresh}
            aria-disabled={queue.view.refresh === "loading"}
          >
            {queue.view.refresh === "loading"
              ? continuationLoading
                ? "Refresh after load"
                : "Refreshing…"
              : "Refresh"}
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

          <section className="operations-queue__saved" aria-labelledby="operations-queue-saved-title">
            <div className="operations-queue__saved-heading">
              <div>
                <h3 id="operations-queue-saved-title">Saved views</h3>
                <p>Private to this browser and account; never shared as server coordination.</p>
              </div>
            </div>
            <form className="operations-queue__saved-form" onSubmit={saveCurrentView}>
              <label>
                <span>View name</span>
                <input
                  ref={savedViewNameRef}
                  type="text"
                  value={savedViewName}
                  maxLength={operationsQueueSavedViewNameLimit()}
                  onChange={(event) => setSavedViewName(event.target.value)}
                  placeholder="e.g. My open handoffs"
                  disabled={identityStorageKey === null}
                />
              </label>
              <button
                ref={saveButtonRef}
                type="submit"
                disabled={identityStorageKey === null || !savedViewName.trim()}
              >
                Save current view
              </button>
            </form>
            {savedViews.length > 0 ? (
              <ul className="operations-queue__saved-list" aria-label="Saved Operations Queue views">
                {savedViews.map((view) => (
                  <li key={view.id}>
                    <button
                      type="button"
                      ref={(element) => {
                        if (element) applyButtonRefs.current.set(view.id, element);
                        else applyButtonRefs.current.delete(view.id);
                      }}
                      aria-label={`Apply saved view ${view.name}`}
                      onClick={(event) => applySavedView(view, event)}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      className="operations-queue__saved-remove"
                      aria-label={`Remove saved view ${view.name}`}
                      onClick={(event) => deleteSavedView(view, event)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="operations-queue__saved-empty">No saved views yet.</p>
            )}
            <p
              className={savedViewsNotice ? "operations-queue__saved-notice" : "sr-only"}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {savedViewsNotice}
            </p>
          </section>

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
            <div className="operations-queue__message" role="alert" tabIndex={-1} ref={unavailableRef}>
              <h3>Operations Queue access ended</h3>
              <p>Your session or investigation access changed. Sign in again to continue.</p>
            </div>
          ) : null}
          {queue.view.availability === "unavailable" && queue.view.error.kind !== "auth_lost" ? (
            <div className="operations-queue__message" role="alert" tabIndex={-1} ref={unavailableRef}>
              <h3>{queue.view.error.kind === "unavailable"
                ? "Operations Queue service is unavailable"
                : "Operations Queue could not be loaded"}</h3>
              <p>No legacy investigation list was substituted for this queue response.</p>
              <button type="button" onClick={retryUnavailable}>Try again</button>
            </div>
          ) : null}

          {available && queue.view.refresh === "failed" && !queue.continuationFailed ? (
            <div
              className="operations-queue__message operations-queue__message--inline"
              role="alert"
              tabIndex={-1}
              ref={refreshFailureRef}
            >
              <p>The latest refresh failed. The previously loaded queue is still shown in server order.</p>
              <button type="button" onClick={retryRefresh}>Try again</button>
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
          {available && hasNextPage && !queue.continuationFailed ? (
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
