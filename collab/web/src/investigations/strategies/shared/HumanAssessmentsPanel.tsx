import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "./presentation.js";

export const HUMAN_ASSESSMENT_VALUES = [
  "corroborates",
  "contradicts",
  "insufficient_evidence",
] as const;
export type HumanAssessmentValue = (typeof HUMAN_ASSESSMENT_VALUES)[number];

export type HumanAssessmentLinkKind = "artifact" | "contribution" | "snapshot";

export interface HumanAssessmentCitationChoice {
  readonly kind: "artifact" | "contribution";
  readonly id: string;
  readonly label: string;
}

export interface HumanAssessmentLink {
  readonly kind: HumanAssessmentLinkKind;
  readonly id: string;
  readonly label: string;
}

export interface HumanAssessmentRecord {
  readonly seq: number;
  readonly value: HumanAssessmentValue;
  readonly actorUsername: string;
  readonly recordedAt: string;
  readonly rationale: string | null;
  readonly links: readonly HumanAssessmentLink[];
}

export type HumanAssessmentsReadError = "unavailable" | "not_found" | "auth_lost";

export type HumanAssessmentsResourceState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous?: readonly HumanAssessmentRecord[] }
  | { readonly status: "ready"; readonly value: readonly HumanAssessmentRecord[] }
  | {
      readonly status: "failed";
      readonly error: HumanAssessmentsReadError;
      readonly previous?: readonly HumanAssessmentRecord[];
    };

export type HumanAssessmentsWriteError =
  | "conflict"
  | "links_required"
  | "case_archived"
  | "privacy_mismatch"
  | "idempotency_intent_mismatch"
  | "judgment_limit_reached"
  | "commit_outcome_unknown"
  | "auth_lost"
  | "not_found"
  | "validation"
  | "definitive";

export type HumanAssessmentsMutationState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: HumanAssessmentsWriteError };

export interface HumanAssessmentCreateInput {
  readonly judgment: HumanAssessmentValue;
  readonly links: readonly HumanAssessmentCitationChoice[];
  readonly rationale: string | null;
  readonly idempotencyKey: string;
}

export type HumanAssessmentCreateResult =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: HumanAssessmentsWriteError }
  | { readonly status: "ignored"; readonly reason: "busy" | "stale" | "not_ready" };

export type HumanAssessmentCreateCommand = (
  input: HumanAssessmentCreateInput,
) => Promise<HumanAssessmentCreateResult>;

export interface HumanAssessmentsPanelProps {
  readonly resource: HumanAssessmentsResourceState;
  readonly mutation?: HumanAssessmentsMutationState;
  readonly citationChoices: readonly HumanAssessmentCitationChoice[];
  readonly createAssessment: HumanAssessmentCreateCommand | null;
  readonly refresh: () => void;
}

const MAX_LINKS = 64;
const MAX_RATIONALE = 4000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

let fallbackSerial = 0;

function createAssessmentIdempotencyKey(): string {
  fallbackSerial += 1;
  const unique = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `fallback-${Date.now().toString(16)}-${fallbackSerial.toString(16).padStart(4, "0")}`;
  const key = `assess-${unique}`.slice(0, 128);
  return IDEMPOTENCY_KEY.test(key)
    ? key
    : `assess${unique.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 120)}`;
}

function timestampLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function valueLabel(value: HumanAssessmentValue): string {
  switch (value) {
    case "corroborates":
      return "Corroborates";
    case "contradicts":
      return "Contradicts";
    case "insufficient_evidence":
      return "Insufficient evidence";
  }
}

function citationKey(link: { readonly kind: string; readonly id: string }): string {
  return `${link.kind}:${link.id}`;
}

function fingerprintOf(
  judgment: HumanAssessmentValue | "",
  links: readonly HumanAssessmentCitationChoice[],
  rationale: string,
): string {
  return JSON.stringify({
    judgment,
    links: links.map((link) => ({ kind: link.kind, id: link.id })),
    rationale,
  });
}

