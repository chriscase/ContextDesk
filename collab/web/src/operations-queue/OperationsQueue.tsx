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
import type {
  OperationsQueueParticipantCoordinationPresentation,
  OperationsQueueSelfCoordinationPresentation,
} from "./useOperationsQueue.js";
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

function selfCoordinationErrorCopy(error: { readonly kind: string; readonly reason?: string }): string {
  if (error.kind === "auth_lost" || error.kind === "not_found") {
    return "Your investigation access changed. No ownership change was assumed.";
  }
  if (error.kind === "coordination_changed" || error.kind === "coordination_refused") {
    return "The server recorded a coordination change. Refresh the queue before trying again.";
  }
  if (error.kind === "unavailable" && error.reason === "commit_outcome_unknown") {
    return "The server may have recorded this action. Retry the same action to confirm.";
  }
  return "The coordination action could not be completed. No ownership change was assumed.";
}

function participantCoordinationErrorCopy(error: { readonly kind: string; readonly reason?: string }): string {
  if (error.kind === "auth_lost") {
    return "Your investigation access changed. No ownership change was assumed.";
  }
  if (error.kind === "coordination_changed" || error.kind === "coordination_refused") {
    return "The server recorded a coordination change. Refresh the queue before trying again.";
  }
  if (error.kind === "unavailable" && error.reason === "commit_outcome_unknown") {
    return "The server may have recorded this action. Retry the same action to confirm.";
  }
  return "The coordination action could not be completed. No ownership change was assumed.";
}

function recordedIdentityLabel(person: { readonly username: string; readonly identityId: string }): string {
  const name = person.username.trim();
  return name.length > 0 ? `${name} (${person.identityId})` : person.identityId;
}

