import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "./presentation.js";
import {
  composeHandoffBody,
  createHandoffIdempotencyKey,
  recordedHandoffText,
  selectHandoffFacts,
  selectHandoffResourceView,
  type HandoffCaseRecord,
  type HandoffContributionRecord,
  type HandoffCreateCommand,
  type HandoffCreateResult,
  type HandoffMutationState,
  type HandoffResourceState,
} from "./handoff.js";

export interface HandoffPanelProps {
  readonly investigationId: string;
  readonly investigation: HandoffCaseRecord | null;
  readonly contributions: HandoffResourceState<readonly HandoffContributionRecord[]>;
  readonly createContribution: HandoffCreateCommand | null;
  readonly refreshContributions: () => void;
  readonly mutationState?: HandoffMutationState;
}

interface SubmissionIntent {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

type SubmissionFeedback =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly kind: string }
  | { readonly status: "ignored"; readonly reason: string };

const UNCERTAIN_KINDS = new Set([
  "unavailable",
  "server_failure",
  "network",
  "aborted",
  "unexpected_response",
  "protocol",
  "unexpected",
]);

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function authorLabel(value: string): string {
  const recorded = recordedHandoffText(value);
  return recorded === "Not recorded" ? recorded : value.trim();
}

function isUnknownOutcome(kind: string): boolean {
  return UNCERTAIN_KINDS.has(kind);
}

function failureCopy(kind: string): string {
  if (kind === "conflict") {
    return "The investigation record changed before this handoff was stored. This draft remains available. Review the current record before retrying.";
  }
  if (kind === "validation" || kind === "input") {
    return "The handoff could not be accepted. Review the draft. This draft remains available.";
  }
  if (kind === "auth_lost") {
    return "Your access changed while this view was open. Sign in again before writing. This draft remains available.";
  }
  if (kind === "not_found") {
    return "The current investigation is no longer available for this handoff. This draft remains available.";
  }
  if (isUnknownOutcome(kind)) {
    return "This view could not confirm the result. The handoff may have been recorded. Review the current record before retrying.";
  }
  return "The handoff could not be recorded. This draft remains available.";
}

function ignoredCopy(reason: string): string {
  if (reason === "busy") {
    return "Another contribution is already in progress. This draft remains available.";
  }
  if (reason === "stale") {
    return "This view changed before the submission result could be accepted. Review the current record before retrying. This draft remains available.";
  }
  if (reason === "not_ready") {
    return "Handoff writing became unavailable before this submission could start. This draft remains available.";
  }
  return "This handoff was not recorded. This draft remains available.";
}

function FactSection(props: {
  readonly title: string;
  readonly titleId: string;
  readonly children: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <section className="strategy-kit__handoff-section" aria-labelledby={props.titleId}>
      <h4 id={props.titleId}>{props.title}</h4>
      {props.children}
      {props.meta ? <p className="strategy-kit__handoff-meta">{props.meta}</p> : null}
    </section>
  );
}

function contributionMeta(record: HandoffContributionRecord): string {
  return `Recorded by ${authorLabel(record.authorUsername)} · ${timestampLabel(record.createdAt)}`;
}