function readErrorCopy(error: HumanAssessmentsReadError): string {
  switch (error) {
    case "auth_lost":
      return "Your access changed while this view was open. Sign in again before loading assessments.";
    case "not_found":
      return "This imported output is no longer available in the current scope.";
    case "unavailable":
      return "Recorded human assessments could not be loaded right now.";
  }
}

function writeErrorCopy(error: HumanAssessmentsWriteError): string {
  switch (error) {
    case "conflict":
      return "Another assessment was recorded first. This draft remains available. Review the refreshed history before recording.";
    case "links_required":
      return "This reading needs at least one citation. Select a cited record and try again. This draft remains available.";
    case "case_archived":
      return "This investigation is archived, so a new assessment cannot be recorded. Existing assessments remain visible.";
    case "privacy_mismatch":
      return "A cited record is not available at the current privacy boundary. Review the citations and try again. This draft remains available.";
    case "idempotency_intent_mismatch":
      return "This retry no longer matches the original assessment. Review the draft before recording a new assessment.";
    case "judgment_limit_reached":
      return "This imported output has reached the recorded assessment limit. No further assessment can be added here.";
    case "commit_outcome_unknown":
      return "This view could not confirm the result. The assessment may have been recorded. Refresh the history, then retry this exact assessment with the same request key. The draft is frozen.";
    case "auth_lost":
      return "Your access changed while this view was open. Sign in again before writing. Local retry is not available.";
    case "not_found":
      return "This imported output is no longer available for assessment in the current scope.";
    case "validation":
      return "The assessment could not be accepted. Review the draft. This draft remains available.";
    case "definitive":
      return "The assessment could not be recorded. This draft remains available.";
  }
}

function ignoredCopy(reason: "busy" | "stale" | "not_ready"): string {
  switch (reason) {
    case "busy":
      return "Another assessment is already being recorded. This draft remains available.";
    case "stale":
      return "This view changed before the submission result could be accepted. Review the current record before retrying. This draft remains available.";
    case "not_ready":
      return "Assessment writing became unavailable before this submission could start. This draft remains available.";
  }
}

function publishedRecords(
  resource: HumanAssessmentsResourceState,
): readonly HumanAssessmentRecord[] | undefined {
  if (resource.status === "ready") return resource.value;
  if (resource.status === "loading" || resource.status === "failed") return resource.previous;
  return undefined;
}

function orderedRecords(
  records: readonly HumanAssessmentRecord[],
): readonly HumanAssessmentRecord[] {
  return [...records].sort((left, right) => left.seq - right.seq);
}

interface FrozenDraft {
  readonly judgment: HumanAssessmentValue;
  readonly links: readonly HumanAssessmentCitationChoice[];
  readonly rationale: string;
  readonly idempotencyKey: string;
}

type SubmissionFeedback =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly error: HumanAssessmentsWriteError }
  | { readonly status: "ignored"; readonly reason: "busy" | "stale" | "not_ready" }
  | { readonly status: "invalid"; readonly message: string };