function QueueRow({
  row,
  onOpen,
  identityId,
  selfCoordination,
  participantCoordination,
  onSelfActionInitiated,
  onParticipantActionInitiated,
  onParticipantConcealmentTarget,
}: {
  readonly row: InvestigationOperationsQueueRowV1;
  readonly onOpen: (id: string) => void;
  readonly identityId: string;
  readonly selfCoordination: OperationsQueueSelfCoordinationPresentation;
  readonly participantCoordination: OperationsQueueParticipantCoordinationPresentation;
  readonly onSelfActionInitiated: (button: HTMLButtonElement) => void;
  readonly onParticipantActionInitiated: (button: HTMLButtonElement) => void;
  readonly onParticipantConcealmentTarget: (investigationId: string, element: HTMLSpanElement | null) => void;
}) {
  const coordinator = row.coordination.coordinator;
  const coordinatorName = coordinator?.username ?? null;
  const isMine = coordinator?.identityId === identityId && identityId.length > 0;
  const canClaim = coordinator === null && selfCoordination.available;
  const canRelease = isMine && selfCoordination.available;
  const action = canClaim ? "claim_self" : canRelease ? "release_self" : null;
  const isSelfTarget = selfCoordination.targetInvestigationId === row.investigation.id;
  const selfMutation = isSelfTarget ? selfCoordination.state : { status: "idle" as const };
  const selfBusy = selfMutation.status === "running";
  const actionLabel = action === "claim_self" ? "Claim for me" : "Release me";
  const title = row.investigation.title.trim() || "Untitled investigation";
  const participants = row.investigation.participants;
  const [selectedParticipantId, setSelectedParticipantId] = useState(participants[0]?.identityId ?? "");
  useEffect(() => {
    if (participants.some((participant) => participant.identityId === selectedParticipantId)) return;
    setSelectedParticipantId(participants[0]?.identityId ?? "");
  }, [participants, selectedParticipantId]);
  const selectedParticipant = participants.find((participant) => participant.identityId === selectedParticipantId)
    ?? null;
  const isParticipantTarget = participantCoordination.targetInvestigationId === row.investigation.id;
  const participantMutation = isParticipantTarget
    ? participantCoordination.state
    : { status: "idle" as const };
  const participantMutationBusy = participantCoordination.state.status === "running";
  const unknownOutcomeLocked = participantCoordination.state.status === "failed"
    && participantCoordination.state.error.kind === "unavailable"
    && participantCoordination.state.error.reason === "commit_outcome_unknown";
  const participantControlsLocked = participantMutationBusy || unknownOutcomeLocked;
  const participantConcealed = participantCoordination.concealedInvestigationIds.includes(row.investigation.id)
    || (isParticipantTarget
      && participantMutation.status === "failed"
      && participantMutation.error.kind === "not_found");
  const showParticipantControl = participantCoordination.available && !participantConcealed;
  const participantRetryAction = participantCoordination.action === "release_participant"
    ? "release coordinator"
    : "assign participant";
  const participantRetryTarget = participantCoordination.targetIdentityId;
  const participantRetryLabel = participantRetryTarget === null
    ? participantRetryAction
    : `${participantRetryAction} ${participantRetryTarget}`;
  return (
    <li className="operations-queue__row">
      <div className="operations-queue__row-shell">
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
            <span>Coordinator: {coordinatorName ?? "Not recorded"}</span>
          </span>
        </a>
        <div className="operations-queue__row-actions">
          {action !== null ? (
            <button
              type="button"
              className="operations-queue__coordination-action"
              disabled={selfBusy}
              aria-busy={selfBusy}
              aria-label={`${actionLabel} ${title}`}
              onClick={(event) => {
                onSelfActionInitiated(event.currentTarget);
                void selfCoordination.apply(row.investigation.id, action);
              }}
            >
              {selfBusy ? "Saving…" : actionLabel}
            </button>
          ) : null}
          {isSelfTarget && selfMutation.status === "failed" ? (
            <div className="operations-queue__coordination-feedback" role="alert">
              <span>{selfCoordinationErrorCopy(selfMutation.error)}</span>
              {selfMutation.error.kind === "unavailable" && selfMutation.error.reason === "commit_outcome_unknown" ? (
                <button
                  type="button"
                  onClick={() => { void selfCoordination.retry(); }}
                >
                  Retry {actionLabel.toLocaleLowerCase()}
                </button>
              ) : null}
            </div>
          ) : null}
          {isSelfTarget && selfMutation.status === "succeeded" ? (
            <span className="operations-queue__coordination-feedback" role="status" aria-live="polite">
              Coordination updated; refreshing recorded queue data.
            </span>
          ) : null}
          {showParticipantControl ? (
            <div
              className="operations-queue__participant-control"
              role="group"
              aria-busy={participantMutationBusy}
              aria-label={`Participant coordination for ${title}`}
            >
              <label className="operations-queue__participant-select">
                <span>Participant</span>
                <select
                  value={selectedParticipantId}
                  disabled={participantControlsLocked || participants.length === 0}
                  aria-busy={participantMutationBusy}
                  aria-label={`Recorded participants for ${title}`}
                  onChange={(event) => setSelectedParticipantId(event.target.value)}
                >
                  {participants.length === 0
                    ? <option value="">No recorded participants</option>
                    : participants.map((participant) => (
                      <option key={participant.identityId} value={participant.identityId}>
                        {recordedIdentityLabel(participant)}
                      </option>
                    ))}
                </select>
              </label>
              <div className="operations-queue__participant-actions">
                <button
                  type="button"
                  className="operations-queue__coordination-action"
                  disabled={participantControlsLocked || selectedParticipant === null}
                  aria-busy={participantMutationBusy && (
                    !isParticipantTarget || participantCoordination.action === "assign_participant"
                  )}
                  aria-label={selectedParticipant === null
                    ? `Assign participant to ${title}`
                    : `Assign participant ${recordedIdentityLabel(selectedParticipant)} to ${title}`}
                  onClick={(event) => {
                    if (selectedParticipant === null || participantControlsLocked) return;
                    onParticipantActionInitiated(event.currentTarget);
                    void participantCoordination.apply(
                      row.investigation.id,
                      "assign_participant",
                      selectedParticipant.identityId,
                    );
                  }}
                >
                  {participantMutationBusy && isParticipantTarget
                    && participantCoordination.action === "assign_participant"
                    ? "Saving…"
                    : "Assign participant"}
                </button>
                {coordinator !== null ? (
                  <button
                    type="button"
                    className="operations-queue__coordination-action"
                    disabled={participantControlsLocked}
                    aria-busy={participantMutationBusy && (
                      !isParticipantTarget || participantCoordination.action === "release_participant"
                    )}
                    aria-label={`Release coordinator ${recordedIdentityLabel(coordinator)} from ${title}`}
                    onClick={(event) => {
                      if (participantControlsLocked) return;
                      onParticipantActionInitiated(event.currentTarget);
                      void participantCoordination.apply(
                        row.investigation.id,
                        "release_participant",
                        coordinator.identityId,
                      );
                    }}
                  >
                    {participantMutationBusy && isParticipantTarget
                      && participantCoordination.action === "release_participant"
                      ? "Saving…"
                      : "Release coordinator"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {participantConcealed ? (
            <span
              ref={(element) => onParticipantConcealmentTarget(row.investigation.id, element)}
              tabIndex={-1}
              className="operations-queue__coordination-feedback"
              role="status"
              aria-live="polite"
            >
              This investigation is no longer available for this coordination action. Previously loaded queue rows remain.
            </span>
          ) : null}
          {isParticipantTarget && participantMutation.status === "failed" && !participantConcealed ? (
            <div className="operations-queue__coordination-feedback" role="alert">
              <span>{participantCoordinationErrorCopy(participantMutation.error)}</span>
              {participantMutation.error.kind === "unavailable"
                && participantMutation.error.reason === "commit_outcome_unknown" ? (
                <button
                  type="button"
                  aria-label={`Retry ${participantRetryLabel} for ${title}`}
                  onClick={(event) => {
                    onParticipantActionInitiated(event.currentTarget);
                    void participantCoordination.retry();
                  }}
                >
                  Retry {participantRetryAction}
                </button>
              ) : null}
            </div>
          ) : null}
          {isParticipantTarget && participantMutation.status === "succeeded" ? (
            <span className="operations-queue__coordination-feedback" role="status" aria-live="polite">
              Coordination updated; refreshing recorded queue data.
            </span>
          ) : null}
        </div>
      </div>
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
  const selfActionInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const selfOutcomeRef = useRef("");
  const participantActionInitiatorRef = useRef<HTMLButtonElement | null>(null);
  const participantConcealmentRefs = useRef(new Map<string, HTMLSpanElement>());
  const participantOutcomeRef = useRef("");
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
    selfActionInitiatorRef.current = null;
    selfOutcomeRef.current = "";
    participantActionInitiatorRef.current = null;
    participantOutcomeRef.current = "";
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
    const mutation = queue.selfCoordination.state;
    const outcomeKey = `${queue.requestGeneration}:${mutation.status}`;
    if (mutation.status === "idle" || selfOutcomeRef.current === outcomeKey) return;
    selfOutcomeRef.current = outcomeKey;
    const activeElement = document.activeElement;
    if (activeElement !== document.body && activeElement !== selfActionInitiatorRef.current) return;
    selfActionInitiatorRef.current?.focus();
  }, [queue.requestGeneration, queue.selfCoordination.state]);

  useEffect(() => {
    const mutation = queue.participantCoordination.state;
    const outcomeKey = `${queue.requestGeneration}:${mutation.status}`;
    if (mutation.status === "idle" || participantOutcomeRef.current === outcomeKey) return;
    participantOutcomeRef.current = outcomeKey;
    const initiator = participantActionInitiatorRef.current;
    const activeElement = document.activeElement;
    if (initiator === null) return;
    if (activeElement !== document.body && activeElement !== initiator) return;
    if (mutation.status === "failed" && mutation.error.kind === "not_found") {
      const targetId = queue.participantCoordination.targetInvestigationId;
      const recovery = targetId === null ? undefined : participantConcealmentRefs.current.get(targetId);
      if (recovery?.isConnected) {
        recovery.focus();
        return;
      }
    }
    if (initiator.isConnected) initiator.focus();
  }, [
    queue.participantCoordination.state,
    queue.participantCoordination.targetInvestigationId,
    queue.requestGeneration,
  ]);

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
                  identityId={queue.identity.id}
                  selfCoordination={queue.selfCoordination}
                  participantCoordination={queue.participantCoordination}
                  onSelfActionInitiated={(button) => { selfActionInitiatorRef.current = button; }}
                  onParticipantActionInitiated={(button) => { participantActionInitiatorRef.current = button; }}
                  onParticipantConcealmentTarget={(investigationId, element) => {
                    if (element === null) participantConcealmentRefs.current.delete(investigationId);
                    else participantConcealmentRefs.current.set(investigationId, element);
                  }}
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
