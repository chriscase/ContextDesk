/**
 * Deterministic Logging Quality Assessment presenter.
 * Host DTOs only — no frontend scoring. Fixed improvement hints are template text.
 */
import { useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  assessLoggingQuality,
  exportLoggingQualityAssessment,
  findingIsAggregateOnly,
  loggingQualityHostAvailable,
  loggingQualityActivityEvent,
  planShowInExplorer,
  sanitizeAssessmentErrorMessage,
  assessmentUiStringsArePrivate,
  collectAssessmentDisplayStrings,
  findAssessmentPrivacyLeak,
  type LoggingQualityAssessment,
  type LoggingQualityAssessmentHostDto,
  type LoggingQualityFinding,
  type LoggingQualityRunPhase,
} from "../../lib/engine/loggingQuality";
import type { ActivityEventInput } from "../../lib/activity/types";
import type { LaneConfig } from "../../lib/logExplorer/laneCompose";

export type LoggingQualityExplorerApply = {
  lanes: LaneConfig[];
  note: string | null;
};

type Props = {
  corpusId: string | null;
  open: boolean;
  onDismiss: () => void;
  /** Apply bounded lanes in the current Explorer (1–4). */
  onShowInExplorer?: (plan: LoggingQualityExplorerApply) => void;
  /** Optional Activity emission (metadata only). */
  onActivity?: (event: ActivityEventInput) => void;
};

function gradeLabel(grade: string): string {
  return grade.replace(/_/g, " ");
}

function severityClass(sev: string): string {
  return `lqa-finding--${sev}`;
}