function HistoryList(props: {
  readonly records: readonly HumanAssessmentRecord[];
}): ReactNode {
  const records = orderedRecords(props.records);
  if (records.length === 0) {
    return (
      <StrategyStateNotice>
        No human assessment has been recorded yet.
      </StrategyStateNotice>
    );
  }
  return (
    <ol className="strategy-kit__human-assessments-history-list">
      {records.map((record) => (
        <li key={record.seq} className="strategy-kit__human-assessments-item">
          <p className="strategy-kit__human-assessments-value">{valueLabel(record.value)}</p>
          <p className="strategy-kit__human-assessments-meta">
            {record.actorUsername}
            {" · "}
            <time dateTime={record.recordedAt}>{timestampLabel(record.recordedAt)}</time>
          </p>
          <p className="strategy-kit__human-assessments-rationale">
            {record.rationale?.trim() ? record.rationale : "No rationale recorded"}
          </p>
          {record.links.length === 0 ? (
            <p className="strategy-kit__human-assessments-meta">No citations recorded</p>
          ) : (
            <ul className="strategy-kit__human-assessments-citations">
              {record.links.map((link) => (
                <li key={citationKey(link)}>{link.label}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

export function HumanAssessmentsPanel({
  resource,
  mutation,
  citationChoices,
  createAssessment,
  refresh,
}: HumanAssessmentsPanelProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const historyId = `${id}-history`;
  const formTitleId = `${id}-form`;
  const valueLegendId = `${id}-value`;
  const citationsLegendId = `${id}-citations`;
  const rationaleId = `${id}-rationale`;
  const rationaleHelpId = `${id}-rationale-help`;
  const rationaleCountId = `${id}-rationale-count`;
  const alertRef = useRef<HTMLDivElement>(null);
  const focusedFailureRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const intentRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const refreshStartResourceRef = useRef<HumanAssessmentsResourceState | null>(null);
  const [judgment, setJudgment] = useState<HumanAssessmentValue | "">("");
  const [selected, setSelected] = useState<HumanAssessmentCitationChoice[]>([]);
  const [rationale, setRationale] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createAssessmentIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<SubmissionFeedback | null>(null);
  const [frozen, setFrozen] = useState<FrozenDraft | null>(null);
  const [historyReviewed, setHistoryReviewed] = useState(false);
  const [awaitingHistoryReview, setAwaitingHistoryReview] = useState(false);

  const records = publishedRecords(resource);
  const hasSnapshot = records !== undefined;
  const busy = resource.status === "idle"
    || resource.status === "loading"
    || submitting
    || mutation?.status === "running";
  const readFailed = resource.status === "failed";
  const readError = readFailed ? resource.error : null;
  const writeBlocked = readError === "auth_lost"
    || readError === "not_found"
    || frozen !== null
    || createAssessment === null;
  const canWrite = createAssessment !== null
    && records !== undefined
    && readError !== "auth_lost"
    && readError !== "not_found";
  const running = submitting || mutation?.status === "running";
  const writeError = feedback?.status === "failed"
    ? feedback.error
    : mutation?.status === "failed" && feedback?.status !== "succeeded"
      ? mutation.error
      : null;
  const failureKey = writeError ?? (feedback?.status === "invalid" ? feedback.message : null)
    ?? (feedback?.status === "ignored" ? feedback.reason : null);
  const atLinkCap = selected.length >= MAX_LINKS;
  const citationsRequired = judgment === "corroborates" || judgment === "contradicts";
  const canSubmit = !running
    && frozen === null
    && canWrite
    && judgment !== ""
    && rationale.length <= MAX_RATIONALE
    && selected.length <= MAX_LINKS
    && (!citationsRequired || selected.length > 0);

  useEffect(() => {
    if (failureKey === null) {
      focusedFailureRef.current = null;
      return;
    }
    if (focusedFailureRef.current === failureKey) return;
    focusedFailureRef.current = failureKey;
    alertRef.current?.focus();
  }, [failureKey]);

  useEffect(() => {
    if (frozen === null) {
      refreshStartResourceRef.current = null;
      setAwaitingHistoryReview(false);
      return;
    }
    if (
      awaitingHistoryReview
      && resource !== refreshStartResourceRef.current
      && resource.status === "ready"
    ) {
      refreshStartResourceRef.current = null;
      setAwaitingHistoryReview(false);
      setHistoryReviewed(true);
    }
  }, [awaitingHistoryReview, frozen, resource]);

  function clearTransientFeedback() {
    if (frozen !== null) return;
    if (intentRef.current !== null) {
      intentRef.current = null;
      setIdempotencyKey(createAssessmentIdempotencyKey());
    }
    setFeedback(null);
  }

  function selectedHas(choice: HumanAssessmentCitationChoice): boolean {
    return selected.some((item) => citationKey(item) === citationKey(choice));
  }

  function toggleCitation(choice: HumanAssessmentCitationChoice) {
    if (frozen !== null) return;
    clearTransientFeedback();
    setSelected((current) => {
      if (current.some((item) => citationKey(item) === citationKey(choice))) {
        return current.filter((item) => citationKey(item) !== citationKey(choice));
      }
      if (current.length >= MAX_LINKS) return current;
      return [...current, choice];
    });
  }

  function currentFingerprint(): string {
    return fingerprintOf(judgment, selected, rationale);
  }

  function intentForCurrentDraft(): { fingerprint: string; idempotencyKey: string } {
    const fingerprint = currentFingerprint();
    const prior = intentRef.current;
    if (frozen !== null) {
      return { fingerprint, idempotencyKey: frozen.idempotencyKey };
    }
    if (prior?.fingerprint === fingerprint) return prior;
    const next = { fingerprint, idempotencyKey };
    intentRef.current = next;
    return next;
  }

  async function applyOutcome(
    outcome: HumanAssessmentCreateResult,
    intent: { fingerprint: string; idempotencyKey: string },
    draft: FrozenDraft,
  ) {
    submittingRef.current = false;
    setSubmitting(false);
    if (outcome.status === "succeeded") {
      intentRef.current = null;
      refreshStartResourceRef.current = null;
      setFrozen(null);
      setAwaitingHistoryReview(false);
      setHistoryReviewed(false);
      setJudgment("");
      setSelected([]);
      setRationale("");
      setIdempotencyKey(createAssessmentIdempotencyKey());
      setFeedback({ status: "succeeded" });
      return;
    }
    if (outcome.status === "ignored") {
      setFeedback({ status: "ignored", reason: outcome.reason });
      return;
    }
    if (outcome.error === "commit_outcome_unknown" || outcome.error === "conflict") {
      const frozenLinks = Object.freeze(draft.links.map((link) => Object.freeze({ ...link })));
      setFrozen(Object.freeze({ ...draft, links: frozenLinks }));
      setHistoryReviewed(false);
      intentRef.current = {
        fingerprint: intent.fingerprint,
        idempotencyKey: draft.idempotencyKey,
      };
      setFeedback({ status: "failed", error: outcome.error });
      return;
    }
    setFeedback({ status: "failed", error: outcome.error });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (frozen !== null || submittingRef.current || running || createAssessment === null) return;
    if (judgment === "") return;
    if (citationsRequired && selected.length === 0) {
      setFeedback({
        status: "invalid",
        message: "Corroborates and Contradicts need at least one citation.",
      });
      return;
    }
    if (selected.length > MAX_LINKS) {
      setFeedback({
        status: "invalid",
        message: `Select at most ${MAX_LINKS} citations.`,
      });
      return;
    }
    if (rationale.length > MAX_RATIONALE) {
      setFeedback({
        status: "invalid",
        message: `Rationale must be at most ${MAX_RATIONALE} characters.`,
      });
      return;
    }

    const intent = intentForCurrentDraft();
    const trimmed = rationale.trim();
    const draft: FrozenDraft = {
      judgment,
      links: selected,
      rationale,
      idempotencyKey: intent.idempotencyKey,
    };
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let outcome: HumanAssessmentCreateResult;
    try {
      outcome = await createAssessment({
        judgment,
        links: selected,
        rationale: trimmed.length === 0 ? null : trimmed,
        idempotencyKey: intent.idempotencyKey,
      });
    } catch {
      submittingRef.current = false;
      setSubmitting(false);
      setFeedback({ status: "failed", error: "definitive" });
      return;
    }
    await applyOutcome(outcome, intent, draft);
  }

  async function retryFrozen() {
    if (frozen === null || !historyReviewed || submittingRef.current || running || createAssessment === null) {
      return;
    }
    const trimmed = frozen.rationale.trim();
    const intent = {
      fingerprint: fingerprintOf(frozen.judgment, frozen.links, frozen.rationale),
      idempotencyKey: frozen.idempotencyKey,
    };
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let outcome: HumanAssessmentCreateResult;
    try {
      outcome = await createAssessment({
        judgment: frozen.judgment,
        links: frozen.links,
        rationale: trimmed.length === 0 ? null : trimmed,
        idempotencyKey: frozen.idempotencyKey,
      });
    } catch {
      submittingRef.current = false;
      setSubmitting(false);
      setFeedback({ status: "failed", error: "definitive" });
      return;
    }
    await applyOutcome(outcome, intent, frozen);
  }

  function refreshHistory() {
    if (frozen !== null) {
      setHistoryReviewed(false);
      refreshStartResourceRef.current = resource;
      setAwaitingHistoryReview(true);
    }
    refresh();
  }

  const retryRead = readError === "not_found" || readError === "auth_lost"
    ? undefined
    : <button type="button" onClick={refreshHistory}>Retry</button>;
  const fieldsDisabled = frozen !== null || running;
  const showWrite = canWrite;

  return (
    <StrategySurface className="strategy-kit__human-assessments" labelledBy={titleId}>
      <StrategyPanel
        title="Human assessments"
        titleId={titleId}
        description={(
          <>
            <p>Recorded human readings of this imported output. An assessment is not a correctness verdict.</p>
            <p>
              The banner and Save review above are the existing run-review status.
              Assessments are a separate append-only history and do not change that status.
            </p>
          </>
        )}
        actions={<StrategyBadge>Append-only record</StrategyBadge>}
        busy={busy}
        className="strategy-kit__human-assessments-panel"
      >
        {resource.status === "idle" ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Waiting for recorded human assessments.</span>
          </StrategyStateNotice>
        ) : null}
        {resource.status === "loading" && resource.previous === undefined ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Loading recorded human assessments…</span>
          </StrategyStateNotice>
        ) : null}
        {readFailed && resource.previous === undefined ? (
          <StrategyStateNotice
            tone="danger"
            role="alert"
            title="Human assessments unavailable"
            {...(retryRead ? { action: retryRead } : {})}
          >
            {readErrorCopy(resource.error)}
          </StrategyStateNotice>
        ) : null}
        {hasSnapshot && resource.status === "failed" ? (
          <StrategyStateNotice
            tone="warning"
            role="alert"
            title="Human assessments refresh failed"
            {...(retryRead ? { action: retryRead } : {})}
          >
            {readErrorCopy(resource.error)} Previously loaded assessments remain visible.
          </StrategyStateNotice>
        ) : null}
        {hasSnapshot && resource.status === "loading" ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Refreshing recorded human assessments…</span>
          </StrategyStateNotice>
        ) : null}

        <section className="strategy-kit__human-assessments-history" aria-labelledby={historyId}>
          <h4 id={historyId}>Recorded assessments</h4>
          {records !== undefined ? <HistoryList records={records} /> : null}
          {!hasSnapshot && resource.status !== "failed" ? (
            <p className="strategy-kit__human-assessments-meta">
              Recorded assessments appear here after this load succeeds.
            </p>
          ) : null}
        </section>

        {!showWrite ? (
          <StrategyStateNotice title="Assessment writing unavailable">
            {readError === "auth_lost"
              ? "Your access changed while this view was open. Sign in again before writing. Local retry is not available."
              : readError === "not_found"
                ? "This imported output is no longer available for assessment in the current scope."
                : createAssessment === null
                  ? "This view cannot record a human assessment for the current imported output. Existing recorded assessments remain visible, and no writing controls are available."
                  : "Assessment writing becomes available only after the recorded history loads successfully, so a sequence-safe assessment cannot be submitted yet."}
          </StrategyStateNotice>
        ) : (
          <section className="strategy-kit__human-assessments-form" aria-labelledby={formTitleId}>
            <h4 id={formTitleId}>Record an assessment</h4>
            <form
              aria-labelledby={formTitleId}
              aria-busy={running}
              onSubmit={(event) => void submit(event)}
            >
              <fieldset disabled={fieldsDisabled} className="strategy-kit__human-assessments-fieldset">
                <legend id={valueLegendId}>Assessment</legend>
                {HUMAN_ASSESSMENT_VALUES.map((value) => (
                  <label key={value} className="strategy-kit__human-assessments-choice">
                    <input
                      type="radio"
                      name={`${id}-judgment`}
                      value={value}
                      checked={judgment === value}
                      onChange={() => {
                        clearTransientFeedback();
                        setJudgment(value);
                      }}
                    />
                    <span>{valueLabel(value)}</span>
                  </label>
                ))}
              </fieldset>

              <fieldset disabled={fieldsDisabled} className="strategy-kit__human-assessments-fieldset">
                <legend id={citationsLegendId}>Citations</legend>
                <p className="strategy-kit__human-assessments-help">
                  Corroborates and Contradicts need at least one citation. Insufficient evidence may have none.
                  Select at most {MAX_LINKS}.
                </p>
                {citationChoices.length === 0 ? (
                  <p className="strategy-kit__human-assessments-meta">No citable records are available in this view.</p>
                ) : (
                  citationChoices.map((choice) => {
                    const checked = selectedHas(choice);
                    return (
                      <label key={citationKey(choice)} className="strategy-kit__human-assessments-choice">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={fieldsDisabled || (!checked && atLinkCap)}
                          onChange={() => toggleCitation(choice)}
                        />
                        <span>{choice.label}</span>
                      </label>
                    );
                  })
                )}
              </fieldset>

              <label className="strategy-kit__human-assessments-rationale-field" htmlFor={rationaleId}>
                <span>Rationale (optional)</span>
                <textarea
                  id={rationaleId}
                  value={rationale}
                  rows={4}
                  maxLength={MAX_RATIONALE}
                  disabled={fieldsDisabled}
                  aria-describedby={`${rationaleHelpId} ${rationaleCountId}`}
                  onChange={(event) => {
                    if (frozen !== null) return;
                    clearTransientFeedback();
                    setRationale(event.target.value.slice(0, MAX_RATIONALE));
                  }}
                />
              </label>
              <p id={rationaleHelpId} className="strategy-kit__human-assessments-help">
                Optional. Record why this reading was made. Maximum {MAX_RATIONALE} characters.
              </p>
              <p id={rationaleCountId} className="strategy-kit__human-assessments-count">
                {rationale.length} / {MAX_RATIONALE}
              </p>

              <StrategyActionRow className="strategy-kit__human-assessments-actions">
                {frozen === null ? (
                  <button type="submit" disabled={!canSubmit}>
                    {running ? "Recording assessment…" : "Record assessment"}
                  </button>
                ) : (
                  <>
                    <button type="button" onClick={refreshHistory}>
                      Refresh recorded assessments
                    </button>
                    <button
                      type="button"
                      disabled={!historyReviewed || running}
                      onClick={() => void retryFrozen()}
                    >
                      Retry
                    </button>
                  </>
                )}
              </StrategyActionRow>
            </form>
          </section>
        )}

        {running ? (
          <StrategyStateNotice busy>
            <span aria-live="polite">Recording the assessment once…</span>
          </StrategyStateNotice>
        ) : null}
        {!running && (writeError !== null || feedback?.status === "invalid" || feedback?.status === "ignored") ? (
          <div ref={alertRef} tabIndex={-1}>
            <StrategyStateNotice
              role="alert"
              tone="danger"
              title={writeError === "commit_outcome_unknown"
                ? "Assessment outcome unknown"
                : writeError === "conflict"
                  ? "Another assessment was recorded first"
                  : "Assessment not recorded"}
            >
              {writeError !== null
                ? writeErrorCopy(writeError)
                : feedback?.status === "ignored"
                  ? ignoredCopy(feedback.reason)
                  : feedback?.status === "invalid"
                    ? feedback.message
                    : null}
            </StrategyStateNotice>
          </div>
        ) : null}
        {!running && feedback?.status === "succeeded" ? (
          <StrategyStateNotice tone="success" title="Assessment recorded">
            <span aria-live="polite">The assessment was recorded.</span>
          </StrategyStateNotice>
        ) : null}
        {writeBlocked && frozen !== null && !historyReviewed ? (
          <StrategyStateNotice tone="warning" title="Refresh required">
            Refresh the recorded history before retrying this exact assessment. The draft and request key stay frozen.
          </StrategyStateNotice>
        ) : null}
      </StrategyPanel>
    </StrategySurface>
  );
}
