/**
 * Flagship log troubleshooting session wizard (#446).
 */

import { useCallback, useEffect, useState } from "react";
import {
  hostIngestLogPath,
  hostListenProcessProgress,
  hostSessionContextImportPath,
  hostSetActiveLogCorpus,
  type LogIngestReportDto,
  type ProcessProgressDto as HostProcessProgressDto,
} from "../../lib/host";
import { openDirectoryDialog, openFileDialog } from "../../lib/dialogs";
import {
  formatBytes,
  formatReduction,
  levelEntries,
  statsBlurb,
} from "../../lib/logStats";
import { ProcessProgressPanel } from "./ProcessProgressPanel";
import {
  buildLogTriageStarterPrompt,
  LOG_TROUBLESHOOTING_WIZARD,
} from "./registry";
import { SessionWizardShell } from "./SessionWizardShell";
import type { ProcessProgressDto, WizardOutcome } from "./types";

export type LogMode = "corpus" | "session_context" | "both";

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
  });
  const [corpusId, setCorpusId] = useState<string | null>(null);
  const [ingestReport, setIngestReport] = useState<LogIngestReportDto | null>(
    null,
  );
  const [runDone, setRunDone] = useState(false);

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
    if (p) setPath(p);
  };

  const pickFile = async () => {
    const p = await openFileDialog("Choose log file");
    if (p) setPath(p);
  };

  const runImport = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    setRunDone(false);
    try {
      let cid: string | null = null;
      if (mode === "corpus" || mode === "both") {
        // Host extract-and-ingest handles .zip paths (binary zip is not a log file).
        const report = await hostIngestLogPath(path, corpusName.trim() || "incident");
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
        // Host path import extracts .zip into session context (does not store the archive as one blob).
        await hostSessionContextImportPath(sessionId, path);
      }
      setRunDone(true);
      setStepIndex((i) => Math.min(i + 1, wizard.steps.length - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [corpusName, mode, path, sessionId, wizard.steps.length]);

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
          <p>Select a log file or a directory dump (basename only is shown in progress).</p>
          <div className="wizard-actions-row">
            <button type="button" onClick={() => void pickDir()}>
              Choose directory…
            </button>
            <button type="button" onClick={() => void pickFile()}>
              Choose file…
            </button>
          </div>
          {path ? (
            <p className="wizard-path">
              Selected: <code>{basename}</code>
            </p>
          ) : (
            <p className="muted">No path selected yet.</p>
          )}
          <label className="wizard-field">
            Corpus name
            <input
              value={corpusName}
              onChange={(e) => setCorpusName(e.target.value)}
              placeholder="incident"
            />
          </label>
        </div>
      ) : null}

      {step?.id === "mode" ? (
        <div className="wizard-copy">
          <p>Choose how logs enter the system:</p>
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
            </span>
          </label>
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
            </li>
            <li>Mode: {mode.replace("_", " ")}</li>
            {(mode === "corpus" || mode === "both") && (
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
              {ingestReport ? (
                <IngestStatsHero report={ingestReport} />
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
          {ingestReport ? <IngestStatsHero report={ingestReport} /> : null}
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
          <dt>Reduction</dt>
          <dd>{formatReduction(report.reductionRatio)}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{report.files?.toLocaleString?.() ?? report.files ?? "—"}</dd>
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
      </dl>
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