function HandoffDraftForm(props: {
  readonly createContribution: HandoffCreateCommand;
  readonly mutationState?: HandoffMutationState;
  readonly formTitleId: string;
  readonly noteId: string;
  readonly actionId: string;
}) {
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<SubmissionFeedback | null>(null);
  const [lastSubmittedFingerprint, setLastSubmittedFingerprint] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const submissionIntentRef = useRef<SubmissionIntent | null>(null);
  const running = submitting || props.mutationState?.status === "running";
  const canSubmit = note.trim().length > 0 && !running;
  const command = props.createContribution;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || props.mutationState?.status === "running") return;
    if (note.trim().length === 0) return;

    const body = composeHandoffBody(note, nextAction);
    const fingerprint = body;
    const priorIntent = submissionIntentRef.current;
    const submissionIntent = priorIntent?.fingerprint === fingerprint
      ? priorIntent
      : {
          fingerprint,
          idempotencyKey: createHandoffIdempotencyKey(),
        };
    submissionIntentRef.current = submissionIntent;
    setLastSubmittedFingerprint(fingerprint);
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);

    let outcome: HandoffCreateResult;
    try {
      outcome = await command({
        kind: "handoff",
        body,
        privacyClass: "share_safe",
        idempotencyKey: submissionIntent.idempotencyKey,
      });
    } catch {
      setFeedback({ status: "failed", kind: "unexpected" });
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    submittingRef.current = false;
    setSubmitting(false);
    if (outcome.status === "succeeded") {
      if (submissionIntentRef.current?.fingerprint === fingerprint) {
        submissionIntentRef.current = null;
      }
      setLastSubmittedFingerprint(null);
      setNote("");
      setNextAction("");
      setFeedback({ status: "succeeded" });
      return;
    }
    if (outcome.status === "ignored") {
      setFeedback({ status: "ignored", reason: outcome.reason });
      return;
    }
    setFeedback({
      status: "failed",
      kind: outcome.error?.kind ?? "unexpected",
    });
  }

  const currentFingerprint = composeHandoffBody(note, nextAction);
  const appliesToCurrent = lastSubmittedFingerprint === currentFingerprint;
  const reportedKind = !running && appliesToCurrent
    ? props.mutationState?.status === "failed"
      ? props.mutationState.error?.kind ?? "unexpected"
      : feedback?.status === "failed"
        ? feedback.kind
        : null
    : null;
  const unknownOutcome = reportedKind !== null && isUnknownOutcome(reportedKind);

  return (
    <section className="strategy-kit__handoff-form" aria-labelledby={props.formTitleId}>
      <h4 id={props.formTitleId}>Record a handoff</h4>
      <form
        aria-labelledby={props.formTitleId}
        aria-busy={running}
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor={props.noteId}>
          <span>Note</span>
          <textarea
            id={props.noteId}
            value={note}
            rows={4}
            required
            onChange={(event) => {
              setNote(event.target.value);
              setFeedback(null);
            }}
          />
        </label>
        <label htmlFor={props.actionId}>
          <span>Next action (optional)</span>
          <textarea
            id={props.actionId}
            value={nextAction}
            rows={3}
            onChange={(event) => {
              setNextAction(event.target.value);
              setFeedback(null);
            }}
          />
        </label>
        <StrategyActionRow>
          <button type="submit" disabled={!canSubmit}>
            {running ? "Recording handoff…" : "Record handoff"}
          </button>
        </StrategyActionRow>
      </form>
      {running ? (
        <StrategyStateNotice busy>
          <span aria-live="polite">Recording the handoff once…</span>
        </StrategyStateNotice>
      ) : null}
      {!running && reportedKind !== null ? (
        <StrategyStateNotice
          role="alert"
          tone="danger"
          title={unknownOutcome ? "Handoff outcome unknown" : "Handoff not recorded"}
        >
          {failureCopy(reportedKind)}
        </StrategyStateNotice>
      ) : null}
      {!running && feedback?.status === "ignored" ? (
        <StrategyStateNotice title="Submission not accepted by this view">
          {ignoredCopy(feedback.reason)}
        </StrategyStateNotice>
      ) : null}
      {!running && feedback?.status === "succeeded" ? (
        <StrategyStateNotice tone="success" title="Handoff recorded">
          <span aria-live="polite">The handoff was recorded.</span>
        </StrategyStateNotice>
      ) : null}
    </section>
  );
}

