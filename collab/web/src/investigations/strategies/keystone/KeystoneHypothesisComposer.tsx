import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  ArtifactV1,
  CommandIgnoredReason,
  ContributionV1,
  InvestigationRuntimeCommands,
  MutationState,
} from "../../runtime/public.js";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyPanel,
  StrategyStateNotice,
} from "../shared/index.js";

type CreateContributionCommand = NonNullable<
  InvestigationRuntimeCommands["createContribution"]
>;
type RuntimeFailure = Extract<
  MutationState<never>,
  { status: "failed" }
>["error"];

export interface KeystoneHypothesisEvidence {
  readonly id: ArtifactV1["id"];
  readonly name: string;
}

export interface KeystoneHypothesisComposerProps {
  /**
   * Opaque identity + investigation scope supplied by the composition root.
   * It fences presentation state only and never grants write authority.
   */
  readonly scopeKey: string;
  /** The current Keystone working set. Only these artifact IDs may be cited. */
  readonly selectedEvidence: readonly KeystoneHypothesisEvidence[];
  /** A resolved public Runtime command. Null means this presentation cannot write. */
  readonly createContribution: CreateContributionCommand | null;
  readonly mutationState: MutationState<ContributionV1>;
  readonly onSuccess?: (contribution: ContributionV1) => void;
}

type SubmissionFeedback =
  | { readonly status: "succeeded"; readonly citationCount: number }
  | { readonly status: "failed" }
  | { readonly status: "ignored"; readonly reason: CommandIgnoredReason };

