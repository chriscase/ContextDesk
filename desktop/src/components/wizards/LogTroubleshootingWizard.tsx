/**
 * Flagship log troubleshooting session wizard (#446).
 */

import { useCallback, useEffect, useState } from "react";
import {
  hostGetLogCorpus,
  hostImportLogCorpusPackagePath,
  hostIngestLogPath,
  hostListenProcessProgress,
  hostSessionContextImportPath,
  hostSetActiveLogCorpus,
  type LogIngestReportDto,
  type ProcessProgressDto as HostProcessProgressDto,
} from "../../lib/host";
import { openDirectoryDialog, openFileDialog } from "../../lib/dialogs";
import { operatorImportCommandFailure } from "../../lib/importOutcome";
import {
  formatBytes,
  formatEventsPerTemplate,
  levelEntries,
  statsBlurb,
} from "../../lib/logStats";
import {
  HELP_PHASE_TIMINGS,
  HELP_TEMPLATE_GROUPING,
} from "../../lib/helpContent";
import { HelpTip } from "../HelpTip";
import { LogImportConfidence } from "../panes/LogImportConfidence";
import { ProcessProgressPanel } from "./ProcessProgressPanel";
import {
  buildLogTriageStarterPrompt,
  LOG_TROUBLESHOOTING_WIZARD,
} from "./registry";
import { SessionWizardShell } from "./SessionWizardShell";
import type { ProcessProgressDto, WizardOutcome } from "./types";

export type LogMode = "corpus" | "session_context" | "both";
/** Raw dump ingest vs portable analysis package (.cdlog.zip). */
export type SourceKind = "raw" | "package";

function sessionPackFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/max_files|max_bytes|session context max|chat[- ]pack.*limit/i.test(message)) {
    return "The session chat pack exceeded its 200-file or 50 MiB safety limit. Use the analysis corpus for the complete log set.";
  }
  if (/director(y|ies)|is a directory|not a file/i.test(message)) {
    return "A directory cannot be attached as one session chat-pack file. The analysis corpus supports directories; attach a small ZIP or selected files to chat instead.";
  }
  return "The bounded session chat pack could not be attached. The analysis corpus is still available; attach a small ZIP or selected files separately if needed.";
}

type Props = {
  sessionId: string;
  onComplete: (outcome: WizardOutcome) => void;
  onCancel: () => void;
  helpAvailable?: boolean;
  onLearnMore?: (helpPageId: string) => void;
};

