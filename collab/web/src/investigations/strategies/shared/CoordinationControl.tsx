import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  createCoordinationIdempotencyKey,
  selectCoordinationResourceView,
  type CoordinationAction,
  type CoordinationActionCommand,
  type CoordinationActionInput,
  type CoordinationActionResult,
  type CoordinationFailureKind,
  type CoordinationMutationState,
  type CoordinationParticipantHint,
  type CoordinationResourceState,
} from "./coordination.js";

export interface CoordinationControlProps {
  readonly investigationId: string;
  readonly investigationStatus: string;
  readonly participants: readonly CoordinationParticipantHint[];
  readonly resource: CoordinationResourceState;
  readonly mutation: CoordinationMutationState;
  readonly identity: { readonly id: string; readonly username: string };
  readonly canCoordinateSelf: boolean;
  readonly canCoordinateParticipants: boolean;
  readonly applyAction: CoordinationActionCommand | null;
  readonly refreshCoordination: () => void;
}

interface PendingIntent {
  readonly action: CoordinationAction;
  readonly targetIdentityId: string | null;
}

interface RetryIntent extends PendingIntent {
  readonly idempotencyKey: string;
}

type Feedback =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: CoordinationFailureKind }
  | { readonly status: "ignored"; readonly reason: "busy" | "stale" | "not_ready" };

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function intentLabel(intent: PendingIntent, participants: readonly CoordinationParticipantHint[]): string {
  switch (intent.action) {
    case "claim_self":
      return "Claim coordination for yourself?";
    case "release_self":
      return "Release your recorded coordination?";
    case "assign_participant": {
      const participant = participants.find(({ identityId }) => identityId === intent.targetIdentityId);
      const label = participant === undefined
        ? intent.targetIdentityId
        : `${participant.username} (${participant.identityId})`;
      return `Record ${label} as coordinator?`;
    }
    case "release_participant":
      return `Release the recorded coordinator ${intent.targetIdentityId}?`;
  }
}

function confirmationButtonLabel(action: CoordinationAction): string {
  switch (action) {
    case "claim_self": return "Confirm claim coordination";
    case "release_self": return "Confirm release my coordination";
    case "assign_participant": return "Confirm participant assignment";
    case "release_participant": return "Confirm release recorded coordinator";
  }
}

function failureCopy(error: CoordinationFailureKind): string {
  switch (error) {
    case "outcome_unknown":
      return "The result could not be confirmed. The coordination change may have been recorded. Refresh the recorded facts, or retry this exact action with the same request key.";
    case "changed":
      return "The coordination record changed before this action was accepted. Review the current recorded facts before trying again.";
    case "refused":
      return "The coordination action was refused. Review the current recorded facts before trying again.";
    case "validation":
      return "The coordination action was not accepted. Review the selected action before trying again.";
    case "auth_lost":
      return "Your access changed before the coordination action finished. Sign in again to continue.";
    case "not_found":
      return "This investigation is no longer available for coordination changes.";
    case "definitive":
      return "The coordination action could not be completed. Review the current recorded facts before trying again.";
  }
}

function ignoredCopy(reason: Feedback & { readonly status: "ignored" }): string {
  switch (reason.reason) {
    case "busy": return "Another coordination action is already in progress.";
    case "stale": return "This view changed before the action result could be accepted. Review the current recorded facts.";
    case "not_ready": return "Coordination changes are not available until the current record is confirmed.";
  }
}

function readFailureCopy(error: "denied" | "not_found" | "unavailable"): string {
  switch (error) {
    case "denied": return "Recorded coordination is unavailable because your access changed.";
    case "not_found": return "Recorded coordination is unavailable because this investigation is no longer in the current scope.";
    case "unavailable": return "Recorded coordination could not be loaded right now.";
  }
}

function toCommand(intent: RetryIntent): CoordinationActionInput {
  switch (intent.action) {
    case "claim_self":
    case "release_self":
      return { action: intent.action, idempotencyKey: intent.idempotencyKey };
    case "assign_participant":
    case "release_participant":
      return {
        action: intent.action,
        targetIdentityId: intent.targetIdentityId ?? "",
        idempotencyKey: intent.idempotencyKey,
      };
  }
}