function contributionFailureCopy(error: RuntimeFailure): string {
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
      return "The investigation changed before the hypothesis was recorded. Review the current record before trying again.";
    case "lifecycle_refused":
      return "The investigation does not currently allow this contribution.";
    case "unavailable":
    case "server_failure":
    case "network":
      return "The hypothesis could not be recorded right now. Try again when the service is available.";
    case "aborted":
      return "The hypothesis submission was interrupted before this view received a result.";
    case "unexpected_response":
    case "protocol":
    case "unexpected":
      return "The hypothesis could not be processed safely. Review the current investigation before trying again.";
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
  selectedEvidence: readonly KeystoneHypothesisEvidence[],
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

/**
 * Presentation-only Keystone K2 composer. It creates one evidence-linked
 * hypothesis only after an explicit form submission; Runtime owns every write
 * boundary and authoritative result.
 */
interface KeystoneHypothesisComposerScopeProps
  extends Omit<KeystoneHypothesisComposerProps, "scopeKey"> {
  readonly scopeEpoch: number;
  readonly activeScopeEpoch: { readonly current: number };
}

function KeystoneHypothesisComposerScope({
  selectedEvidence,
  createContribution,
  mutationState,
  onSuccess,
  scopeEpoch,
  activeScopeEpoch,
}: KeystoneHypothesisComposerScopeProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const bodyHintId = `${id}-body-hint`;
  const evidenceTitleId = `${id}-evidence-title`;
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<SubmissionFeedback | null>(null);
  const submittingRef = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const links = snapshotArtifactLinks(selectedEvidence);
  const running = submitting || mutationState.status === "running";
  const canSubmit = createContribution !== null
    && body.trim().length > 0
    && links.length > 0
    && !running;

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
    const submittedLinks = snapshotArtifactLinks(selectedEvidence);
    if (submittedBody.trim().length === 0) {
      bodyRef.current?.focus();
      return;
    }
    if (submittedLinks.length === 0) return;

    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);
    let outcome;
    try {
      outcome = await command({
        kind: "hypothesis",
        body: submittedBody,
        hypothesisLinks: submittedLinks,
      });
    } catch {
      if (scopeIsCurrent()) setFeedback({ status: "failed" });
      return;
    } finally {
      submittingRef.current = false;
      if (scopeIsCurrent()) setSubmitting(false);
    }

    if (!scopeIsCurrent()) return;
    if (outcome.status === "succeeded") {
      setBody((current) => current === submittedBody ? "" : current);
      setFeedback({ status: "succeeded", citationCount: submittedLinks.length });
      bodyRef.current?.focus();
      onSuccess?.(outcome.value);
      return;
    }
    if (outcome.status === "ignored") {
      setFeedback({ status: "ignored", reason: outcome.reason });
      return;
    }
    setFeedback({ status: "failed" });
  }

  function clearDraft() {
    setBody("");
    setFeedback(null);
    bodyRef.current?.focus();
  }

  function keyboardSubmit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const mutationFailure = mutationState.status === "failed"
    ? contributionFailureCopy(mutationState.error)
    : null;
  const fallbackFailure = mutationFailure === null && feedback?.status === "failed"
    ? "The hypothesis could not be recorded. This draft remains available."
    : null;

  return (
    <StrategyPanel
      title="Draft an evidence-linked hypothesis"
      titleId={titleId}
      description={<p>Record one testable claim against the current evidence working set.</p>}
      actions={<StrategyBadge>Hypothesis</StrategyBadge>}
      busy={running}
    >
      <form aria-labelledby={titleId} aria-busy={running} onSubmit={(event) => void submit(event)}>
        <div className="keystone-strategy__working-set" aria-labelledby={evidenceTitleId}>
          <div>
            <h4 id={evidenceTitleId}>Evidence cited on submit</h4>
            <p>Only artifacts in the current working set are attached to this hypothesis.</p>
          </div>
          {links.length === 0 ? (
            <span role="status">Select at least one evidence artifact before submitting.</span>
          ) : (
            <ul>
              {links.map((link) => (
                <li key={link.id}>
                  <span>{selectedEvidence.find(({ id: evidenceId }) => evidenceId === link.id)?.name.trim() || link.id}</span>
                  <span className="keystone-strategy__breakable">{link.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="keystone-strategy__workbench-context">
          <label className="keystone-strategy__evidence-search" htmlFor={bodyId}>
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
              {running ? "Recording hypothesis…" : "Record hypothesis"}
            </button>
            <button type="button" disabled={running || body.length === 0} onClick={clearDraft}>
              Clear draft
            </button>
          </StrategyActionRow>
        </div>
      </form>

      {running ? (
        <StrategyStateNotice busy>Recording the hypothesis once…</StrategyStateNotice>
      ) : null}
      {mutationFailure !== null ? (
        <StrategyStateNotice role="alert" tone="danger" title="Hypothesis not recorded">
          {mutationFailure}
        </StrategyStateNotice>
      ) : fallbackFailure !== null ? (
        <StrategyStateNotice role="alert" tone="danger" title="Hypothesis not recorded">
          {fallbackFailure}
        </StrategyStateNotice>
      ) : feedback?.status === "ignored" ? (
        <StrategyStateNotice title="Submission not accepted by this view">
          {ignoredCopy(feedback.reason)}
        </StrategyStateNotice>
      ) : feedback?.status === "succeeded" ? (
        <StrategyStateNotice tone="success" title="Hypothesis recorded">
          Recorded with {feedback.citationCount} evidence {feedback.citationCount === 1 ? "citation" : "citations"}.
        </StrategyStateNotice>
      ) : null}
    </StrategyPanel>
  );
}

export function KeystoneHypothesisComposer({
  scopeKey,
  ...scopeProps
}: KeystoneHypothesisComposerProps) {
  const activeScope = useRef({ key: scopeKey, epoch: 0 });
  if (activeScope.current.key !== scopeKey) {
    activeScope.current = {
      key: scopeKey,
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
    <KeystoneHypothesisComposerScope
      key={scopeEpoch}
      {...scopeProps}
      scopeEpoch={scopeEpoch}
      activeScopeEpoch={activeScopeEpoch}
    />
  );
}