export function LogTroubleshootingWizard({
  sessionId,
  onComplete,
  onCancel,
  helpAvailable,
  onLearnMore,
}: Props) {
  const wizard = LOG_TROUBLESHOOTING_WIZARD;
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("raw");
  const [mode, setMode] = useState<LogMode>("corpus");
  const [corpusName, setCorpusName] = useState("incident");
  const [softWriteAccepted, setSoftWriteAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProcessProgressDto | null>(null);

  const toWizardProgress = (p: HostProcessProgressDto): ProcessProgressDto => ({
    kind: p.kind,
    phase: p.phase as ProcessProgressDto["phase"],
    message: p.message,
    fraction: p.fraction,
    lines_processed: p.lines_processed,
    files_processed: p.files_processed,
    bytes_processed: p.bytes_processed,
    templates: p.templates,
    cancellable: p.cancellable,
    elapsed_ms: p.elapsed_ms ?? null,
    phase_elapsed_ms: p.phase_elapsed_ms ?? null,
  });
  const [corpusId, setCorpusId] = useState<string | null>(null);
  const [ingestReport, setIngestReport] = useState<LogIngestReportDto | null>(
    null,
  );
  const [runDone, setRunDone] = useState(false);
  const [sessionPackNote, setSessionPackNote] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void hostListenProcessProgress((p) => setProgress(toWizardProgress(p))).then(
      (fn) => {
        unlisten = fn;
      },
    );
    return () => {
      unlisten?.();
    };
  }, []);

  const pickDir = async () => {
    const p = await openDirectoryDialog("Choose log directory");
    if (p) {
      setSourceKind("raw");
      setPath(p);
    }
  };

  const pickFile = async () => {
    const p = await openFileDialog("Choose log file", [
      { name: "Logs", extensions: ["log", "txt", "json", "jsonl", "zip"] },
    ]);
    if (p) {
      setSourceKind("raw");
      setPath(p);
    }
  };

  const pickPackage = async () => {
    const p = await openFileDialog("Import log corpus package", [
      { name: "ContextDesk package", extensions: ["zip", "cdlog"] },
    ]);
    if (p) {
      setSourceKind("package");
      setPath(p);
      // Package already is a finished analysis corpus.
      setMode("corpus");
    }
  };

  const runImport = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    setRunDone(false);
    setSessionPackNote(null);
    try {
      let cid: string | null = null;

      if (sourceKind === "package") {
        // SoftWrite portable package → new local corpus (versioned import).
        const imp = await hostImportLogCorpusPackagePath(path);
        cid = imp.corpusId;
        setCorpusId(cid);
        try {
          await hostSetActiveLogCorpus(cid);
        } catch {
          /* non-fatal */
        }
        // Surface persisted stats from the imported package for the hero UI.
        try {
          const summary = await hostGetLogCorpus(cid);
          if (summary?.stats) {
            setIngestReport({
              corpusId: cid,
              lines: summary.stats.lines,
              templates: summary.stats.templates,
              reductionRatio: summary.stats.reductionRatio,
              embedded: summary.stats.embedded,
              files: summary.stats.files,
              discoveredFiles: summary.stats.discoveredFiles,
              excludedFiles: summary.stats.excludedFiles,
              failedFiles: summary.stats.failedFiles,
              ignoredFiles: summary.stats.ignoredFiles,
              exclusionCounts: summary.stats.exclusionCounts ?? {},
              exclusionExamples: summary.stats.exclusionExamples ?? [],
              partial: summary.stats.partial,
              sourceBytes: summary.stats.sourceBytes,
              corpusBytes: summary.stats.corpusBytes,
              levelCounts: summary.stats.levelCounts ?? {},
              tsMin: summary.stats.tsMin,
              tsMax: summary.stats.tsMax,
              formatCounts: summary.stats.formatCounts ?? {},
              topTemplates: summary.topTemplates ?? [],
              embedding: summary.embedding ?? null,
            });
          } else {
            setIngestReport(null);
          }
        } catch {
          setIngestReport(null);
        }
      } else {
        if (mode === "corpus" || mode === "both") {
          // Host extract-and-ingest handles .zip paths (binary zip is not a log file).
          const report = await hostIngestLogPath(
            path,
            corpusName.trim() || "incident",
          );
          cid = report.corpusId;
          setCorpusId(cid);
          setIngestReport(report);
          try {
            await hostSetActiveLogCorpus(cid);
          } catch {
            // Non-fatal: seed prompt still carries corpus id.
          }
        }
        if (mode === "session_context" || mode === "both") {
          // Host path import extracts .zip into session context.
          try {
            await hostSessionContextImportPath(sessionId, path);
          } catch (error) {
            const safeMessage = sessionPackFailureMessage(error);
            if (mode === "both" && cid) {
              setSessionPackNote(
                `Analysis corpus ready. Chat pack skipped: ${safeMessage}`,
              );
            } else {
              throw new Error(safeMessage, { cause: error });
            }
          }
        }
      }
      setRunDone(true);
    } catch (e) {
      setError(operatorImportCommandFailure(e).message);
    } finally {
      setBusy(false);
    }
  }, [corpusName, mode, path, sessionId, sourceKind]);

  const onContinue = async () => {
    setError(null);
    const step = wizard.steps[stepIndex];
    if (!step) return;

    if (step.id === "source") {
      if (!path.trim()) {
        setError("Choose a log file or directory first.");
        return;
      }
      setStepIndex((i) => i + 1);
      return;
    }
    if (step.id === "confirm") {
      if (!softWriteAccepted) {
        setError("Confirm SoftWrite to continue (creates a disposable corpus and/or session files).");
        return;
      }
      setStepIndex((i) => i + 1);
      // Auto-start run on next step
      window.setTimeout(() => {
        void runImport();
      }, 50);
      return;
    }
    if (step.id === "run") {
      if (!runDone && !busy) {
        await runImport();
        return;
      }
      if (!runDone) return;
      setStepIndex((i) => i + 1);
      return;
    }
    if (step.id === "ready") {
      const seed = buildLogTriageStarterPrompt({
        corpusId,
        sessionContext: mode === "session_context" || mode === "both",
        statsLine: ingestReport ? statsBlurb(ingestReport) : null,
      });
      onComplete({
        wizardId: wizard.id,
        composerSeed: seed,
        skillPinId: wizard.skillPinId ?? "log-triage",
        corpusId,
        sessionId,
        openPane: "chat",
        helpPageId: wizard.helpPageId,
      });
      return;
    }
    // welcome, mode, etc.
    if (stepIndex >= wizard.steps.length - 1) {
      const seed = buildLogTriageStarterPrompt({
        corpusId,
        sessionContext: mode === "session_context" || mode === "both",
        statsLine: ingestReport ? statsBlurb(ingestReport) : null,
      });
      onComplete({
        wizardId: wizard.id,
        composerSeed: seed,
        skillPinId: wizard.skillPinId ?? "log-triage",
        corpusId,
        sessionId,
        openPane: "chat",
      });
      return;
    }
    setStepIndex((i) => i + 1);
  };

  const step = wizard.steps[stepIndex];
  const basename = path
    ? path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path
    : "";

  return (
    <SessionWizardShell
      wizard={wizard}
      stepIndex={stepIndex}
      busy={busy}
      error={error}
      continueDisabled={
        (step?.id === "source" && !path.trim()) ||
        (step?.id === "confirm" && !softWriteAccepted) ||
        (step?.id === "run" && busy)
      }
      continueLabel={
        step?.id === "run" && !runDone
          ? busy
            ? "Importing…"
            : "Start import"
          : step?.id === "ready"
            ? "Open chat"
            : "Continue"
      }
      onBack={() => {
        if (busy) return;
        setStepIndex((i) => Math.max(0, i - 1));
      }}
      onSkip={() => setStepIndex((i) => Math.min(i + 1, wizard.steps.length - 1))}
      onContinue={() => void onContinue()}
      onCancel={onCancel}
      helpAvailable={helpAvailable}
      onLearnMore={onLearnMore}
    >
      {step?.id === "welcome" ? (
        <div className="wizard-copy">
          <p>
            This optional guide walks you through putting logs into ContextDesk for
            troubleshooting: parse → template → store → analysis tools, or attach
            files to this chat as session context.
          </p>
          <p className="muted">
            You can cancel anytime. Blank <strong>New chat</strong> remains available
            without this wizard.
          </p>
        </div>
      ) : null}

      {step?.id === "source" ? (
        <div className="wizard-copy">
          <p>
            Select a log dump to ingest, or import a portable analysis package
            from another ContextDesk user (basename only is shown in progress).
          </p>
          <div className="wizard-actions-row">
            <button type="button" onClick={() => void pickDir()}>
              Choose directory…
            </button>
            <button type="button" onClick={() => void pickFile()}>
              Choose file…
            </button>
            <button
              type="button"
              data-testid="wizard-import-package"
              onClick={() => void pickPackage()}
            >
              Import package…
            </button>
          </div>
          {path ? (
            <p className="wizard-path">
              Selected: <code>{basename}</code>
              {sourceKind === "package" ? (
                <span className="muted"> (portable package)</span>
              ) : null}
            </p>
          ) : (
            <p className="muted">No path selected yet.</p>
          )}
          {sourceKind === "raw" ? (
            <label className="wizard-field">
              Corpus name
              <input
                value={corpusName}
                onChange={(e) => setCorpusName(e.target.value)}
                placeholder="incident"
              />
            </label>
          ) : (
            <p className="muted">
              Package import creates a new disposable corpus (SoftWrite). Version
              mismatches surface as clear errors.
            </p>
          )}
        </div>
      ) : null}

      {step?.id === "mode" ? (
        <div className="wizard-copy">
          {sourceKind === "package" ? (
            <p>
              Portable packages already contain the finished analysis corpus.
              Import loads it under a <strong>new</strong> local corpus id
              (origin id preserved for provenance).
            </p>
          ) : (
            <p>Choose how logs enter the system:</p>
          )}
          <label className="wizard-radio">
            <input
              type="radio"
              name="log-mode"
              checked={mode === "corpus"}
              onChange={() => setMode("corpus")}
            />
            <span>
              <strong>Log corpus</strong> — full pipeline for clusters, timeline, and log tools
            </span>
          </label>
          {sourceKind === "raw" ? (
            <>
              <label className="wizard-radio">
                <input
                  type="radio"
                  name="log-mode"
                  checked={mode === "session_context"}
                  onChange={() => setMode("session_context")}
                />
                <span>
                  <strong>Session context only</strong> — attach to this chat (lighter)
                </span>
              </label>
              <label className="wizard-radio">
                <input
                  type="radio"
                  name="log-mode"
                  checked={mode === "both"}
                  onChange={() => setMode("both")}
                />
                <span>
                  <strong>Both</strong> — corpus analysis + chat attachments
                  <span className="muted">
                    {" "}
                    (the optional chat pack is limited to 200 files / 50 MiB;
                    the corpus is the large-log path)
                  </span>
                </span>
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {step?.id === "confirm" ? (
        <div className="wizard-copy">
          <p>
            SoftWrite: ContextDesk will create a <strong>disposable</strong> analysis
            corpus and/or write files under this session&apos;s context pack. Secrets
            are redacted on ingest. This does not elevate HardWrite permissions.
          </p>
          <ul>
            <li>
              Source: <code>{basename || "(none)"}</code>
              {sourceKind === "package" ? " (portable package)" : ""}
            </li>
            <li>Mode: {mode.replace("_", " ")}</li>
            {sourceKind === "raw" && (mode === "corpus" || mode === "both") && (
              <li>
                Corpus name: <code>{corpusName || "incident"}</code>
              </li>
            )}
          </ul>
          <label className="wizard-check">
            <input
              type="checkbox"
              checked={softWriteAccepted}
              onChange={(e) => setSoftWriteAccepted(e.target.checked)}
            />
            I understand and want to proceed (SoftWrite Accept)
          </label>
        </div>
      ) : null}

      {step?.id === "run" ? (
        <div className="wizard-copy">
          <ProcessProgressPanel
            progress={progress}
            kind={
              mode === "session_context" ? "session_context_import" : "log_ingest"
            }
            error={error}
          />
          {runDone ? (
            <>
              <p className="wizard-success">
                Import finished
                {corpusId ? (
                  <>
                    {" "}
                    — corpus <code>{corpusId}</code>
                  </>
                ) : null}
                .
              </p>
              {sessionPackNote ? (
                <p className="callout callout--warn" role="status">
                  {sessionPackNote}
                </p>
              ) : null}
              {ingestReport ? (
                <>
                  <IngestStatsHero report={ingestReport} />
                  {ingestReport.confidence ? (
                    <LogImportConfidence confidence={ingestReport.confidence} />
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <p className="muted">
              {busy
                ? "Pipeline running — phases update live."
                : "Continue to start the import, or wait if it already started."}
            </p>
          )}
        </div>
      ) : null}

      {step?.id === "ready" ? (
        <div className="wizard-copy">
          <p>
            Next: the <code>log-triage</code> skill will be pinned on this chat and a
            starter prompt will fill the composer. Ask for clusters, timeline, and root
            cause with citations.
          </p>
          {corpusId ? (
            <p>
              Corpus id: <code>{corpusId}</code> (also available in the Logs pane).
            </p>
          ) : null}
          {sessionPackNote ? (
            <p className="callout callout--warn" role="status">
              {sessionPackNote}
            </p>
          ) : null}
          {ingestReport ? (
            <>
              <IngestStatsHero report={ingestReport} />
              {ingestReport.confidence ? (
                <LogImportConfidence confidence={ingestReport.confidence} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </SessionWizardShell>
  );
}

/** Post-ingest stats hero (run success + ready). */
function IngestStatsHero({ report }: { report: LogIngestReportDto }) {
  const levels = levelEntries(report.levelCounts);
  const tops = report.topTemplates?.slice(0, 6) ?? [];
  return (
    <div className="wizard-stats" data-testid="wizard-ingest-stats">
      <p className="wizard-stats__blurb">{statsBlurb(report)}</p>
      <dl className="process-progress__stats wizard-stats__grid">
        <div>
          <dt>Lines</dt>
          <dd>{report.lines.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Templates</dt>
          <dd>{report.templates.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Pattern grouping</dt>
          <dd>
            {formatEventsPerTemplate(report.reductionRatio)}{" "}
            <HelpTip
              label="Events per template"
              title="Events per template"
              content={HELP_TEMPLATE_GROUPING}
            />
          </dd>
        </div>
        <div>
          <dt>Imported files</dt>
          <dd>{report.files?.toLocaleString?.() ?? report.files ?? "—"}</dd>
        </div>
        <div>
          <dt>Discovered files</dt>
          <dd>{report.discoveredFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Excluded</dt>
          <dd>{report.excludedFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{report.failedFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Ignored</dt>
          <dd>{report.ignoredFiles.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Source size</dt>
          <dd>{formatBytes(report.sourceBytes)}</dd>
        </div>
        <div>
          <dt>Corpus footprint</dt>
          <dd>{formatBytes(report.corpusBytes)}</dd>
        </div>
        <div>
          <dt>Embedded</dt>
          <dd>{report.embedded?.toLocaleString?.() ?? report.embedded ?? "—"}</dd>
        </div>
        <div>
          <dt>Analysis mode</dt>
          <dd>
            {(report.embedding?.embeddedTemplates ?? 0) > 0
              ? report.embedding?.state === "complete"
                ? "Semantic · complete"
                : "Semantic · partial"
              : report.embedding?.state === "deferred"
                ? "Keyword-only · deferred"
                : "Keyword-only"}
          </dd>
        </div>
      </dl>
      {report.phaseTimings ? (
        <div
          className="wizard-stats__phases"
          data-testid="wizard-ingest-phase-timings"
          aria-label="Import phase timings"
        >
          <p className="wizard-stats__phases-title">
            Operation timings
            {report.phaseTimings.embeddingDeferred
              ? " · embedding deferred"
              : ""}{" "}
            <HelpTip
              label="Phase timings"
              title="Import phase timings"
              content={HELP_PHASE_TIMINGS}
            />
          </p>
          <dl className="process-progress__stats wizard-stats__grid wizard-stats__phase-grid">
            <div>
              <dt>Discover / read</dt>
              <dd>{report.phaseTimings.discoverReadMs.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Parse / frame</dt>
              <dd>{report.phaseTimings.parseFrameMs.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Template analysis</dt>
              <dd>
                {report.phaseTimings.templateAnalysisMs.toLocaleString()} ms
              </dd>
            </div>
            <div>
              <dt>Persist / index</dt>
              <dd>{report.phaseTimings.persistIndexMs.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Optional embedding</dt>
              <dd>
                {report.phaseTimings.embeddingDeferred
                  ? "deferred"
                  : `${report.phaseTimings.optionalEmbeddingMs.toLocaleString()} ms`}
              </dd>
            </div>
            <div>
              <dt>Validation</dt>
              <dd>{report.phaseTimings.validationMs.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Publication</dt>
              <dd>{report.phaseTimings.publicationMs.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{report.phaseTimings.totalMs.toLocaleString()} ms</dd>
            </div>
          </dl>
        </div>
      ) : null}
      {report.partial ? (
        <div className="wizard-stats__partial" role="note" data-testid="ingest-partial">
          <strong>Partial corpus</strong>
          <span>
            Some discovered content was excluded, ignored, or unreadable. The corpus is
            usable but is not a complete copy of the selected source.
          </span>
          {report.exclusionExamples.length > 0 ? (
            <ul aria-label="Import exclusions">
              {report.exclusionExamples.map((example, index) => (
                <li key={`${index}-${example}`}>{example}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {levels.length > 0 ? (
        <div className="wizard-stats__levels" aria-label="Level mix">
          {levels.map(({ level, count }) => (
            <span key={level} className={`chip chip--level chip--${level}`}>
              {level} {count}
            </span>
          ))}
        </div>
      ) : null}
      {tops.length > 0 ? (
        <ul className="wizard-stats__tops" aria-label="Top templates">
          {tops.map((t) => (
            <li key={t.id}>
              <span className="muted">sev={t.severity} n={t.count}</span>{" "}
              <code>{t.pattern}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
