import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyPanel,
  StrategyStateNotice,
} from "./presentation.js";

type CommandIgnoredReason = "busy" | "stale" | "not_ready";
type RuntimeFailureKind =
  | "input"
  | "validation"
  | "auth_lost"
  | "not_found"
  | "conflict"
  | "lifecycle_changed"
  | "lifecycle_refused"
  | "coordination_changed"
  | "coordination_refused"
  | "unavailable"
  | "server_failure"
  | "network"
  | "aborted"
  | "unexpected_response"
  | "protocol"
  | "unexpected";

interface RuntimeFailureView { readonly kind: RuntimeFailureKind }
type CommandOutcome<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: RuntimeFailureView }
  | { readonly status: "ignored"; readonly reason: CommandIgnoredReason };
type MutationState<T> =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: RuntimeFailureView };
interface CreateHypothesisInput {
  readonly kind: "hypothesis";
  readonly body: string;
  readonly hypothesisLinks: readonly {
    readonly kind: "artifact" | "contribution";
    readonly id: string;
  }[];
  readonly idempotencyKey: string;
}
type CreateContributionCommand<T> = (
  command: CreateHypothesisInput,
) => Promise<CommandOutcome<T>>;

export interface EvidenceHypothesisEvidence {
  readonly id: string;
  readonly name: string;
}

export interface EvidenceHypothesisContribution {
  readonly id: string;
  readonly name: string;
}

export interface EvidenceHypothesisComposerProps<TContribution = unknown> {
  /**
   * Opaque identity + investigation scope supplied by the composition root.
   * It fences presentation state only and never grants write authority.
   */
  readonly scopeKey: string;
  /** The current presentation-owned working set. Only these artifact IDs may be cited. */
  readonly selectedEvidence: readonly EvidenceHypothesisEvidence[];
  /** Optional current-record contribution choices. At most one may accompany the artifact working set. */
  readonly contributionSources?: readonly EvidenceHypothesisContribution[];
  /** A resolved public Runtime command. Null means this presentation cannot write. */
  readonly createContribution: CreateContributionCommand<TContribution> | null;
  readonly mutationState: MutationState<TContribution>;
  readonly onSuccess?: (contribution: TContribution) => void;
  /** Compatibility-only namespace; new shared consumers use the default. */
  readonly idempotencyKeyPrefix?: string;
}

type SubmissionFeedback =
  | {
      readonly status: "succeeded";
      readonly artifactCount: number;
      readonly contributionCited: boolean;
    }
  | { readonly status: "failed"; readonly error: RuntimeFailureView | null }
  | { readonly status: "ignored"; readonly reason: CommandIgnoredReason };

