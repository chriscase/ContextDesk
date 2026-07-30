/**
 * Pipeline-style progress for long import/ingest (#445).
 */

import { useEffect, useState } from "react";
import {
  LOG_INGEST_PIPELINE,
  SESSION_IMPORT_PIPELINE,
  formatElapsedMs,
  phaseLabel,
  type ProcessProgressDto,
  type ProcessProgressPhase,
} from "./types";

type Props = {
  progress: ProcessProgressDto | null;
  /** Override pipeline when known. */
  kind?: ProcessProgressDto["kind"];
  error?: string | null;
  className?: string;
  /** SoftWrite cancel (#498). */
  onCancel?: () => void | Promise<unknown>;
  /** Operation-specific accessible cancel label. */
  cancelLabel?: string;
};

export function ProcessProgressPanel({
  progress,
  kind,
  error,
  className,
  onCancel,
  cancelLabel = "Cancel ingest",
}: Props) {
  const [cancelRequested, setCancelRequested] = useState(false);
  const k = kind ?? progress?.kind ?? "log_ingest";
  const pipeline: ProcessProgressPhase[] =
    k === "session_context_import"
      ? SESSION_IMPORT_PIPELINE
      : LOG_INGEST_PIPELINE;

  const active = progress?.phase ?? "starting";
  const activeIdx = pipeline.indexOf(active as ProcessProgressPhase);
  const terminal =
    active === "completed" || active === "failed" || active === "cancelled";
  const running = !terminal && !error;
  const reportedFraction =
    progress?.fraction != null && Number.isFinite(progress.fraction)
      ? Math.max(0, Math.min(1, progress.fraction))
      : null;
  const fractionPercent =
    reportedFraction == null ? null : Math.round(reportedFraction * 100);
  const indeterminate = running && fractionPercent == null;

  useEffect(() => {
    setCancelRequested(false);
  }, [active, progress?.cancellable]);

  const requestCancel = async () => {
    if (cancelRequested || !progress?.cancellable) return;
    setCancelRequested(true);
    try {
      await onCancel?.();
    } catch {
      setCancelRequested(false);
    }
  };

  return (
    <div
      className={["process-progress", className].filter(Boolean).join(" ")}
      aria-busy={!terminal && !error}
    >
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Current phase: {error ? "Failed" : phaseLabel(active)}
      </p>

      <ol className="process-progress__pipeline" aria-label="Process phases">
        {pipeline.map((phase, i) => {
          const done =
            terminal && active === "completed"
              ? true
              : activeIdx >= 0 && i < activeIdx;
          const current =
            phase === active || (activeIdx < 0 && i === 0 && !terminal);
          return (
            <li
              key={phase}
              className="process-progress__phase"
              data-done={done ? "true" : "false"}
              data-active={current ? "true" : "false"}
            >
              <span className="process-progress__dot" aria-hidden>
                {done ? "✓" : i + 1}
              </span>
              <span className="process-progress__label">
                {phaseLabel(phase)}
              </span>
            </li>
          );
        })}
      </ol>

      {running ? (
        <progress
          className="process-progress__bar-track"
          aria-label="Process progress"
          max={100}
          {...(fractionPercent == null ? {} : { value: fractionPercent })}
          {...(fractionPercent == null
            ? {}
            : { "aria-valuenow": fractionPercent })}
          data-indeterminate={indeterminate ? "true" : "false"}
        />
      ) : (
        <div
          className="process-progress__bar-track"
          data-indeterminate="false"
          aria-hidden="true"
        />
      )}

      <p className="process-progress__message">
        {error
          ? error
          : (progress?.message ?? (terminal ? phaseLabel(active) : "Working…"))}
      </p>

      {progress ? (
        <dl className="process-progress__stats">
          {formatElapsedMs(progress.elapsed_ms) != null ? (
            <>
              <dt>Elapsed</dt>
              <dd data-testid="process-progress-elapsed">
                {formatElapsedMs(progress.elapsed_ms)}
              </dd>
            </>
          ) : null}
          {progress.lines_processed != null ? (
            <>
              <dt>Lines</dt>
              <dd>{progress.lines_processed}</dd>
            </>
          ) : null}
          {progress.templates != null ? (
            <>
              <dt>Templates</dt>
              <dd>{progress.templates}</dd>
            </>
          ) : null}
          {progress.files_processed != null ? (
            <>
              <dt>Files</dt>
              <dd>{progress.files_processed}</dd>
            </>
          ) : null}
          {progress.bytes_processed != null ? (
            <>
              <dt>Bytes</dt>
              <dd>{progress.bytes_processed}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {onCancel && progress?.cancellable && !terminal && !error ? (
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="cancel-log-ingest"
          disabled={cancelRequested}
          onClick={() => void requestCancel()}
        >
          {cancelRequested ? "Cancel requested…" : cancelLabel}
        </button>
      ) : null}
    </div>
  );
}