export function LoggingQualityPanel({
  corpusId,
  open,
  onDismiss,
  onShowInExplorer,
  onActivity,
}: Props) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<LoggingQualityRunPhase>("idle");
  const [hostDto, setHostDto] = useState<LoggingQualityAssessmentHostDto | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  const [exportBusy, setExportBusy] = useState(false);
  const runGen = useRef(0);
  const correlationRef = useRef(
    `lqa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const emit = useCallback(
    (event: ActivityEventInput) => {
      onActivity?.(event);
    },
    [onActivity],
  );

  const runAssessment = useCallback(async () => {
    if (!corpusId?.trim()) {
      setError("No corpus selected. Import or open a log corpus first.");
      setPhase("failed");
      return;
    }
    if (!loggingQualityHostAvailable()) {
      setError("Logging quality assessment requires the desktop host.");
      setPhase("failed");
      return;
    }
    const gen = ++runGen.current;
    correlationRef.current = `lqa-${Date.now().toString(36)}`;
    setPhase("running");
    setError(null);
    setStatusMsg("Running deterministic assessment…");
    setHostDto(null);
    emit(
      loggingQualityActivityEvent({
        corpusId,
        correlationId: correlationRef.current,
        phase: "started",
      }),
    );
    try {
      const dto = await assessLoggingQuality(corpusId);
      if (gen !== runGen.current) return;
      const strings = collectAssessmentDisplayStrings(dto.assessment);
      if (!assessmentUiStringsArePrivate(strings)) {
        const leak = strings
          .map(findAssessmentPrivacyLeak)
          .find((x) => x != null);
        setError(
          `Assessment refused: privacy scan failed (${leak ?? "leak"}). Report not shown.`,
        );
        setPhase("failed");
        emit(
          loggingQualityActivityEvent({
            corpusId,
            correlationId: correlationRef.current,
            phase: "failed",
            safeDetail: "privacy_scan_failed",
          }),
        );
        return;
      }
      for (const portable of Object.values(dto.sourceKeyMap)) {
        if (findAssessmentPrivacyLeak(portable) != null || portable.startsWith("/")) {
          setError(
            "Assessment refused: source map contained an unsafe path identity.",
          );
          setPhase("failed");
          emit(
            loggingQualityActivityEvent({
              corpusId,
              correlationId: correlationRef.current,
              phase: "failed",
              safeDetail: "unsafe_source_map",
            }),
          );
          return;
        }
      }
      setHostDto(dto);
      setPhase("ready");
      setStatusMsg(
        `Deterministic assessment ready · score ${dto.assessment.summary.overallScore} (${dto.assessment.summary.grade})`,
      );
      setSelectedFindingId(dto.assessment.findings[0]?.id ?? null);
      emit(
        loggingQualityActivityEvent({
          corpusId,
          correlationId: correlationRef.current,
          phase: "facts_gathered",
          findingCount: dto.assessment.findings.length,
          overallScore: dto.assessment.summary.overallScore,
        }),
      );
      emit(
        loggingQualityActivityEvent({
          corpusId,
          correlationId: correlationRef.current,
          phase: "completed",
          findingCount: dto.assessment.findings.length,
          overallScore: dto.assessment.summary.overallScore,
        }),
      );
    } catch (e) {
      if (gen !== runGen.current) return;
      const safe = sanitizeAssessmentErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
      setError(safe);
      setPhase("failed");
      setStatusMsg(null);
      emit(
        loggingQualityActivityEvent({
          corpusId,
          correlationId: correlationRef.current,
          phase: "failed",
          safeDetail: safe,
        }),
      );
    }
  }, [corpusId, emit]);

  const cancelRun = useCallback(() => {
    runGen.current += 1;
    if (phase === "running") {
      setPhase("cancelled");
      setStatusMsg("Assessment cancelled.");
      if (corpusId) {
        emit(
          loggingQualityActivityEvent({
            corpusId,
            correlationId: correlationRef.current,
            phase: "cancelled",
          }),
        );
      }
    } else {
      onDismiss();
    }
  }, [phase, corpusId, emit, onDismiss]);

  const exportReport = useCallback(
    async (format: "json" | "markdown") => {
      if (!corpusId?.trim() || !hostDto) return;
      setExportBusy(true);
      setStatusMsg(
        format === "json"
          ? "Exporting JSON… (file not written until host confirms)"
          : "Exporting Markdown… (file not written until host confirms)",
      );
      setPhase("exporting");
      try {
        const result = await exportLoggingQualityAssessment(corpusId, format);
        if (result.status === "cancelled") {
          setStatusMsg("Export cancelled — no file written.");
          setPhase("ready");
          emit(
            loggingQualityActivityEvent({
              corpusId,
              correlationId: correlationRef.current,
              phase: "export_cancelled",
            }),
          );
        } else if (result.status === "written") {
          setStatusMsg(
            `Exported ${result.format} as ${result.displayName} (atomic publish confirmed).`,
          );
          setPhase("ready");
          emit(
            loggingQualityActivityEvent({
              corpusId,
              correlationId: correlationRef.current,
              phase: "exported",
              exportFormat: result.format,
            }),
          );
        } else {
          setError(sanitizeAssessmentErrorMessage(result.reason));
          setStatusMsg("Export failed — no file claimed.");
          setPhase("ready");
          emit(
            loggingQualityActivityEvent({
              corpusId,
              correlationId: correlationRef.current,
              phase: "failed",
              safeDetail: "export_failed",
            }),
          );
        }
      } catch (e) {
        setError(
          sanitizeAssessmentErrorMessage(
            e instanceof Error ? e.message : String(e),
          ),
        );
        setStatusMsg("Export failed — no file claimed.");
        setPhase("ready");
      } finally {
        setExportBusy(false);
      }
    },
    [corpusId, hostDto, emit],
  );

  const showFinding = useCallback(
    (finding: LoggingQualityFinding) => {
      if (!hostDto) return;
      const plan = planShowInExplorer(finding, hostDto.sourceKeyMap);
      if (plan.kind === "fail_closed") {
        setStatusMsg(plan.reason);
        return;
      }
      if (plan.kind === "aggregate_only") {
        setStatusMsg(plan.reason);
        // Still open Explorer with a single all-sources lane when caller wants.
        onShowInExplorer?.({
          lanes: [{ id: "lane-0", label: "All sources", sources: [] }],
          note: plan.reason,
        });
        return;
      }
      onShowInExplorer?.({
        lanes: plan.lanes,
        note: plan.note,
      });
      setStatusMsg(
        plan.note ??
          `Applied ${plan.lanes.length} evidence lane${plan.lanes.length === 1 ? "" : "s"} in Explorer.`,
      );
    },
    [hostDto, onShowInExplorer],
  );

  if (!open) return null;

  const assessment = hostDto?.assessment ?? null;
  const selected =
    assessment?.findings.find((f) => f.id === selectedFindingId) ??
    assessment?.findings[0] ??
    null;
  const noCorpus = !corpusId?.trim();

  const body = (
    <div
      className="lqa-backdrop"
      data-testid="lqa-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="lqa-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="lqa-panel"
      >
        <header className="lqa-panel__header">
          <div>
            <span className="eyebrow">Deterministic assessment</span>
            <h2 id={titleId}>Logging quality</h2>
            <p className="lqa-panel__lead">
              Scores and findings come only from durable corpus facts. Improvement
              hints are fixed templates per finding code — not model-generated
              advice.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost"
            onClick={onDismiss}
          >
            Close
          </button>
        </header>

        <div className="lqa-panel__actions" role="group" aria-label="Assessment actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="lqa-run"
            disabled={noCorpus || phase === "running" || exportBusy}
            title={
              noCorpus
                ? "Import or open a log corpus first"
                : "Run deterministic logging quality assessment"
            }
            onClick={() => void runAssessment()}
          >
            {phase === "running" ? "Assessing…" : "Assess logging quality"}
          </button>
          {phase === "running" ? (
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="lqa-cancel"
              onClick={cancelRun}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="lqa-export-json"
            disabled={!assessment || exportBusy || phase === "running"}
            onClick={() => void exportReport("json")}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="lqa-export-md"
            disabled={!assessment || exportBusy || phase === "running"}
            onClick={() => void exportReport("markdown")}
          >
            Export Markdown
          </button>
        </div>

        {noCorpus ? (
          <p className="lqa-panel__empty" role="status" data-testid="lqa-no-corpus">
            No corpus selected. Import logs or open a corpus, then run the
            assessment.
          </p>
        ) : null}

        {phase === "running" ? (
          <p className="lqa-panel__status" role="status" data-testid="lqa-progress">
            Running deterministic assessment… one progress path.
          </p>
        ) : null}

        {statusMsg ? (
          <p className="lqa-panel__status" role="status" data-testid="lqa-status">
            {statusMsg}
          </p>
        ) : null}

        {error ? (
          <p className="lqa-panel__error" role="alert" data-testid="lqa-error">
            {error}
          </p>
        ) : null}

        {assessment ? (
          <AssessmentBody
            assessment={assessment}
            selected={selected}
            onSelectFinding={setSelectedFindingId}
            onShowFinding={showFinding}
          />
        ) : null}
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

function AssessmentBody({
  assessment,
  selected,
  onSelectFinding,
  onShowFinding,
}: {
  assessment: LoggingQualityAssessment;
  selected: LoggingQualityFinding | null;
  onSelectFinding: (id: string) => void;
  onShowFinding: (f: LoggingQualityFinding) => void;
}) {
  const sel = assessment.metrics.selection;
  return (
    <div className="lqa-body" data-testid="lqa-body">
      <section className="lqa-summary" data-testid="lqa-summary">
        <div className="lqa-summary__score">
          <span className="lqa-summary__number">
            {assessment.summary.overallScore}
          </span>
          <span className="lqa-summary__grade">
            {gradeLabel(assessment.summary.grade)}
          </span>
        </div>
        <p className="lqa-summary__headline">{assessment.summary.headline}</p>
        <p className="lqa-summary__meta">
          {assessment.corpus.eventCount.toLocaleString()} events ·{" "}
          {assessment.corpus.templateCount.toLocaleString()} templates · time{" "}
          {assessment.metrics.timeQuality.replace(/_/g, " ")} · confidence{" "}
          {assessment.confidence.level}
        </p>
      </section>

      <section className="lqa-dimensions" aria-label="Dimension scores">
        {assessment.summary.dimensions.map((d) => (
          <article key={d.id} className="lqa-dim-card">
            <header>
              <strong>{d.label}</strong>
              <span>{d.score}</span>
            </header>
            <p>{d.measuredFact}</p>
          </article>
        ))}
      </section>

      <section className="lqa-selection" aria-label="Selection coverage">
        <h3>Selection coverage</h3>
        <p className="field__hint">{sel.availabilityNote}</p>
        <ul className="lqa-selection__buckets">
          <li data-testid="lqa-bucket-imported">
            Imported (selected): <strong>{sel.selectedImported}</strong>
          </li>
          <li data-testid="lqa-bucket-ignored">
            Ignored: <strong>{sel.ignored}</strong>
          </li>
          <li data-testid="lqa-bucket-unsupported">
            Unsupported: <strong>{sel.unsupported}</strong>
          </li>
          <li data-testid="lqa-bucket-excluded">
            Excluded (policy): <strong>{sel.excludedPolicy}</strong>
          </li>
          <li data-testid="lqa-bucket-failed">
            Failed reads: <strong>{sel.failed}</strong>
          </li>
          <li data-testid="lqa-bucket-partial">
            Partial import flag:{" "}
            <strong>{sel.partial ? "yes" : "no"}</strong>
          </li>
        </ul>
        <p className="field__hint">
          These buckets are distinct. Ignored or unsupported content is not the
          same as a partial import failure.
        </p>
      </section>

      <section className="lqa-honesty" aria-label="Honesty notes">
        <h3>Honesty</h3>
        <p>{assessment.metrics.storedLevel.honestyNote}</p>
        <p>{assessment.metrics.templates.proposalNote}</p>
        <p>{assessment.metrics.traceId.availabilityNote}</p>
      </section>

      <div className="lqa-findings-layout">
        <section className="lqa-findings" aria-label="Findings">
          <h3>Findings ({assessment.findings.length})</h3>
          <ul className="lqa-findings__list">
            {assessment.findings.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={`lqa-findings__item ${severityClass(f.severity)}${
                    selected?.id === f.id ? " is-selected" : ""
                  }`}
                  data-testid={`lqa-finding-${f.id}`}
                  onClick={() => onSelectFinding(f.id)}
                >
                  <span className="lqa-findings__sev">{f.severity}</span>
                  <span className="lqa-findings__title">{f.title}</span>
                  <span className="lqa-findings__id">{f.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {selected ? (
          <section
            className="lqa-finding-detail"
            data-testid="lqa-finding-detail"
            aria-label="Finding detail"
          >
            <h3>{selected.title}</h3>
            <p className="lqa-finding-detail__code">
              <code>{selected.id}</code> · priority {selected.priority} ·{" "}
              {selected.category.replace(/_/g, " ")} · confidence{" "}
              {selected.confidence}
            </p>
            <h4>Measured fact</h4>
            <p>{selected.measuredFact}</p>
            <h4>Finding</h4>
            <p>{selected.finding}</p>
            <h4>Improvement hint (fixed template)</h4>
            <p data-testid="lqa-hint">{selected.improvementHint.change}</p>
            <h4>Acceptance criteria</h4>
            <ul>
              {selected.improvementHint.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <h4>Evidence</h4>
            {findingIsAggregateOnly(selected.evidence) ? (
              <p className="field__hint" data-testid="lqa-aggregate-only">
                Aggregate-only evidence — no event citations were fabricated.
              </p>
            ) : null}
            <ul className="lqa-evidence">
              {selected.evidence.map((e) => (
                <li key={`${e.kind}:${e.key}`}>
                  <span className="lqa-evidence__kind">{e.kind}</span> {e.label}
                  {e.value != null ? ` · ${e.value}` : ""}
                </li>
              ))}
            </ul>
            <h4>Limitations</h4>
            <ul>
              {selected.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="lqa-show-explorer"
              onClick={() => onShowFinding(selected)}
            >
              Show in Explorer
            </button>
          </section>
        ) : null}
      </div>

      <section className="lqa-limitations" aria-label="Assessment limitations">
        <h3>Limitations</h3>
        <ul>
          {assessment.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <h4>Non-claims</h4>
        <ul>
          {assessment.confidence.nonClaims.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Toolbar control: honest disabled state when no corpus.
 */
export function LoggingQualityToolbarButton({
  corpusId,
  onOpen,
  disabledReason,
}: {
  corpusId: string | null;
  onOpen: () => void;
  disabledReason?: string | null;
}) {
  const disabled = !corpusId?.trim();
  return (
    <button
      type="button"
      className="log-explorer__btn"
      data-testid="lqa-open"
      disabled={disabled}
      title={
        disabled
          ? disabledReason ?? "Import or open a log corpus first"
          : "Assess logging quality (deterministic)"
      }
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onOpen();
      }}
    >
      Assess quality
    </button>
  );
}