interface SubmissionIntent {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

function failureOutcomeIsUnknown(error: RuntimeFailureView): boolean {
  switch (error.kind) {
    case "unavailable":
    case "server_failure":
    case "network":
    case "aborted":
    case "unexpected_response":
    case "protocol":
    case "unexpected":
      return true;
    case "input":
    case "validation":
    case "auth_lost":
    case "not_found":
    case "conflict":
    case "lifecycle_changed":
    case "lifecycle_refused":
    case "coordination_changed":
    case "coordination_refused":
      return false;
  }
}

function contributionFailureCopy(error: RuntimeFailureView): string {
  switch (error.kind) {
    case "input":
    case "validation":
      return "The hypothesis could not be accepted. Review the draft and cited evidence.";
    case "auth_lost":
      return "Your access changed while this view was open. Sign in again before writing.";
    case "not_found":
      return "The current investigation is no longer available for this hypothesis.";
    case "conflict":
    case "lifecycle_changed":
    case "coordination_changed":
    case "coordination_refused":
      return "The investigation changed before the hypothesis was recorded. Review the current record before trying again.";
    case "lifecycle_refused":
      return "The investigation does not currently allow this contribution.";
    case "unavailable":
    case "server_failure":
    case "network":
      return "The service may have recorded this hypothesis even though this view did not receive a result. Review the current record before retrying; retrying this unchanged draft is protected from creating a duplicate.";
    case "aborted":
      return "This view stopped waiting before it received a result. The hypothesis may have been recorded; retrying this unchanged draft is protected from creating a duplicate.";
    case "unexpected_response":
    case "protocol":
    case "unexpected":
      return "This view could not confirm the result. The hypothesis may have been recorded; review the current record before retrying this unchanged draft.";
  }
}

function ignoredCopy(reason: CommandIgnoredReason): string {
  if (reason === "busy") {
    return "Another contribution is already in progress. This draft remains available.";
  }
  if (reason === "stale") {
    return "This view changed before the submission result could be accepted. Review the current investigation before trying again.";
  }
  return "Hypothesis writing became unavailable before this submission could start. This draft remains available.";
}

function snapshotArtifactLinks(
  selectedEvidence: readonly EvidenceHypothesisEvidence[],
): Array<{ kind: "artifact"; id: string }> {
  const seen = new Set<string>();
  const links: Array<{ kind: "artifact"; id: string }> = [];
  for (const evidence of selectedEvidence) {
    if (evidence.id.length === 0 || seen.has(evidence.id)) continue;
    seen.add(evidence.id);
    links.push({ kind: "artifact", id: evidence.id });
  }
  return links;
}

function snapshotHypothesisLinks(
  selectedEvidence: readonly EvidenceHypothesisEvidence[],
  contributionSources: readonly EvidenceHypothesisContribution[],
  selectedContributionId: string,
): Array<{ kind: "artifact" | "contribution"; id: string }> {
  const links: Array<{ kind: "artifact" | "contribution"; id: string }> = [
    ...snapshotArtifactLinks(selectedEvidence),
  ];
  const contribution = contributionSources.find(({ id }) => (
    id.length > 0 && id === selectedContributionId
  ));
  if (contribution !== undefined) {
    links.push({ kind: "contribution", id: contribution.id });
  }
  return links;
}

function newHypothesisIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}${random}`.slice(0, 128);
}

function fingerprintSubmissionIntent(
  body: string,
  links: readonly { readonly kind: "artifact" | "contribution"; readonly id: string }[],
): string {
  return JSON.stringify([body, links]);
}

/**
 * Presentation-only evidence-linked hypothesis composer. It creates one evidence-linked
 * hypothesis only after an explicit form submission; Runtime owns every write
 * boundary and authoritative result.
 */
interface EvidenceHypothesisComposerScopeProps<TContribution>
  extends Omit<EvidenceHypothesisComposerProps<TContribution>, "scopeKey"> {
  readonly scopeEpoch: number;
  readonly activeScopeEpoch: { readonly current: number };
}

function EvidenceHypothesisComposerScope<TContribution>({
  selectedEvidence,
  contributionSources = [],
  createContribution,
  mutationState,
  onSuccess,
  idempotencyKeyPrefix = "evidence-hypothesis-",
  scopeEpoch,
  activeScopeEpoch,
}: EvidenceHypothesisComposerScopeProps<TContribution>) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const bodyHintId = `${id}-body-hint`;
  const evidenceTitleId = `${id}-evidence-title`;
  const [body, setBody] = useState("");
  const [selectedContributionId, setSelectedContributionId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<SubmissionFeedback | null>(null);
  const [lastSubmittedFingerprint, setLastSubmittedFingerprint] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const submissionIntentRef = useRef<SubmissionIntent | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const artifactLinks = snapshotArtifactLinks(selectedEvidence);
  const selectedContribution = contributionSources.find(({ id }) => (
    id.length > 0 && id === selectedContributionId
  ));
  const links = snapshotHypothesisLinks(
    selectedEvidence,
    contributionSources,
    selectedContributionId,
  );
  const currentLinksRef = useRef(links);
  currentLinksRef.current = links;
  const bodyValueRef = useRef(body);
  bodyValueRef.current = body;
  const anotherContributionRunning = !submitting && mutationState.status === "running";
  const canSubmit = createContribution !== null
    && body.trim().length > 0
    && artifactLinks.length > 0
    && !submitting
    && !anotherContributionRunning;

  useEffect(() => {
    if (selectedContributionId !== "" && selectedContribution === undefined) {
      setSelectedContributionId("");
    }
  }, [selectedContribution, selectedContributionId]);

  if (createContribution === null) {
    return (
      <StrategyPanel
        title="Draft an evidence-linked hypothesis"
        titleId={titleId}
        description={<p>Connect a claim to the evidence that supports examining it.</p>}
      >
        <StrategyStateNotice title="Hypothesis writing unavailable">
          This view cannot record a hypothesis for the current investigation. No writing controls are available.
        </StrategyStateNotice>
      </StrategyPanel>
    );
  }
  const command = createContribution;

  function scopeIsCurrent() {
    return activeScopeEpoch.current === scopeEpoch;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || mutationState.status === "running") return;

    const submittedBody = body;
    const submittedArtifactLinks = snapshotArtifactLinks(selectedEvidence);
    const submittedLinks = snapshotHypothesisLinks(
      selectedEvidence,
      contributionSources,
      selectedContributionId,
    );
    if (submittedBody.trim().length === 0) {
      bodyRef.current?.focus();
      return;
    }
    if (submittedArtifactLinks.length === 0) return;

    const fingerprint = fingerprintSubmissionIntent(submittedBody, submittedLinks);
    const priorIntent = submissionIntentRef.current;
    const submissionIntent = priorIntent?.fingerprint === fingerprint
      ? priorIntent
      : {
          fingerprint,
          idempotencyKey: newHypothesisIdempotencyKey(idempotencyKeyPrefix),
        };
    submissionIntentRef.current = submissionIntent;
    setLastSubmittedFingerprint(fingerprint);

    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let outcome;
    try {
      outcome = await command({
        kind: "hypothesis",
        body: submittedBody,
        hypothesisLinks: submittedLinks,
        idempotencyKey: submissionIntent.idempotencyKey,
      });
    } catch {
      if (scopeIsCurrent()) setFeedback({ status: "failed", error: null });
      return;
    } finally {
      submittingRef.current = false;
      if (scopeIsCurrent()) setSubmitting(false);
    }

    if (!scopeIsCurrent()) return;
    if (outcome.status === "succeeded") {
      if (submissionIntentRef.current?.fingerprint === fingerprint) {
        submissionIntentRef.current = null;
      }
      setLastSubmittedFingerprint(null);
      if (fingerprintSubmissionIntent(bodyValueRef.current, currentLinksRef.current) === fingerprint) {
        setBody("");
        setSelectedContributionId("");
      }
      setFeedback({
        status: "succeeded",
        artifactCount: submittedArtifactLinks.length,
        contributionCited: submittedLinks.some(({ kind }) => kind === "contribution"),
      });
      bodyRef.current?.focus();
      onSuccess?.(outcome.value);
      return;
    }
    if (outcome.status === "ignored") {
      setFeedback({ status: "ignored", reason: outcome.reason });
      return;
    }
    setFeedback({ status: "failed", error: outcome.error });
  }

  function clearDraft() {
    setBody("");
    setSelectedContributionId("");
    setFeedback(null);
    setLastSubmittedFingerprint(null);
    submissionIntentRef.current = null;
    bodyRef.current?.focus();
  }

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const currentFingerprint = fingerprintSubmissionIntent(body, links);
  const failureAppliesToCurrentIntent = lastSubmittedFingerprint === currentFingerprint;
  const reportedFailure = !submitting && failureAppliesToCurrentIntent
    ? mutationState.status === "failed"
      ? mutationState.error
      : feedback?.status === "failed"
        ? feedback.error
        : null
    : null;
  const mutationFailure = reportedFailure === null
    ? null
    : contributionFailureCopy(reportedFailure);
  const mutationOutcomeUnknown = reportedFailure === null
    ? false
    : failureOutcomeIsUnknown(reportedFailure);
  const fallbackFailure = !submitting
    && failureAppliesToCurrentIntent
    && reportedFailure === null
    && feedback?.status === "failed"
    ? "This view could not confirm the result. The hypothesis may have been recorded; retrying this unchanged draft is protected from creating a duplicate."
    : null;

  return (
    <StrategyPanel
      title="Draft an evidence-linked hypothesis"
      titleId={titleId}
      description={<p>Record one testable claim against the current evidence working set.</p>}
      actions={<StrategyBadge>Hypothesis</StrategyBadge>}
      busy={submitting}
    >
      <form aria-labelledby={titleId} aria-busy={submitting} onSubmit={(event) => void submit(event)}>
        <div className="strategy-kit__hypothesis-evidence" aria-labelledby={evidenceTitleId}>
          <div>
            <h4 id={evidenceTitleId}>Evidence cited on submit</h4>
            <p>Artifacts come from the current working set; one current recorded entry may also be cited.</p>
          </div>
          {artifactLinks.length === 0 ? (
            <span role="status">Select at least one evidence artifact before submitting.</span>
          ) : (
            <ul>
              {links.map((link) => (
                <li key={`${link.kind}:${link.id}`}>
                  <span>{(
                    link.kind === "artifact"
                      ? selectedEvidence.find(({ id: evidenceId }) => evidenceId === link.id)?.name
                      : contributionSources.find(({ id: contributionId }) => contributionId === link.id)?.name
                  )?.trim() || link.id}</span>
                  <span className="strategy-kit__breakable">{link.id}</span>
                </li>
              ))}
            </ul>
          )}
          {contributionSources.length > 0 ? (
            <label className="strategy-kit__hypothesis-source">
              <span>Source entry (optional)</span>
              <select
                value={selectedContribution?.id ?? ""}
                disabled={submitting}
                onChange={(event) => {
                  setSelectedContributionId(event.target.value);
                  setFeedback(null);
                }}
              >
                <option value="">No source entry selected</option>
                {contributionSources.filter(({ id }) => id.length > 0).map((source) => (
                  <option key={source.id} value={source.id}>{source.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="strategy-kit__hypothesis-editor">
          <label className="strategy-kit__hypothesis-field" htmlFor={bodyId}>
            <span>Hypothesis</span>
            <textarea
              ref={bodyRef}
              id={bodyId}
              value={body}
              rows={5}
              required
              aria-describedby={bodyHintId}
              onChange={(event) => {
                setBody(event.target.value);
                setFeedback(null);
              }}
              onKeyDown={keyboardSubmit}
            />
          </label>
          <p id={bodyHintId}>
            State a claim that the selected evidence can help test. Press Control+Enter or Command+Enter to submit.
          </p>
          <p>No privacy value is chosen here. The server applies its default when you submit.</p>
          <StrategyActionRow>
            <button type="submit" disabled={!canSubmit}>
              {submitting
                ? "Recording hypothesis…"
                : anotherContributionRunning
                  ? contributionSources.length > 0
                    ? "Wait for other contribution…"
                    : "Recording hypothesis…"
                  : "Record hypothesis"}
            </button>
            <button
              type="button"
              disabled={submitting || (body.length === 0 && selectedContributionId === "")}
              onClick={clearDraft}
            >
              Clear draft
            </button>
          </StrategyActionRow>
        </div>
      </form>

      {submitting ? (
        <StrategyStateNotice busy>Recording the hypothesis once…</StrategyStateNotice>
      ) : anotherContributionRunning ? (
        <StrategyStateNotice busy>
          Another contribution is being recorded. This draft remains editable and can be submitted when it finishes.
        </StrategyStateNotice>
      ) : null}
      {!anotherContributionRunning && mutationFailure !== null ? (
        <StrategyStateNotice
          role="alert"
          tone="danger"
          title={mutationOutcomeUnknown ? "Hypothesis outcome unknown" : "Hypothesis not recorded"}
        >
          {mutationFailure}
        </StrategyStateNotice>
      ) : !anotherContributionRunning && fallbackFailure !== null ? (
        <StrategyStateNotice role="alert" tone="danger" title="Hypothesis outcome unknown">
          {fallbackFailure}
        </StrategyStateNotice>
      ) : !anotherContributionRunning && feedback?.status === "ignored" ? (
        <StrategyStateNotice title="Submission not accepted by this view">
          {ignoredCopy(feedback.reason)}
        </StrategyStateNotice>
      ) : !anotherContributionRunning && feedback?.status === "succeeded" ? (
        <StrategyStateNotice tone="success" title="Hypothesis recorded">
          {feedback.contributionCited
            ? `Recorded with ${feedback.artifactCount} evidence ${feedback.artifactCount === 1 ? "artifact" : "artifacts"} and one source entry.`
            : `Recorded with ${feedback.artifactCount} evidence ${feedback.artifactCount === 1 ? "citation" : "citations"}.`}
        </StrategyStateNotice>
      ) : null}
    </StrategyPanel>
  );
}

export function EvidenceHypothesisComposer<TContribution>({
  scopeKey,
  ...scopeProps
}: EvidenceHypothesisComposerProps<TContribution>) {
  const componentScopeKey = JSON.stringify([
    "evidence-hypothesis-v1",
    scopeKey,
    scopeProps.createContribution !== null,
    scopeProps.idempotencyKeyPrefix ?? "evidence-hypothesis-",
  ]);
  const activeScope = useRef({ key: componentScopeKey, epoch: 0 });
  if (activeScope.current.key !== componentScopeKey) {
    activeScope.current = {
      key: componentScopeKey,
      epoch: activeScope.current.epoch + 1,
    };
  }

  const scopeEpoch = activeScope.current.epoch;
  const activeScopeEpoch = useRef(scopeEpoch);
  activeScopeEpoch.current = scopeEpoch;

  useEffect(() => () => {
    if (activeScopeEpoch.current === scopeEpoch) {
      activeScopeEpoch.current = scopeEpoch + 1;
    }
  }, [scopeEpoch]);

  return (
    <EvidenceHypothesisComposerScope
      key={scopeEpoch}
      {...scopeProps}
      scopeEpoch={scopeEpoch}
      activeScopeEpoch={activeScopeEpoch}
    />
  );
}