export function HandoffPanel({
  investigationId,
  investigation,
  contributions,
  createContribution,
  refreshContributions,
  mutationState,
}: HandoffPanelProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const whatId = `${id}-what`;
  const stateId = `${id}-state`;
  const nextId = `${id}-next`;
  const historyId = `${id}-history`;
  const formTitleId = `${id}-form`;
  const noteId = `${id}-note`;
  const actionId = `${id}-action`;
  const view = selectHandoffResourceView(contributions);
  const hasSnapshot = view.availability === "available";
  const facts = selectHandoffFacts(investigation, hasSnapshot ? view.value : []);
  const busy = view.availability === "idle"
    || view.availability === "loading"
    || (hasSnapshot && view.refresh === "loading")
    || mutationState?.status === "running";
  const whatHappened = hasSnapshot ? facts.whatHappened : null;
  const nextAction = hasSnapshot ? facts.nextAction : null;
  const liveHandoffs = hasSnapshot ? facts.liveHandoffs : [];
  const retry = <button type="button" onClick={refreshContributions}>Retry</button>;

  return (
    <StrategySurface className="strategy-kit__handoff" labelledBy={titleId}>
      <StrategyPanel
        title="Handoff"
        titleId={titleId}
        description={<p>Recorded shift notes, current state, and next action. Sparse values stay unknown.</p>}
        actions={<StrategyBadge>Recorded facts</StrategyBadge>}
        busy={busy}
        className="strategy-kit__handoff-panel"
      >
        {view.availability === "idle" || view.availability === "loading" ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Loading recorded handoff facts…</span>
          </StrategyStateNotice>
        ) : null}
        {view.availability === "unavailable" ? (
          <StrategyStateNotice
            tone="danger"
            role="alert"
            title="Handoff records unavailable"
            action={retry}
          >
            {view.error}
          </StrategyStateNotice>
        ) : null}
        {hasSnapshot && view.refresh === "failed" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Handoff refresh failed"
            action={retry}
          >
            {view.refreshError} Previously loaded facts remain visible.
          </StrategyStateNotice>
        ) : null}
        {hasSnapshot && view.refresh === "loading" ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Refreshing recorded handoff facts…</span>
          </StrategyStateNotice>
        ) : null}

        <div className="strategy-kit__handoff-grid">
          <FactSection title="What happened" titleId={whatId} {...(whatHappened ? { meta: contributionMeta(whatHappened) } : {})}>
            <p className="strategy-kit__handoff-body">
              {hasSnapshot
                ? recordedHandoffText(whatHappened?.body)
                : view.availability === "unavailable"
                  ? "Recorded facts are unavailable until this load succeeds."
                  : "Waiting for recorded facts."}
            </p>
          </FactSection>

          <section className="strategy-kit__handoff-section" aria-labelledby={stateId}>
            <h4 id={stateId}>Current state</h4>
            {facts.currentState === null ? (
              <p className="strategy-kit__handoff-body">Not recorded</p>
            ) : (
              <dl className="strategy-kit__handoff-state">
                <div>
                  <dt>Status</dt>
                  <dd>{recordedHandoffText(facts.currentState.status)}</dd>
                </div>
                <div>
                  <dt>Legal hold</dt>
                  <dd>{facts.currentState.legalHold ? "Yes" : "No"}</dd>
                </div>
              </dl>
            )}
          </section>

          <FactSection title="Next action" titleId={nextId} {...(nextAction ? { meta: contributionMeta(nextAction) } : {})}>
            <p className="strategy-kit__handoff-body">
              {hasSnapshot
                ? recordedHandoffText(nextAction?.body)
                : view.availability === "unavailable"
                  ? "Recorded facts are unavailable until this load succeeds."
                  : "Waiting for recorded facts."}
            </p>
          </FactSection>
        </div>

        <section className="strategy-kit__handoff-history" aria-labelledby={historyId}>
          <h4 id={historyId}>Handoff history</h4>
          {hasSnapshot && liveHandoffs.length === 0 ? (
            <StrategyStateNotice>No handoff has been recorded yet.</StrategyStateNotice>
          ) : null}
          {liveHandoffs.length > 0 ? (
            <ol>
              {liveHandoffs.map((record) => (
                <li key={`${record.id}:${record.revision}`}>
                  <p className="strategy-kit__handoff-body">{recordedHandoffText(record.body)}</p>
                  <p className="strategy-kit__handoff-meta">
                    {authorLabel(record.authorUsername)}
                    {" · "}
                    <time dateTime={record.createdAt}>{timestampLabel(record.createdAt)}</time>
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        {createContribution === null ? (
          <StrategyStateNotice title="Handoff writing unavailable">
            This view cannot record a handoff for the current investigation. Existing recorded facts remain visible, and no writing controls are available.
          </StrategyStateNotice>
        ) : (
          <HandoffDraftForm
            key={investigationId}
            createContribution={createContribution}
            formTitleId={formTitleId}
            noteId={noteId}
            actionId={actionId}
            {...(mutationState === undefined ? {} : { mutationState })}
          />
        )}
      </StrategyPanel>
    </StrategySurface>
  );
}