export function CoordinationControl(props: CoordinationControlProps) {
  const titleId = useId();
  const confirmationId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmationButtonRef = useRef<HTMLButtonElement>(null);
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const operationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const operationHadFocusRef = useRef(false);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const [selectedParticipant, setSelectedParticipant] = useState(
    props.participants[0]?.identityId ?? "",
  );
  const [confirmation, setConfirmation] = useState<PendingIntent | null>(null);
  const [retryIntent, setRetryIntent] = useState<RetryIntent | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const view = selectCoordinationResourceView(props.resource);
  const available = view.availability === "available" ? view : null;
  const recorded = available?.value ?? null;
  const coordinator = recorded?.coordinator ?? null;
  const resourceReady = props.resource.status === "ready";
  const archived = props.investigationStatus === "archived" || recorded?.archived === true;
  const runtimeBusy = props.mutation.status === "running";
  const busy = submitting || runtimeBusy;
  const participantIds = useMemo(
    () => new Set(props.participants.map(({ identityId }) => identityId)),
    [props.participants],
  );
  const scopeFingerprint = [
    props.investigationId,
    props.investigationStatus,
    props.identity.id,
    props.identity.username,
    props.canCoordinateSelf ? "self" : "",
    props.canCoordinateParticipants ? "participants" : "",
  ].join("\u0000");

  useEffect(() => {
    generationRef.current += 1;
    busyRef.current = false;
    setSubmitting(false);
    setConfirmation(null);
    setRetryIntent(null);
    setFeedback(null);
  }, [scopeFingerprint]);

  useEffect(() => {
    if (participantIds.has(selectedParticipant)) return;
    setSelectedParticipant(props.participants[0]?.identityId ?? "");
    setConfirmation(null);
  }, [participantIds, props.participants, selectedParticipant]);

  useEffect(() => {
    if (confirmation !== null) confirmationButtonRef.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (busy || !operationHadFocusRef.current) return;
    const operationTrigger = operationTriggerRef.current;
    operationHadFocusRef.current = false;
    if (
      operationTrigger !== null
      && !operationTrigger.isConnected
      && document.activeElement === document.body
    ) {
      headingRef.current?.focus();
    }
  }, [busy]);

  function permitted(intent: PendingIntent, retry = false): boolean {
    if (!resourceReady || archived || props.applyAction === null || props.identity.id.trim() === "") {
      return false;
    }
    switch (intent.action) {
      case "claim_self":
        return props.canCoordinateSelf && (retry || coordinator === null);
      case "release_self":
        return props.canCoordinateSelf
          && (retry || coordinator?.identityId === props.identity.id);
      case "assign_participant":
        return props.canCoordinateParticipants
          && intent.targetIdentityId !== null
          && (retry || participantIds.has(intent.targetIdentityId));
      case "release_participant":
        return props.canCoordinateParticipants
          && intent.targetIdentityId !== null
          && (retry || coordinator?.identityId === intent.targetIdentityId);
    }
  }

  function matchesRetainedIntent(intent: PendingIntent): boolean {
    return retryIntent?.action === intent.action
      && retryIntent.targetIdentityId === intent.targetIdentityId;
  }

  function requestConfirmation(intent: PendingIntent, event: MouseEvent<HTMLButtonElement>) {
    if (busy || matchesRetainedIntent(intent) || !permitted(intent)) return;
    selectedTriggerRef.current = event.currentTarget;
    setFeedback(null);
    setRetryIntent(null);
    setConfirmation(intent);
  }

  function cancelConfirmation() {
    const trigger = selectedTriggerRef.current;
    setConfirmation(null);
    if (trigger?.isConnected) trigger.focus();
  }

  async function execute(intent: RetryIntent, trigger: HTMLButtonElement, retry = false) {
    if (busyRef.current || runtimeBusy || !permitted(intent, retry)) {
      if (!busyRef.current && !runtimeBusy) {
        setFeedback({ status: "ignored", reason: "not_ready" });
      }
      return;
    }
    const command = props.applyAction;
    if (command === null) return;
    const generation = generationRef.current;
    operationTriggerRef.current = trigger;
    operationHadFocusRef.current = document.activeElement === trigger;
    busyRef.current = true;
    setSubmitting(true);
    setConfirmation(null);
    setFeedback(null);
    if (!retry) setRetryIntent(null);

    let result: CoordinationActionResult;
    try {
      result = await command(toCommand(intent));
    } catch {
      result = { status: "failed", error: "definitive" };
    }
    if (generation !== generationRef.current) return;
    busyRef.current = false;
    setSubmitting(false);
    if (result.status === "succeeded") {
      setRetryIntent(null);
      setFeedback({ status: "succeeded" });
    } else if (result.status === "failed") {
      if (result.error === "outcome_unknown") {
        setRetryIntent(Object.freeze({ ...intent }));
      } else {
        setRetryIntent(null);
      }
      setFeedback(result);
    } else {
      setRetryIntent(null);
      setFeedback(result);
    }

  }

  const reportedFailure = feedback?.status === "failed" ? feedback.error : null;

  return (
    <section
      className="strategy-kit__coordination"
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="strategy-kit__coordination-heading">
        <div>
          <h3 id={titleId} ref={headingRef} tabIndex={-1}>Coordination</h3>
          <p>Who is recorded as coordinating this investigation.</p>
        </div>
        {view.availability === "available" ? (
          <span>Revision {view.value.revision.toLocaleString()}</span>
        ) : null}
      </div>

      {view.availability === "idle" ? (
        <p role="status">Coordination has not started loading.</p>
      ) : null}
      {view.availability === "loading" ? (
        <p role="status">Loading recorded coordination…</p>
      ) : null}
      {view.availability === "unavailable" ? (
        <div className="strategy-kit__coordination-notice" role="status">
          <p>{readFailureCopy(view.error)}</p>
          {view.error === "unavailable" ? (
            <button type="button" onClick={props.refreshCoordination}>Retry coordination</button>
          ) : null}
        </div>
      ) : null}

      {recorded !== null ? (
        <>
          <div className="strategy-kit__coordination-facts">
            {coordinator === null ? (
              <p className="strategy-kit__coordination-empty">No coordinator is recorded.</p>
            ) : (
              <div className="strategy-kit__coordination-person">
                <strong>{coordinator.username}</strong>
                <code>{coordinator.identityId}</code>
                {!participantIds.has(coordinator.identityId) ? (
                  <span>Not listed among this investigation’s recorded participants.</span>
                ) : null}
              </div>
            )}
            {recorded.updatedAt !== null || recorded.updatedBy !== null ? (
              <dl>
                {recorded.updatedAt !== null ? <div><dt>Recorded update</dt><dd>{timestampLabel(recorded.updatedAt)}</dd></div> : null}
                {recorded.updatedBy !== null ? <div><dt>Recorded by</dt><dd>{recorded.updatedBy.username} ({recorded.updatedBy.identityId})</dd></div> : null}
              </dl>
            ) : null}
          </div>

          {available?.refresh === "loading" ? (
            <p className="strategy-kit__coordination-status" role="status">Refreshing recorded coordination…</p>
          ) : null}
          {available?.refresh === "failed" ? (
            <div className="strategy-kit__coordination-notice" role="alert">
              <p>{readFailureCopy(available.refreshError)}</p>
              <button type="button" onClick={props.refreshCoordination}>Retry coordination</button>
            </div>
          ) : null}

          {archived ? (
            <p className="strategy-kit__coordination-status">Coordination cannot change while this investigation is archived.</p>
          ) : !resourceReady ? (
            <p className="strategy-kit__coordination-status">Coordination changes require a confirmed current record.</p>
          ) : props.identity.id.trim() === "" ? (
            <p className="strategy-kit__coordination-status">Sign in to make coordination changes.</p>
          ) : !props.canCoordinateSelf && !props.canCoordinateParticipants ? (
            <p className="strategy-kit__coordination-status">You can review recorded coordination, but changes are unavailable with your current access.</p>
          ) : props.applyAction === null ? (
            <p className="strategy-kit__coordination-status">Coordination changes are unavailable in this view.</p>
          ) : (
            <div className="strategy-kit__coordination-actions">
              {props.canCoordinateSelf && coordinator === null ? (
                <button
                  type="button"
                  disabled={busy || matchesRetainedIntent({ action: "claim_self", targetIdentityId: null })}
                  onClick={(event) => requestConfirmation({ action: "claim_self", targetIdentityId: null }, event)}
                >
                  Claim coordination
                </button>
              ) : null}
              {props.canCoordinateSelf && coordinator?.identityId === props.identity.id ? (
                <button
                  type="button"
                  disabled={busy || matchesRetainedIntent({ action: "release_self", targetIdentityId: null })}
                  onClick={(event) => requestConfirmation({ action: "release_self", targetIdentityId: null }, event)}
                >
                  Release my coordination
                </button>
              ) : null}
              {props.canCoordinateParticipants ? (
                <details>
                  <summary>Participant coordination</summary>
                  <p>Recorded participants are choices only; the server verifies whether an assignment can be accepted.</p>
                  <label>
                    <span>Participant</span>
                    <select
                      value={selectedParticipant}
                      disabled={busy || props.participants.length === 0}
                      onChange={(event) => {
                        setSelectedParticipant(event.target.value);
                        setConfirmation(null);
                        setRetryIntent(null);
                        setFeedback(null);
                      }}
                    >
                      {props.participants.length === 0 ? <option value="">No recorded participants</option> : null}
                      {props.participants.map((participant) => (
                        <option key={participant.identityId} value={participant.identityId}>
                          {participant.username} ({participant.identityId})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="strategy-kit__coordination-privileged-actions">
                    <button
                      type="button"
                      disabled={busy || selectedParticipant === "" || matchesRetainedIntent({ action: "assign_participant", targetIdentityId: selectedParticipant })}
                      onClick={(event) => requestConfirmation({ action: "assign_participant", targetIdentityId: selectedParticipant }, event)}
                    >
                      Review participant assignment
                    </button>
                    {coordinator !== null ? (
                      <button
                        type="button"
                        disabled={busy || matchesRetainedIntent({ action: "release_participant", targetIdentityId: coordinator.identityId })}
                        onClick={(event) => requestConfirmation({ action: "release_participant", targetIdentityId: coordinator.identityId }, event)}
                      >
                        Release recorded coordinator
                      </button>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {confirmation !== null ? (
        <div className="strategy-kit__coordination-confirm" role="group" aria-labelledby={confirmationId}>
          <p id={confirmationId}>{intentLabel(confirmation, props.participants)}</p>
          <button
            ref={confirmationButtonRef}
            type="button"
            disabled={busy}
            aria-describedby={confirmationId}
            onClick={(event) => void execute({ ...confirmation, idempotencyKey: createCoordinationIdempotencyKey() }, event.currentTarget)}
          >
            {confirmationButtonLabel(confirmation.action)}
          </button>
          <button type="button" disabled={busy} onClick={cancelConfirmation}>Cancel</button>
        </div>
      ) : null}

      {busy ? <p className="strategy-kit__coordination-status" role="status">Recording one coordination action…</p> : null}
      {!busy && feedback?.status === "succeeded" ? (
        <p className="strategy-kit__coordination-success" role="status">Coordination was updated.</p>
      ) : null}
      {!busy && feedback?.status === "ignored" ? (
        <p className="strategy-kit__coordination-notice" role="status">{ignoredCopy(feedback)}</p>
      ) : null}
      {!busy && reportedFailure !== null ? (
        <div className="strategy-kit__coordination-notice" role="alert">
          <p>{failureCopy(reportedFailure)}</p>
          {reportedFailure === "outcome_unknown" && retryIntent !== null ? (
            <div className="strategy-kit__coordination-retry">
              <button type="button" onClick={props.refreshCoordination}>Refresh coordination</button>
              <button
                type="button"
                disabled={!permitted(retryIntent, true)}
                onClick={(event) => void execute(retryIntent, event.currentTarget, true)}
              >
                Retry exact action
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
