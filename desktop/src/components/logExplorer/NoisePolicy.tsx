import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  hostLogActivateTemplateSuppression,
  hostLogPreviewTemplateSuppression,
  type NoiseCandidateDto,
  type SuppressionDocumentDto,
  type SuppressionMutationResultDto,
  type SuppressionPreviewDto,
  type SuppressionRuleMutation,
} from "../../lib/host";
import { formatCanonicalUtc } from "../../lib/logExplorer/types";
import { NoiseCandidateReview } from "./NoiseCandidateReview";

type PolicyState = "loading" | "ready" | "error" | "refreshing";

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
}

function trapFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
) {
  if (event.key !== "Tab") return;
  const focusable = focusableElements(root);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function formatCount(value: number | null): string {
  return value == null ? "…" : value.toLocaleString();
}

export function NoisePolicyControl({
  corpusId,
  document: policyDocument,
  hiddenCount,
  state,
  error,
  narrow,
  lensSuspended = false,
  triggerRef,
  onRetry,
  onMutate,
  onSuspendAll,
  onResume,
  onReloadPolicy,
  onCandidateActivated,
}: {
  corpusId: string;
  document: SuppressionDocumentDto | null;
  hiddenCount: number | null;
  state: PolicyState;
  error: string | null;
  narrow: boolean;
  /** When true, queries do not apply enabled rules (rules stay enabled). */
  lensSuspended?: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onRetry: () => void;
  onMutate: (
    ruleId: string,
    mutation: SuppressionRuleMutation,
  ) => Promise<SuppressionMutationResultDto>;
  /** Suspend the Explorer lens without disabling durable rules. */
  onSuspendAll?: () => void;
  /** Resume applying the durable enabled rules. */
  onResume?: () => void;
  /** Reload the trusted policy and return its new revision. */
  onReloadPolicy: () => Promise<number>;
  /** Refresh policy, rows, facets, timeline, and linked context after activation. */
  onCandidateActivated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyRule, setBusyRule] = useState<string | null>(null);
  const [candidateToSuppress, setCandidateToSuppress] =
    useState<NoiseCandidateDto | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const candidateSuppressTriggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const enabledRules =
    policyDocument?.rules.filter((rule) => rule.state === "enabled") ?? [];
  const visibleRules =
    policyDocument?.rules.filter((rule) => rule.state !== "removed") ?? [];

  const dismiss = () => {
    setOpen(false);
    setReviewOpen(false);
    setCandidateToSuppress(null);
    setActionError(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('[data-noise-policy-close="true"]')
        ?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const branch =
        target instanceof Element &&
        target.closest('[data-noise-policy-branch="true"]');
      if (
        target &&
        !branch &&
        !panelRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        dismiss();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    // Detect the outside interaction before a child click can replace the
    // policy contents. A document-level click can otherwise observe the
    // detached Review suggestions button and mistake it for an outside click.
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
    // Trigger focus is stable; dismiss is intentionally local to this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutate = async (ruleId: string, mutation: SuppressionRuleMutation) => {
    setBusyRule(ruleId);
    setActionError(null);
    try {
      await onMutate(ruleId, mutation);
    } catch (mutationError) {
      setActionError(String(mutationError));
    } finally {
      setBusyRule(null);
    }
  };

  const label =
    state === "loading"
      ? "Noise · loading"
      : state === "error"
        ? "Noise · unavailable"
        : lensSuspended && enabledRules.length > 0
          ? `Noise · suspended · ${enabledRules.length} ${
              enabledRules.length === 1 ? "rule" : "rules"
            } · 0 excluded`
          : `Noise · ${enabledRules.length} ${
              enabledRules.length === 1 ? "rule" : "rules"
            } · ${formatCount(hiddenCount)} hidden`;

  return (
    <div className="log-explorer__noise-control">
      <button
        ref={triggerRef}
        type="button"
        className={`log-explorer__btn ${
          enabledRules.length > 0 && !lensSuspended
            ? "log-explorer__btn--active"
            : lensSuspended
              ? "log-explorer__btn--warn"
              : ""
        }`}
        data-testid="noise-policy-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        disabled={state === "loading"}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>
      {open ? (
        <div
          ref={panelRef}
          className={`log-explorer__noise-policy ${
            narrow ? "log-explorer__noise-policy--sheet" : ""
          } ${reviewOpen ? "log-explorer__noise-policy--review" : ""}`}
          data-testid="noise-policy-panel"
          data-mode={narrow ? "sheet" : "popover"}
          role="dialog"
          aria-modal={narrow}
          aria-labelledby={titleId}
          onKeyDown={(event) => trapFocus(event, panelRef.current)}
        >
          <div className="log-explorer__noise-policy-header">
            <div>
              <strong id={titleId}>
                {reviewOpen ? "Noise candidate review" : "Noise policy"}
              </strong>
              <span>
                Revision {policyDocument?.revision ?? "—"} · exact templates
                only
              </span>
            </div>
            <button
              type="button"
              className="log-explorer__btn"
              data-noise-policy-close="true"
              onClick={dismiss}
            >
              Done
            </button>
          </div>
          {reviewOpen && policyDocument ? (
            <NoiseCandidateReview
              corpusId={corpusId}
              currentSuppressionRevision={policyDocument.revision}
              onBack={() => setReviewOpen(false)}
              onSuppress={(candidate, trigger) => {
                candidateSuppressTriggerRef.current = trigger;
                setCandidateToSuppress(candidate);
              }}
            />
          ) : state === "error" ? (
            <div className="log-explorer__noise-policy-error" role="alert">
              <span>Policy unavailable: {error}</span>
              <button
                type="button"
                className="log-explorer__btn"
                onClick={onRetry}
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <p
                className="log-explorer__noise-policy-disclosure"
                data-testid="noise-policy-disclosure"
                role="status"
              >
                {lensSuspended
                  ? `Noise lens is suspended. ${enabledRules.length} enabled ${
                      enabledRules.length === 1 ? "rule remains" : "rules remain"
                    } durable (not disabled). This view excludes 0 events now; the policy would hide ${formatCount(
                      hiddenCount,
                    )} when resumed. Original evidence remains in the corpus.`
                  : `${formatCount(hiddenCount)} of the raw corpus events are hidden from this Explorer view and linked analysis (${enabledRules.length} enabled ${
                      enabledRules.length === 1 ? "rule" : "rules"
                    }). Excluded events are not analyzed. Original evidence remains in the corpus.`}
              </p>
              <div className="log-explorer__noise-policy-review-action">
                <button
                  type="button"
                  className="log-explorer__btn log-explorer__btn--active"
                  disabled={state !== "ready"}
                  onClick={() => setReviewOpen(true)}
                >
                  Review suggestions
                </button>
                <span className="log-explorer__chat-preview">
                  Ranked proposals only; nothing is selected or hidden
                  automatically.
                </span>
              </div>
              {enabledRules.length > 0 && onSuspendAll && onResume ? (
                <div className="log-explorer__noise-policy-lens-actions">
                  {lensSuspended ? (
                    <button
                      type="button"
                      className="log-explorer__btn log-explorer__btn--active"
                      data-testid="noise-lens-resume"
                      aria-label="Resume noise lens and re-apply enabled rules"
                      onClick={() => {
                        onResume();
                      }}
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="log-explorer__btn"
                      data-testid="noise-lens-suspend-all"
                      aria-label="Suspend all noise rules from this view without disabling them"
                      onClick={() => {
                        onSuspendAll();
                      }}
                    >
                      Suspend all
                    </button>
                  )}
                  <span className="log-explorer__chat-preview">
                    Suspend does not disable or delete rules.
                  </span>
                </div>
              ) : null}
              <div className="log-explorer__noise-policy-list">
                {visibleRules.length === 0 ? (
                  <div className="log-explorer__noise-policy-empty">
                    No noise rules. Select an event and inspect it to suppress
                    its exact template.
                  </div>
                ) : (
                  visibleRules.map((rule) => (
                    <article
                      key={rule.id}
                      className="log-explorer__noise-rule"
                      data-state={rule.state}
                    >
                      <div className="log-explorer__noise-rule-heading">
                        <div>
                          <strong>{rule.name}</strong>
                          <span>
                            Template {rule.predicate.templateId} ·{" "}
                            {rule.state === "enabled" ? "Enabled" : "Disabled"}
                          </span>
                        </div>
                        <span className="log-explorer__noise-rule-revision">
                          r{policyDocument?.revision ?? "—"}
                        </span>
                      </div>
                      <p>{rule.rationale}</p>
                      <div className="log-explorer__noise-rule-actions">
                        <button
                          type="button"
                          className="log-explorer__btn"
                          disabled={busyRule === rule.id}
                          onClick={() =>
                            void mutate(
                              rule.id,
                              rule.state === "enabled" ? "disable" : "reenable",
                            )
                          }
                        >
                          {busyRule === rule.id
                            ? "Updating…"
                            : rule.state === "enabled"
                              ? "Disable"
                              : "Re-enable"}
                        </button>
                        <button
                          type="button"
                          className="log-explorer__btn log-explorer__btn--danger"
                          disabled={busyRule === rule.id}
                          onClick={() => void mutate(rule.id, "remove")}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
              {actionError ? (
                <div className="log-explorer__noise-policy-error" role="alert">
                  {actionError}
                </div>
              ) : null}
              <div className="log-explorer__noise-policy-audit">
                <button
                  type="button"
                  className="log-explorer__noise-audit-toggle"
                  aria-expanded={auditOpen}
                  onClick={() => setAuditOpen((current) => !current)}
                >
                  {auditOpen ? "Hide audit" : "Show audit"} ·{" "}
                  {policyDocument?.audit.length ?? 0} entries
                </button>
                {auditOpen ? (
                  <ol>
                    {(policyDocument?.audit ?? [])
                      .slice()
                      .reverse()
                      .slice(0, 30)
                      .map((entry) => (
                        <li key={entry.id}>
                          <span>{entry.action}</span>
                          <span>revision {entry.revision}</span>
                          <time>
                            {new Date(entry.createdAt * 1000).toLocaleString()}
                          </time>
                        </li>
                      ))}
                  </ol>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
      {candidateToSuppress ? (
        <div data-noise-policy-branch="true">
          <SuppressTemplateDialog
            corpusId={corpusId}
            templateId={candidateToSuppress.templateId}
            policyRevision={policyDocument?.revision ?? 0}
            narrow={narrow}
            triggerRef={candidateSuppressTriggerRef}
            onReloadPolicy={onReloadPolicy}
            onActivated={onCandidateActivated}
            onDismiss={() => setCandidateToSuppress(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SuppressTemplateDialog({
  corpusId,
  templateId,
  policyRevision,
  narrow,
  triggerRef,
  onReloadPolicy,
  onActivated,
  onDismiss,
}: {
  corpusId: string;
  templateId: number;
  policyRevision: number;
  narrow: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onReloadPolicy: () => Promise<number>;
  onActivated: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [name, setName] = useState(`Template ${templateId}`);
  const [rationale, setRationale] = useState("");
  const [preview, setPreview] = useState<SuppressionPreviewDto | null>(null);
  const [revision, setRevision] = useState(policyRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const dismiss = () => {
    if (busy) return;
    onDismiss();
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    queueMicrotask(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  }, []);

  const requestPreview = async (expectedRevision = revision) => {
    if (!name.trim() || !rationale.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await hostLogPreviewTemplateSuppression(corpusId, {
        expectedRevision,
        name: name.trim(),
        rationale: rationale.trim(),
        templateId,
      });
      setPreview(next);
      setRevision(next.ruleRevision);
    } catch (previewError) {
      setPreview(null);
      setError(String(previewError));
    } finally {
      setBusy(false);
    }
  };

  const reloadAndPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const nextRevision = await onReloadPolicy();
      setRevision(nextRevision);
      const next = await hostLogPreviewTemplateSuppression(corpusId, {
        expectedRevision: nextRevision,
        name: name.trim(),
        rationale: rationale.trim(),
        templateId,
      });
      setPreview(next);
      setRevision(next.ruleRevision);
    } catch (reloadError) {
      setPreview(null);
      setError(String(reloadError));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await hostLogActivateTemplateSuppression(
        corpusId,
        preview.ruleRevision,
        preview.token,
      );
      await onActivated();
      onDismiss();
      queueMicrotask(() => triggerRef.current?.focus());
    } catch (activationError) {
      setError(String(activationError));
    } finally {
      setBusy(false);
    }
  };

  const percent =
    preview && preview.corpusEventCount > 0
      ? (preview.matchingEventCount / preview.corpusEventCount) * 100
      : 0;

  return (
    <div
      className="log-explorer__dialog-backdrop"
      data-testid="suppress-template-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
        trapFocus(event, dialogRef.current);
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        ref={dialogRef}
        className={`log-explorer__suppress-dialog ${
          narrow ? "log-explorer__suppress-dialog--sheet" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={(event) => {
          event.preventDefault();
          if (preview) void activate();
          else void requestPreview();
        }}
      >
        <div className="log-explorer__suppress-dialog-header">
          <div>
            <strong id={titleId}>Suppress exact template</strong>
            <span id={descriptionId}>
              Template {templateId} · policy revision {revision}
            </span>
          </div>
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            onClick={dismiss}
          >
            Close
          </button>
        </div>
        <p className="log-explorer__suppress-dialog-copy">
          This is a human-approved view policy. It hides only this exact
          template from Explorer and linked analysis; it never deletes raw
          evidence.
        </p>
        <label className="log-explorer__save-evidence-field">
          <span>Rule name</span>
          <input
            ref={nameRef}
            className="log-explorer__search"
            value={name}
            maxLength={160}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label className="log-explorer__save-evidence-field">
          <span>Rationale (required)</span>
          <textarea
            className="log-explorer__search log-explorer__suppress-rationale"
            value={rationale}
            maxLength={1000}
            disabled={busy}
            placeholder="Why is this exact template noise for this investigation?"
            onChange={(event) => {
              setRationale(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        {preview ? (
          <section
            className="log-explorer__suppression-preview"
            aria-label="Suppression preview"
          >
            <div className="log-explorer__suppression-preview-count">
              <strong>{preview.matchingEventCount.toLocaleString()}</strong>
              <span>
                exact matches · {percent.toFixed(percent < 1 ? 2 : 1)}% of raw
                corpus
              </span>
            </div>
            <dl>
              <div>
                <dt>Newly hidden</dt>
                <dd>{preview.incrementalEventCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Sources</dt>
                <dd>{preview.sourceCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Time span</dt>
                <dd>
                  {preview.matchingEventCount > 0
                    ? `${formatCanonicalUtc(
                        preview.timeSpan.from,
                      )} – ${formatCanonicalUtc(preview.timeSpan.to)}`
                    : "No matching events"}
                </dd>
              </div>
            </dl>
            <div className="log-explorer__suppression-levels">
              {preview.levelCounts.map((entry) => (
                <span key={entry.level}>
                  {entry.level} {entry.count.toLocaleString()}
                </span>
              ))}
            </div>
            {preview.representatives.length > 0 ? (
              <div className="log-explorer__suppression-representatives">
                <strong>Redacted representatives</strong>
                {preview.representatives.slice(0, 3).map((representative) => (
                  <article key={representative.seq}>
                    <span>
                      seq {representative.seq} · {representative.source}
                    </span>
                    <code>{representative.redactedExcerpt}</code>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        {error ? (
          <div className="log-explorer__noise-policy-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={busy || !name.trim() || !rationale.trim()}
              onClick={() => void reloadAndPreview()}
            >
              Reload policy and re-preview
            </button>
          </div>
        ) : null}
        <div className="log-explorer__save-evidence-actions">
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            onClick={dismiss}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={busy || !name.trim() || !rationale.trim()}
          >
            {busy
              ? preview
                ? "Applying…"
                : "Previewing…"
              : preview
                ? "Confirm suppression"
                : "Preview impact"}
          </button>
        </div>
      </form>
    </div>
  );
}
