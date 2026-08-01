/**
 * Investigations pane (#532) — main-window home for the report surface.
 *
 * Thin container: lists corpora, loads the active investigation for the
 * selected corpus, and recomposes the SAME report surface + proposed-section
 * review cards the Log Explorer rail uses. All host functionality flows
 * through `lib/engine/investigationReports` (never `lib/host`).
 * Container-width responsive via ResizeObserver (like the Log Explorer):
 * narrow stacks, wide runs side-by-side, and the report column caps at a
 * readable measure instead of cramming the workspace width.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  investigationHostAvailable,
  listLogCorpora,
  logAcceptProposedReportSection,
  logAssembleInvestigationReport,
  logDismissProposedReportSection,
  logLoadActiveInvestigation,
  logPreviewInvestigationEvidence,
  logReleaseInvestigationReportExport,
  logSetInvestigationReportSection,
  type InvestigationEvidencePreviewDto,
  type LogCorpusSummaryDto,
  type LogInvestigationReportPreviewDto,
  type ReportSectionKindDto,
  type ResolvedInvestigationDocumentDto,
} from "../../lib/engine/investigationReports";
import {
  InvestigationReportExportDialog,
  InvestigationReportSurface,
  ProposedReportSectionCard,
  ReportSectionEditorDialog,
  reportSectionKindLabel,
  type ProposedReportSectionAcceptInput,
  type ProposedReportSectionView,
} from "../logExplorer/InvestigationReport";
import { HelpTip } from "../HelpTip";
import { HELP_INVESTIGATION_REPORT } from "../../lib/helpContent";

type PaneBreakpoint = "narrow" | "normal" | "wide";

function classifyPaneWidth(width: number): PaneBreakpoint {
  if (width < 900) return "narrow";
  if (width >= 1600) return "wide";
  return "normal";
}

function proposedReportSectionViews(
  investigation: ResolvedInvestigationDocumentDto | null,
): ProposedReportSectionView[] {
  return (investigation?.document.proposedReportSections ?? [])
    .filter((section) => section.status === "proposed")
    .map((section) => ({
      id: section.id,
      kind: section.kind,
      body: section.body,
      status: section.status,
      evidenceIdCount: (section.evidenceIds ?? []).length,
      findingIdCount: (section.findingIds ?? []).length,
      noteIdCount: (section.noteIds ?? []).length,
      provenanceLabel:
        section.provenance.source === "model"
          ? "Agent proposed"
          : section.provenance.source === "detector"
            ? "Detector proposed"
            : "Host proposed",
    }));
}

export function InvestigationsPane({
  onOpenHelp,
}: {
  onOpenHelp?: (pageId: string, anchor?: string) => void;
}) {
  const hostAvailable = investigationHostAvailable();
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneBreakpoint, setPaneBreakpoint] =
    useState<PaneBreakpoint>("normal");

  const [corpora, setCorpora] = useState<LogCorpusSummaryDto[]>([]);
  const [corporaState, setCorporaState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [corporaError, setCorporaError] = useState<string | null>(null);
  const [selectedCorpusId, setSelectedCorpusId] = useState<string | null>(null);

  const [investigation, setInvestigation] =
    useState<ResolvedInvestigationDocumentDto | null>(null);
  const [investigationState, setInvestigationState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [investigationError, setInvestigationError] = useState<string | null>(
    null,
  );
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);

  const investigationRequestRef = useRef(0);
  const reportRequestRef = useRef(0);
  const evidencePreviewRequestRef = useRef(0);

  const [reportPreview, setReportPreview] =
    useState<LogInvestigationReportPreviewDto | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  /**
   * The retained export artifact travels with the preview (#532): release the
   * prior artifact whenever the preview is replaced or cleared, and on
   * unmount, so the bounded host store never accumulates stale copies.
   */
  const reportExportIdRef = useRef<string | null>(null);
  const adoptReportPreview = useCallback(
    (next: LogInvestigationReportPreviewDto | null) => {
      const previous = reportExportIdRef.current;
      const nextId = next?.exportId ?? null;
      if (previous && previous !== nextId) {
        void logReleaseInvestigationReportExport(previous).catch(() => {
          // Bounded process-local store; an expired id is already released.
        });
      }
      reportExportIdRef.current = nextId;
      setReportPreview(next);
    },
    [],
  );
  const releaseUnadoptedReportPreview = useCallback(
    (preview: LogInvestigationReportPreviewDto) => {
      const exportId = preview.exportId;
      if (exportId && exportId !== reportExportIdRef.current) {
        void logReleaseInvestigationReportExport(exportId).catch(() => {
          // An evicted id is already released; never retain an ignored result.
        });
      }
    },
    [],
  );
  useEffect(
    () => () => {
      reportRequestRef.current += 1;
      const retained = reportExportIdRef.current;
      reportExportIdRef.current = null;
      if (retained) {
        void logReleaseInvestigationReportExport(retained).catch(() => {
          // Best-effort on teardown; the store is bounded regardless.
        });
      }
    },
    [],
  );

  const [evidencePreview, setEvidencePreview] =
    useState<InvestigationEvidencePreviewDto | null>(null);
  const [evidencePreviewError, setEvidencePreviewError] = useState<
    string | null
  >(null);

  const [sectionEditor, setSectionEditor] = useState<{
    kind: ReportSectionKindDto;
    initialBody: string | null;
    /** Existing citations carried through set (create-or-replace) unchanged. */
    evidenceIds: string[];
    findingIds: string[];
    noteIds: string[];
  } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const sectionTriggerRef = useRef<HTMLButtonElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);

  // Container-width classification (the pane responds to its own width, not
  // the window's, so sidebar collapse and UI scale behave correctly).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (width: number) => setPaneBreakpoint(classifyPaneWidth(width));
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) apply(width);
    });
    observer.observe(el);
    apply(el.clientWidth || window.innerWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCorporaState("loading");
    setCorporaError(null);
    listLogCorpora()
      .then((list) => {
        if (cancelled) return;
        setCorpora(list ?? []);
        setCorporaState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setCorporaState("error");
        setCorporaError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadInvestigation = useCallback((corpusId: string) => {
    const request = ++investigationRequestRef.current;
    setInvestigationState("loading");
    setInvestigationError(null);
    setMutationError(null);
    setStatusLine(null);
    return logLoadActiveInvestigation(corpusId, "active")
      .then((resolved) => {
        if (request !== investigationRequestRef.current) return;
        setInvestigation(resolved);
        setInvestigationState("ready");
      })
      .catch((error) => {
        if (request !== investigationRequestRef.current) return;
        setInvestigationState("error");
        setInvestigationError(String(error));
      });
  }, []);

  const assembleReport = useCallback(
    (corpusId: string, investigationId: string) => {
      const request = ++reportRequestRef.current;
      setReportBusy(true);
      setReportError(null);
      // Pin the assembly to the displayed investigation — never "whatever is
      // active now", which could silently be a different investigation
      // created since this one loaded (#532 hardening).
      return logAssembleInvestigationReport(corpusId, investigationId, "active")
        .then((assembled) => {
          if (request !== reportRequestRef.current) {
            releaseUnadoptedReportPreview(assembled);
            return;
          }
          adoptReportPreview(assembled);
        })
        .catch((error) => {
          if (request !== reportRequestRef.current) return;
          adoptReportPreview(null);
          setReportError(String(error));
        })
        .finally(() => {
          if (request !== reportRequestRef.current) return;
          setReportBusy(false);
        });
    },
    [adoptReportPreview, releaseUnadoptedReportPreview],
  );

  const selectCorpus = (corpusId: string) => {
    setSelectedCorpusId(corpusId);
    investigationRequestRef.current += 1;
    reportRequestRef.current += 1;
    evidencePreviewRequestRef.current += 1;
    setInvestigation(null);
    adoptReportPreview(null);
    setReportError(null);
    setReportBusy(false);
    setEvidencePreview(null);
    setEvidencePreviewError(null);
    setSectionEditor(null);
    setExportOpen(false);
    void loadInvestigation(corpusId);
  };

  // Lazy assembly: only once an investigation is present for the selection.
  // The pane's center IS the report surface, so assembly follows load — but
  // never runs when there is no investigation (nothing to project).
  useEffect(() => {
    if (!selectedCorpusId || investigationState !== "ready" || !investigation) {
      return;
    }
    void assembleReport(selectedCorpusId, investigation.document.id);
  }, [assembleReport, investigation, investigationState, selectedCorpusId]);

  const refreshAfterMutation = (
    _corpusId: string,
    updated: ResolvedInvestigationDocumentDto,
  ) => {
    // Invalidate any in-flight investigation load so a stale pre-mutation
    // snapshot can never overwrite the post-mutation document.
    investigationRequestRef.current += 1;
    reportRequestRef.current += 1;
    adoptReportPreview(null);
    setReportError(null);
    setInvestigation(updated);
  };

  const acceptProposedSection = async (
    input: ProposedReportSectionAcceptInput,
  ) => {
    if (!selectedCorpusId || !investigation) return;
    setMutationBusy(true);
    setMutationError(null);
    setStatusLine(null);
    try {
      const updated = await logAcceptProposedReportSection(
        selectedCorpusId,
        investigation.document.id,
        {
          proposalId: input.proposalId,
          expectedRevision: investigation.document.revision,
          body: input.body ?? null,
        },
      );
      refreshAfterMutation(selectedCorpusId, updated);
      setStatusLine(
        input.body != null
          ? "Accepted proposed report section with edits."
          : "Accepted proposed report section.",
      );
    } catch (error) {
      setMutationError(String(error));
    } finally {
      setMutationBusy(false);
    }
  };

  const dismissProposedSection = async (proposalId: string, reason: string) => {
    if (!selectedCorpusId || !investigation || !reason.trim()) return;
    setMutationBusy(true);
    setMutationError(null);
    setStatusLine(null);
    try {
      const updated = await logDismissProposedReportSection(
        selectedCorpusId,
        investigation.document.id,
        {
          proposalId,
          expectedRevision: investigation.document.revision,
          reason: reason.trim(),
        },
      );
      refreshAfterMutation(selectedCorpusId, updated);
      setStatusLine("Dismissed proposed report section.");
    } catch (error) {
      setMutationError(String(error));
    } finally {
      setMutationBusy(false);
    }
  };

  const saveSection = async (body: string) => {
    if (!selectedCorpusId || !investigation || !sectionEditor) return;
    setMutationBusy(true);
    setMutationError(null);
    setStatusLine(null);
    try {
      const updated = await logSetInvestigationReportSection(
        selectedCorpusId,
        investigation.document.id,
        investigation.document.revision,
        {
          kind: sectionEditor.kind,
          body,
          // set is create-or-replace: resend the existing citations so a
          // body edit never silently drops them.
          evidenceIds: sectionEditor.evidenceIds,
          findingIds: sectionEditor.findingIds,
          noteIds: sectionEditor.noteIds,
        },
      );
      refreshAfterMutation(selectedCorpusId, updated);
      setSectionEditor(null);
      setStatusLine(
        `Saved ${reportSectionKindLabel(sectionEditor.kind).toLowerCase()}.`,
      );
      queueMicrotask(() => sectionTriggerRef.current?.focus());
    } catch (error) {
      setMutationError(String(error));
    } finally {
      setMutationBusy(false);
    }
  };

  const previewEvidence = (evidenceId: string) => {
    if (!selectedCorpusId || !investigation) return;
    const request = ++evidencePreviewRequestRef.current;
    setEvidencePreviewError(null);
    void logPreviewInvestigationEvidence(
      selectedCorpusId,
      investigation.document.id,
      evidenceId,
    )
      .then((preview) => {
        if (request !== evidencePreviewRequestRef.current) return;
        setEvidencePreview(preview);
      })
      .catch((error) => {
        if (request !== evidencePreviewRequestRef.current) return;
        setEvidencePreview(null);
        setEvidencePreviewError(String(error));
      });
  };

  const selectedCorpus =
    corpora.find((corpus) => corpus.id === selectedCorpusId) ?? null;
  const proposedSections = proposedReportSectionViews(investigation);
  const document_ = investigation?.document ?? null;
  const summaryCounts = document_
    ? {
        evidence: document_.evidence.length,
        findings: (document_.findings ?? []).length,
        notes: (document_.notes ?? []).length,
        proposedSections: proposedSections.length,
        authoredSections: (document_.reportSections ?? []).length,
      }
    : null;
  const previewedEvidenceTitle = evidencePreview
    ? (document_?.evidence.find(
        (item) => item.id === evidencePreview.item.id,
      )?.title ?? evidencePreview.item.title)
    : null;

  return (
    <div
      ref={rootRef}
      className="investigations-pane pane--fill"
      data-testid="investigations-pane"
      data-breakpoint={paneBreakpoint}
    >
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">
          Investigations{" "}
          <HelpTip
            label="Investigation reports"
            title="Investigation report"
            content={HELP_INVESTIGATION_REPORT}
            onOpenHelp={onOpenHelp}
          />
        </h2>
        <div className="pane-chrome__meta">
          <span className="muted">
            Accepted-state reports assembled by the trusted host
          </span>
        </div>
      </header>

      {!hostAvailable ? (
        <div className="pane-empty" data-testid="investigations-no-host">
          <p className="muted" role="status">
            Investigation reports require the desktop app. This browser build
            has no trusted host, so corpora and investigations cannot be
            loaded here.
          </p>
        </div>
      ) : corporaState === "loading" ? (
        <p className="muted investigations-pane__note" role="status">
          Loading log corpora…
        </p>
      ) : corporaState === "error" ? (
        <div
          className="investigations-pane__error"
          role="alert"
          data-testid="investigations-corpora-error"
        >
          Could not list log corpora: {corporaError}
        </div>
      ) : corpora.length === 0 ? (
        <div className="pane-empty" data-testid="investigations-no-corpora">
          <p className="muted">
            No log corpora yet. Import logs in the Logs pane first — an
            investigation record grows from evidence you save in its Log
            Explorer.
          </p>
        </div>
      ) : (
        <div className="investigations-pane__split">
          <aside
            className="investigations-pane__corpora"
            aria-label="Log corpora"
          >
            <div className="investigations-pane__rail-label">Corpus</div>
            <ul className="investigations-pane__corpus-list">
              {corpora.map((corpus) => (
                <li key={corpus.id}>
                  <button
                    type="button"
                    className="log-card investigations-pane__corpus"
                    data-active={
                      selectedCorpusId === corpus.id ? "true" : "false"
                    }
                    data-testid={`investigations-corpus-${corpus.id}`}
                    onClick={() => selectCorpus(corpus.id)}
                  >
                    <span className="log-card__name">{corpus.name}</span>
                    <span className="log-card__meta">
                      {corpus.eventCount.toLocaleString()} events
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section
            className="investigations-pane__main"
            aria-label="Investigation report"
          >
            {!selectedCorpusId ? (
              <div className="pane-empty">
                <p className="muted">
                  Select a corpus to load its active investigation.
                </p>
              </div>
            ) : investigationState === "loading" ? (
              <p
                className="muted investigations-pane__note"
                role="status"
                data-testid="investigations-loading"
              >
                Loading investigation…
              </p>
            ) : investigationState === "error" ? (
              <div
                className="investigations-pane__error"
                role="alert"
                data-testid="investigations-load-error"
              >
                Investigation unavailable: {investigationError}
                <button
                  type="button"
                  className="btn btn--ghost"
                  data-testid="investigations-reload"
                  onClick={() => void loadInvestigation(selectedCorpusId)}
                >
                  Reload
                </button>
              </div>
            ) : !investigation ? (
              <div
                className="pane-empty"
                data-testid="investigations-no-investigation"
              >
                <p className="muted">
                  No investigation for {selectedCorpus?.name ?? "this corpus"}{" "}
                  yet. Open its Log Explorer (Logs pane → Open Explorer) and
                  save evidence from selected rows — the durable investigation
                  record starts with the first saved item.
                </p>
              </div>
            ) : (
              <>
                {summaryCounts ? (
                  <div
                    className="investigations-pane__summary"
                    data-testid="investigations-summary"
                  >
                    <span>{investigation.document.title}</span>
                    <span className="muted">
                      {summaryCounts.evidence} evidence ·{" "}
                      {summaryCounts.findings} findings ·{" "}
                      {summaryCounts.notes} notes ·{" "}
                      {summaryCounts.authoredSections} authored sections ·{" "}
                      {summaryCounts.proposedSections} proposed sections ·
                      revision {investigation.document.revision}
                    </span>
                  </div>
                ) : null}

                {mutationError ? (
                  <div
                    className="investigations-pane__error"
                    role="alert"
                    data-testid="investigations-mutation-error"
                  >
                    {mutationError}
                    <button
                      type="button"
                      className="btn btn--ghost"
                      data-testid="investigations-mutation-reload"
                      onClick={() => {
                        void loadInvestigation(selectedCorpusId);
                      }}
                    >
                      Reload investigation
                    </button>
                  </div>
                ) : null}
                {statusLine ? (
                  <p
                    className="muted investigations-pane__note"
                    role="status"
                    data-testid="investigations-status"
                  >
                    {statusLine}
                  </p>
                ) : null}

                <div className="investigations-pane__content">
                  <div className="investigations-pane__report-column">
                    <InvestigationReportSurface
                      preview={reportPreview}
                      busy={reportBusy || mutationBusy}
                      error={reportError}
                      onPreviewEvidence={previewEvidence}
                      onEditSection={(kind, trigger) => {
                        sectionTriggerRef.current = trigger;
                        const existing = (
                          investigation.document.reportSections ?? []
                        ).find((section) => section.kind === kind);
                        setSectionEditor({
                          kind,
                          initialBody: existing?.body ?? null,
                          evidenceIds: existing?.evidenceIds ?? [],
                          findingIds: existing?.findingIds ?? [],
                          noteIds: existing?.noteIds ?? [],
                        });
                      }}
                      onExport={(trigger) => {
                        exportTriggerRef.current = trigger;
                        setExportOpen(true);
                      }}
                    />
                  </div>

                  <aside
                    className="investigations-pane__review"
                    aria-label="Proposed report sections"
                  >
                    <div className="investigations-pane__rail-label">
                      Proposed sections · {proposedSections.length}
                    </div>
                    {proposedSections.length === 0 ? (
                      <p className="muted investigations-pane__note">
                        No proposed report sections waiting for review.
                      </p>
                    ) : (
                      proposedSections.map((item) => (
                        <ProposedReportSectionCard
                          key={item.id}
                          item={item}
                          busy={mutationBusy}
                          onAccept={(input) => void acceptProposedSection(input)}
                          onDismiss={(proposalId, reason) =>
                            void dismissProposedSection(proposalId, reason)
                          }
                        />
                      ))
                    )}

                    {evidencePreviewError ? (
                      <div
                        className="investigations-pane__error"
                        role="alert"
                        data-testid="investigations-evidence-preview-error"
                      >
                        Evidence preview unavailable: {evidencePreviewError}
                      </div>
                    ) : null}
                    {evidencePreview ? (
                      <section
                        className="investigations-pane__evidence-preview"
                        aria-label={`Preview ${previewedEvidenceTitle ?? "evidence"}`}
                        data-testid="investigations-evidence-preview"
                      >
                        <div className="investigations-pane__rail-label">
                          {previewedEvidenceTitle ?? "Evidence"}
                        </div>
                        <p className="muted investigations-pane__note">
                          Authoritative bounded preview · report unchanged
                        </p>
                        <ul className="investigations-pane__evidence-refs">
                          {evidencePreview.references.map((reference) => (
                            <li
                              key={`${reference.eventRef.source}:${reference.eventRef.seq}`}
                            >
                              <span className="investigations-pane__evidence-identity">
                                seq {reference.eventRef.seq} ·{" "}
                                {reference.eventRef.source} · [
                                {reference.status}]
                              </span>
                              {reference.event ? (
                                <span className="investigations-pane__evidence-message">
                                  {reference.event.message}
                                </span>
                              ) : (
                                <span className="muted">
                                  Event unavailable under the current corpus
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => {
                            evidencePreviewRequestRef.current += 1;
                            setEvidencePreview(null);
                          }}
                        >
                          Close preview
                        </button>
                      </section>
                    ) : null}
                  </aside>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {sectionEditor && investigation && selectedCorpusId ? (
        <ReportSectionEditorDialog
          kind={sectionEditor.kind}
          initialBody={sectionEditor.initialBody}
          busy={mutationBusy}
          error={mutationError}
          triggerRef={sectionTriggerRef}
          onSave={(body) => void saveSection(body)}
          onDismiss={() => setSectionEditor(null)}
        />
      ) : null}

      {exportOpen && reportPreview ? (
        <InvestigationReportExportDialog
          preview={reportPreview}
          triggerRef={exportTriggerRef}
          onDismiss={() => setExportOpen(false)}
        />
      ) : null}
    </div>
  );
}
