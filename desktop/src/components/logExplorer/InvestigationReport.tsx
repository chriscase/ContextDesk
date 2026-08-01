/**
 * Investigation report surface (#532).
 *
 * Renders EXCLUSIVELY from the typed `InvestigationReportDto` projection the
 * trusted host assembled — the markdown string is shown only verbatim inside
 * the "Exact export preview" toggle and is never parsed for data. Mutating
 * flows (section editor, export) go through `lib/engine/investigationReports`
 * only; this file never imports `lib/host`.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  logSaveInvestigationReportExport,
  type InvestigationReportAuthoredSectionDto,
  type InvestigationReportDto,
  type InvestigationReportEventReferenceDto,
  type InvestigationReportFindingEntryDto,
  type LogInvestigationReportPreviewDto,
  type ProposedFindingStatusDto,
  type ReportSectionKindDto,
} from "../../lib/engine/investigationReports";
import { formatPolicyBindingStatus } from "../../lib/logExplorer/policyBinding";

/** Body cap mirrors the host's report-section bound (16 KiB, note-sized). */
export const REPORT_SECTION_BODY_MAX_CHARS = 16_384;

export function reportSectionKindLabel(kind: ReportSectionKindDto): string {
  switch (kind) {
    case "executive_summary":
      return "Executive summary";
    case "unresolved_questions":
      return "Unresolved questions";
    case "next_actions":
      return "Next actions";
  }
}

/** Review-card view model for one agent/detector-proposed report section. */
export type ProposedReportSectionView = {
  id: string;
  kind: ReportSectionKindDto;
  body: string;
  status: ProposedFindingStatusDto;
  /** Same-investigation citation counts (evidence + findings + notes). */
  evidenceIdCount: number;
  findingIdCount: number;
  noteIdCount: number;
  provenanceLabel: string;
};

export type ProposedReportSectionAcceptInput = {
  proposalId: string;
  /**
   * Replacement body for Edit-and-accept. Whether the acceptance counts as an
   * edit is host-derived from the durable body actually differing — the
   * renderer makes no claim.
   */
  body?: string;
};

function formatUtc(secs: number): string {
  return new Date(secs * 1000).toISOString().replace(".000Z", "Z");
}

/** Text + symbol status marker — never color-only. */
function referenceStatusBadge(
  status: InvestigationReportEventReferenceDto["status"],
): ReactNode {
  const symbol = status === "verified" ? "✓" : status === "missing" ? "✕" : "≠";
  return (
    <span
      className={`investigation-report__ref-status investigation-report__ref-status--${status}`}
    >
      <span aria-hidden="true">{symbol}</span> [{status}]
    </span>
  );
}

function citationChips(
  entry: InvestigationReportFindingEntryDto,
  busy: boolean,
  onPreviewEvidence?: (evidenceId: string) => void,
): ReactNode {
  if (entry.citations.length === 0) {
    return (
      <span className="investigation-report__meta">No evidence cited</span>
    );
  }
  return (
    <div className="investigation-report__citations">
      {entry.citations.map((citation) => {
        const worst = citation.references.some(
          (reference) => reference.status === "missing",
        )
          ? "missing"
          : citation.references.some(
                (reference) => reference.status === "stale",
              )
            ? "stale"
            : "verified";
        const label = (
          <>
            <span className="investigation-report__citation-title">
              {citation.evidenceTitle}
            </span>
            {referenceStatusBadge(worst)}
          </>
        );
        return onPreviewEvidence ? (
          <button
            key={citation.evidenceId}
            type="button"
            className="log-explorer__citation investigation-report__citation"
            data-testid={`report-citation-${entry.findingId}-${citation.evidenceId}`}
            disabled={busy}
            onClick={() => onPreviewEvidence(citation.evidenceId)}
          >
            {label}
          </button>
        ) : (
          <span
            key={citation.evidenceId}
            className="log-explorer__citation investigation-report__citation"
            data-testid={`report-citation-${entry.findingId}-${citation.evidenceId}`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function AuthoredSection({
  kind,
  section,
  busy,
  onEditSection,
}: {
  kind: ReportSectionKindDto;
  section: InvestigationReportAuthoredSectionDto | null | undefined;
  busy: boolean;
  onEditSection?: (
    kind: ReportSectionKindDto,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const citationCount = section
    ? section.evidenceIds.length +
      section.findingIds.length +
      section.noteIds.length
    : 0;
  const acceptedOrigin = section?.acceptedProposalProvenance;
  const acceptedOriginLabel = acceptedOrigin
    ? [
        `${acceptedOrigin.source} proposal`,
        acceptedOrigin.provider,
        acceptedOrigin.modelId,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <div data-testid={`report-authored-${kind}`}>
      {section ? (
        <>
          <p className="investigation-report__body">{section.body}</p>
          <div className="investigation-report__meta">
            {section.acceptedFromProposalId
              ? `Human controlled · accepted from ${acceptedOriginLabel ?? "an agent proposal"}`
              : "Human authored"}
            {section.acceptedProposalAcceptance?.edited
              ? " · edited during acceptance"
              : ""}
            {` · updated ${formatUtc(section.updatedAt)}`}
            {citationCount > 0
              ? ` · ${citationCount} citation${citationCount === 1 ? "" : "s"}`
              : ""}
          </div>
        </>
      ) : (
        <p
          className="investigation-report__not-authored"
          data-testid={`report-not-authored-${kind}`}
        >
          Not authored.
        </p>
      )}
      {onEditSection ? (
        <button
          type="button"
          className="log-explorer__btn"
          data-testid={`report-edit-section-${kind}`}
          disabled={busy}
          onClick={(event) => onEditSection(kind, event.currentTarget)}
        >
          {section ? "Edit section" : "Write section"}
        </button>
      ) : null}
    </div>
  );
}

function FindingEntry({
  entry,
  busy,
  onPreviewEvidence,
}: {
  entry: InvestigationReportFindingEntryDto;
  busy: boolean;
  onPreviewEvidence?: (evidenceId: string) => void;
}) {
  return (
    <article
      className="investigation-report__finding"
      data-testid={`report-finding-${entry.findingId}`}
    >
      <div className="investigation-report__finding-heading">
        <span className="investigation-report__kicker">
          {entry.kind} · {entry.lifecycle}
        </span>
        <span
          className="investigation-report__policy"
          data-policy-status={entry.policyBindingStatus}
        >
          {formatPolicyBindingStatus(entry.policyBindingStatus)}
        </span>
      </div>
      <div className="investigation-report__finding-title">{entry.title}</div>
      <p className="investigation-report__body">{entry.whyItMatters}</p>
      {citationChips(entry, busy, onPreviewEvidence)}
      <div className="investigation-report__meta">
        Saved view attached: {entry.hasSavedView ? "yes" : "no"}
      </div>
    </article>
  );
}

/**
 * The full report document rendered from the typed projection, in the fixed
 * seven-section order the host renders to markdown. Containers own assembly
 * (lazy) and pass the result; `null` preview with busy=false means the
 * container has not assembled yet.
 */
export function InvestigationReportSurface({
  preview,
  busy,
  error,
  onPreviewEvidence,
  onEditSection,
  onExport,
  exportUnavailableReason = null,
}: {
  preview: LogInvestigationReportPreviewDto | null;
  busy: boolean;
  error: string | null;
  /** Citation chip navigation — rail routes to onPreview, pane to its own preview. */
  onPreviewEvidence?: (evidenceId: string) => void;
  onEditSection?: (
    kind: ReportSectionKindDto,
    trigger: HTMLButtonElement,
  ) => void;
  onExport?: (trigger: HTMLButtonElement) => void;
  exportUnavailableReason?: string | null;
}) {
  const [showMarkdown, setShowMarkdown] = useState(false);

  if (error) {
    return (
      <div className="investigation-report" data-testid="investigation-report">
        <div className="log-explorer__evidence-error" role="alert">
          Report unavailable: {error}
        </div>
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="investigation-report" data-testid="investigation-report">
        <p className="investigation-report__meta" role="status">
          {busy
            ? "Assembling report from the saved investigation record…"
            : "Report not assembled yet."}
        </p>
      </div>
    );
  }

  const report: InvestigationReportDto = preview.report;
  // Export is gated on the retained artifact: a preview whose render could
  // not pass the export boundary still shows, with the exact reason.
  const effectiveExportUnavailable =
    exportUnavailableReason ??
    (preview.exportId == null
      ? (preview.exportUnavailableReason ??
        "the host did not retain this preview")
      : null);
  const observationsAndInferences = report.findings.filter(
    (entry) => entry.kind !== "hypothesis",
  );
  const hypotheses = report.findings.filter(
    (entry) => entry.kind === "hypothesis",
  );
  const window = report.scope.timeWindow ?? null;

  return (
    <div className="investigation-report" data-testid="investigation-report">
      <header className="investigation-report__header">
        <div className="investigation-report__title">{report.title}</div>
        <div className="investigation-report__meta">
          {report.status} · revision {report.sourceRevision} · generated{" "}
          {formatUtc(report.generatedAt)}
        </div>
        <div className="investigation-report__meta">
          {report.scope.corpusIds.length === 1
            ? "Corpus"
            : "Corpora"}{" "}
          {report.scope.corpusIds
            .map((corpusId) => corpusId.slice(0, 8))
            .join(", ")}
        </div>
        <div
          className="investigation-report__meta"
          data-testid="report-current-policy"
        >
          {report.currentPolicy
            ? `Current policy · ${report.currentPolicy.noiseLens ?? "unknown"} lens · suppression rev ${report.currentPolicy.suppressionPolicyRevision} · template rev ${report.currentPolicy.resolvedTemplateRevision}`
            : "Current policy identity unavailable at assembly"}
        </div>
        <div className="investigation-report__header-actions">
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="report-markdown-toggle"
            aria-pressed={showMarkdown}
            onClick={() => setShowMarkdown((value) => !value)}
          >
            {showMarkdown ? "Hide exact export preview" : "Exact export preview"}
          </button>
          {onExport ? (
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--active"
              data-testid="report-export"
              disabled={busy || effectiveExportUnavailable != null}
              title={effectiveExportUnavailable ?? "Export report as Markdown"}
              onClick={(event) => onExport(event.currentTarget)}
            >
              Export…
            </button>
          ) : null}
        </div>
      </header>

      {showMarkdown ? (
        <section
          className="investigation-report__section"
          aria-label="Exact export preview"
        >
          <div className="investigation-report__section-label">
            Exact export preview
          </div>
          <div className="investigation-report__meta">
            Host-rendered Markdown, byte-identical to Export.
          </div>
          <pre
            className="investigation-report__markdown"
            data-testid="report-markdown-preview"
            tabIndex={0}
            aria-label="Exact Markdown export preview"
          >
            {preview.markdown}
          </pre>
        </section>
      ) : null}

      <section
        className="investigation-report__section"
        data-testid="report-section-scope"
      >
        <div className="investigation-report__section-label">
          1 · Incident scope &amp; window
        </div>
        <p className="investigation-report__body">
          {report.scope.evidenceCount} evidence item
          {report.scope.evidenceCount === 1 ? "" : "s"} ·{" "}
          {report.scope.findingCount} finding
          {report.scope.findingCount === 1 ? "" : "s"} ·{" "}
          {report.scope.noteCount} note
          {report.scope.noteCount === 1 ? "" : "s"}
        </p>
        {window ? (
          window.mixedQuality ? (
            // Mixed quality: the bounds mix wall seconds and order positions,
            // so they are storage hints — never fabricated calendar instants
            // (mirrors the host markdown render exactly).
            <p className="investigation-report__body">
              Evidence window: hints {window.minTimestampHint} →{" "}
              {window.maxTimestampHint} · mixed time quality — ordering hints,
              not calendar time
            </p>
          ) : (
            <p className="investigation-report__body">
              Evidence window {formatUtc(window.minTimestampHint)} →{" "}
              {formatUtc(window.maxTimestampHint)}
            </p>
          )
        ) : (
          <p className="investigation-report__not-authored">
            No exact-time evidence window (no durable exact references).
          </p>
        )}
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-executive-summary"
      >
        <div className="investigation-report__section-label">
          2 · Executive summary
        </div>
        <AuthoredSection
          kind="executive_summary"
          section={report.sections.executiveSummary}
          busy={busy}
          onEditSection={onEditSection}
        />
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-findings"
      >
        <div className="investigation-report__section-label">
          3 · Accepted findings
        </div>
        {observationsAndInferences.length === 0 ? (
          <p className="investigation-report__not-authored">
            No accepted observations or inferences.
          </p>
        ) : (
          observationsAndInferences.map((entry) => (
            <FindingEntry
              key={entry.findingId}
              entry={entry}
              busy={busy}
              onPreviewEvidence={onPreviewEvidence}
            />
          ))
        )}
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-timeline"
      >
        <div className="investigation-report__section-label">
          4 · Evidence-backed timeline
        </div>
        <div className="investigation-report__meta">
          Identity-only — event payloads stay in the corpus.
        </div>
        {report.timeline.entries.length === 0 ? (
          <p className="investigation-report__not-authored">
            No timeline entries (no durable exact references).
          </p>
        ) : (
          <ul className="investigation-report__timeline">
            {report.timeline.entries.map((entry) => (
              <li
                key={`${entry.corpusId}:${entry.source}:${entry.seq}:${entry.evidenceId}`}
                className="investigation-report__timeline-entry"
              >
                <span className="investigation-report__timeline-time">
                  {entry.timeQualityHint === "wall"
                    ? formatUtc(entry.timestampHint)
                    : entry.timeQualityHint === "mixed"
                      ? `mixed time quality · seq ${entry.seq}`
                      : `order-only · seq ${entry.seq}`}
                </span>
                <span className="investigation-report__timeline-identity">
                  seq {entry.seq} · {entry.source}
                </span>
                <span className="investigation-report__timeline-evidence">
                  {entry.evidenceTitle}
                </span>
                {referenceStatusBadge(entry.status)}
              </li>
            ))}
          </ul>
        )}
        {report.timeline.entries.some(
          (entry) => entry.timeQualityHint === "wall",
        ) &&
        report.timeline.entries.some(
          (entry) => entry.timeQualityHint !== "wall",
        ) ? (
          <div
            className="investigation-report__meta"
            data-testid="report-timeline-mixed-caveat"
          >
            Entries mix wall-clock and order-only references; cross-quality
            order is by stored hint, not established time.
          </div>
        ) : null}
        {report.timeline.omittedCount > 0 ? (
          <div
            className="investigation-report__meta"
            data-testid="report-timeline-omitted"
          >
            {report.timeline.omittedCount} omitted (bounded render)
          </div>
        ) : null}
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-hypotheses"
      >
        <div className="investigation-report__section-label">
          5 · Hypotheses &amp; alternatives
        </div>
        {hypotheses.length === 0 ? (
          <p className="investigation-report__not-authored">
            No hypotheses recorded.
          </p>
        ) : (
          hypotheses.map((entry) => (
            <FindingEntry
              key={entry.findingId}
              entry={entry}
              busy={busy}
              onPreviewEvidence={onPreviewEvidence}
            />
          ))
        )}
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-unresolved-questions"
      >
        <div className="investigation-report__section-label">
          6 · Unresolved questions
        </div>
        <AuthoredSection
          kind="unresolved_questions"
          section={report.sections.unresolvedQuestions}
          busy={busy}
          onEditSection={onEditSection}
        />
      </section>

      <section
        className="investigation-report__section"
        data-testid="report-section-next-actions"
      >
        <div className="investigation-report__section-label">
          7 · Next actions
        </div>
        <AuthoredSection
          kind="next_actions"
          section={report.sections.nextActions}
          busy={busy}
          onEditSection={onEditSection}
        />
      </section>
    </div>
  );
}

/**
 * Review card for one Proposed report section — Preview / Accept /
 * Edit-and-accept / Dismiss-with-reason. Dismiss collects its required reason
 * in an inline field (the proposed-finding flow still uses window.prompt; a
 * blocking prompt is not mirrorable in the pane, so this family upgrades it).
 */
export function ProposedReportSectionCard({
  item,
  busy,
  onAccept,
  onDismiss,
}: {
  item: ProposedReportSectionView;
  busy: boolean;
  onAccept?: (input: ProposedReportSectionAcceptInput) => void;
  onDismiss?: (proposalId: string, reason: string) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.body);
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const citationSummary = `${item.evidenceIdCount} evidence · ${item.findingIdCount} finding · ${item.noteIdCount} note citations`;

  return (
    <div
      className="log-explorer__evidence-card log-explorer__material-card"
      data-testid={`proposed-report-${item.id}`}
    >
      <div className="log-explorer__evidence-card-heading">
        <div>
          <div className="log-explorer__material-kicker">
            Proposed report section
          </div>
          <div className="log-explorer__evidence-card-title">
            {reportSectionKindLabel(item.kind)}
          </div>
        </div>
        <span className="log-explorer__evidence-status">proposed</span>
      </div>
      <p className="log-explorer__chat-header-meta">
        {citationSummary} · {item.provenanceLabel}
      </p>
      {previewOpen ? (
        <div
          className="log-explorer__finding-view-preview"
          data-testid={`proposed-report-preview-${item.id}`}
          role="status"
        >
          <div className="log-explorer__chat-header-meta">
            Preview only · not accepted · report unchanged
          </div>
          <p className="log-explorer__material-body investigation-report__proposal-body">
            {item.body}
          </p>
          <button
            type="button"
            className="log-explorer__btn"
            onClick={() => setPreviewOpen(false)}
          >
            Dismiss preview
          </button>
        </div>
      ) : null}
      {editing ? (
        <div
          className="log-explorer__finding-view-preview"
          data-testid={`proposed-report-edit-${item.id}`}
        >
          <label className="log-explorer__field">
            <span className="sr-only">Edited section body</span>
            <textarea
              value={editBody}
              maxLength={REPORT_SECTION_BODY_MAX_CHARS}
              rows={5}
              aria-label="Edited report section body"
              data-testid={`proposed-report-edit-body-${item.id}`}
              onChange={(event) => setEditBody(event.target.value)}
            />
          </label>
          <div className="log-explorer__evidence-card-actions">
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--active"
              disabled={busy || !editBody.trim()}
              data-testid={`confirm-edit-accept-report-${item.id}`}
              onClick={() => {
                onAccept?.({
                  proposalId: item.id,
                  body: editBody.trim(),
                });
                setEditing(false);
              }}
            >
              Save edits and accept
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : dismissing ? (
        <div
          className="log-explorer__finding-view-preview"
          data-testid={`proposed-report-dismiss-${item.id}`}
        >
          <label className="log-explorer__field">
            <span className="log-explorer__material-section-label">
              Dismiss reason (required)
            </span>
            <input
              type="text"
              value={dismissReason}
              aria-label="Dismiss reason"
              data-testid={`dismiss-reason-proposed-report-${item.id}`}
              onChange={(event) => setDismissReason(event.target.value)}
            />
          </label>
          <div className="log-explorer__evidence-card-actions">
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--danger"
              disabled={busy || !dismissReason.trim()}
              data-testid={`confirm-dismiss-proposed-report-${item.id}`}
              onClick={() => {
                onDismiss?.(item.id, dismissReason.trim());
                setDismissing(false);
                setDismissReason("");
              }}
            >
              Dismiss proposal
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={busy}
              onClick={() => {
                setDismissing(false);
                setDismissReason("");
              }}
            >
              Keep proposal
            </button>
          </div>
        </div>
      ) : (
        <div className="log-explorer__evidence-card-actions">
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            data-testid={`preview-proposed-report-${item.id}`}
            onClick={() => setPreviewOpen((value) => !value)}
          >
            Preview
          </button>
          <button
            type="button"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={busy}
            data-testid={`accept-proposed-report-${item.id}`}
            onClick={() => onAccept?.({ proposalId: item.id })}
          >
            Accept
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            data-testid={`edit-accept-proposed-report-${item.id}`}
            onClick={() => {
              setEditBody(item.body);
              setEditing(true);
            }}
          >
            Edit and accept
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            data-testid={`dismiss-proposed-report-${item.id}`}
            onClick={() => setDismissing(true)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Create-or-replace editor for one authored report section (SetReportSection).
 * Modal dialog per CreateInvestigationItemDialog: role=dialog + aria-modal,
 * manual Tab wrap, Escape dismiss, triggerRef refocused on dismiss.
 */
export function ReportSectionEditorDialog({
  kind,
  initialBody,
  busy,
  error,
  triggerRef,
  onSave,
  onDismiss,
}: {
  kind: ReportSectionKindDto;
  initialBody: string | null;
  busy: boolean;
  error?: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSave: (body: string) => void;
  onDismiss: () => void;
}) {
  const [body, setBody] = useState(initialBody ?? "");
  const titleId = useId();
  const descriptionId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  const dismiss = () => {
    if (busy) return;
    onDismiss();
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    queueMicrotask(() => bodyRef.current?.focus());
  }, []);

  return (
    <div
      className="log-explorer__dialog-backdrop"
      data-testid="report-section-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          const trimmed = body.trim();
          if (trimmed && !busy) onSave(trimmed);
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        ref={dialogRef}
        className="log-explorer__investigation-item-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
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
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = body.trim();
          if (trimmed && !busy) onSave(trimmed);
        }}
      >
        <header className="log-explorer__investigation-item-dialog-header">
          <div>
            <div id={titleId} className="log-explorer__save-evidence-title">
              {initialBody == null ? "Write" : "Edit"}{" "}
              {reportSectionKindLabel(kind)}
            </div>
            <p
              id={descriptionId}
              className="log-explorer__save-evidence-description"
            >
              One durable section per kind. Saving replaces the current{" "}
              {reportSectionKindLabel(kind).toLowerCase()} at the exact
              revision you loaded; a concurrent change fails closed instead of
              overwriting it.
            </p>
          </div>
          <span className="log-explorer__investigation-human-badge">
            Human authored
          </span>
        </header>

        <label className="log-explorer__save-evidence-field">
          <span>Section body</span>
          <textarea
            ref={bodyRef}
            className="log-explorer__investigation-item-body"
            value={body}
            maxLength={REPORT_SECTION_BODY_MAX_CHARS}
            rows={7}
            disabled={busy}
            data-testid="report-section-body"
            onChange={(event) => setBody(event.target.value)}
          />
        </label>

        {error ? (
          <div className="log-explorer__evidence-error" role="alert">
            Section was not saved: {error}
          </div>
        ) : null}

        <div className="log-explorer__save-evidence-actions">
          <span className="log-explorer__dialog-shortcut">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save
          </span>
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
            disabled={busy || !body.trim()}
            data-testid="report-section-save"
          >
            {busy ? "Saving…" : "Save section"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Export flow (#532): one artifact, no second assembly. The trusted host
 * retained the exact previewed bytes when it assembled this preview; the
 * dialog shows those bytes and the host-owned native Save panel writes them.
 * The renderer never authors export text or a destination, and nothing can
 * drift between what was reviewed and what is saved. The retained artifact's
 * lifetime is owned by the preview (the container releases it when the
 * preview is replaced or closed), so closing this dialog keeps Export
 * available for the same preview.
 */
export function InvestigationReportExportDialog({
  preview,
  triggerRef,
  onDismiss,
}: {
  preview: LogInvestigationReportPreviewDto;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const exportId = preview.exportId;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const dismiss = () => {
    if (busy) return;
    onDismiss();
    queueMicrotask(() => triggerRef.current?.focus());
  };

  async function save() {
    if (!exportId) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await logSaveInvestigationReportExport(exportId);
      if (outcome.status === "cancelled") {
        setResult("Save cancelled. No file was written.");
        return;
      }
      if (outcome.status === "saved_with_warning") {
        setResult(
          `Saved the report, but the host reported a durability warning: ${outcome.warning}`,
        );
        return;
      }
      setResult("Saved the exact previewed Markdown.");
    } catch (error) {
      setResult(`Report was not saved: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="log-explorer__dialog-backdrop"
      data-testid="report-export-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        );
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
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={dialogRef}
        className="log-explorer__investigation-item-dialog investigation-report__export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="log-explorer__investigation-item-dialog-header">
          <div>
            <div id={titleId} className="log-explorer__save-evidence-title">
              Export investigation report
            </div>
            <p
              id={descriptionId}
              className="log-explorer__save-evidence-description"
            >
              Markdown only. The host writes exactly the bytes it retained
              when this preview was assembled — no payloads, no renderer path
              choice, no overwrite.
            </p>
          </div>
        </header>

        <div className="investigation-report__section-label">
          Exact export preview
          {preview.exportBytes != null
            ? ` · ${preview.exportBytes.toLocaleString()} bytes`
            : ""}
        </div>
        <pre
          className="investigation-report__markdown"
          data-testid="report-export-preview"
          tabIndex={0}
          aria-label="Exact Markdown export preview"
        >
          {preview.markdown}
        </pre>
        {exportId == null ? (
          <div className="log-explorer__evidence-error" role="alert">
            Export unavailable:{" "}
            {preview.exportUnavailableReason ??
              "the host did not retain this preview"}
          </div>
        ) : null}

        {result ? (
          <p
            className="investigation-report__meta"
            role="status"
            data-testid="report-export-result"
          >
            {result}
          </p>
        ) : null}

        <div className="log-explorer__save-evidence-actions">
          <button
            ref={closeRef}
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            data-testid="report-export-close"
            onClick={dismiss}
          >
            Close
          </button>
          <button
            type="button"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={busy || exportId == null}
            data-testid="report-export-save"
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save Markdown…"}
          </button>
        </div>
      </div>
    </div>
  );
}
