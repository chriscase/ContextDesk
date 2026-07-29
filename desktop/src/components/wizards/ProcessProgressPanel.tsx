/**
 * Pipeline-style progress for long import/ingest (#445).
 */

import { useEffect, useState } from "react";
import {
  LOG_INGEST_PIPELINE,
  SESSION_IMPORT_PIPELINE,
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
  const frac =
    progress?.fraction != null
      ? Math.max(0, Math.min(1, progress.fraction))
      : active === "completed"
        ? 1
        : activeIdx >= 0
          ? (activeIdx + 0.5) / pipeline.length
          : 0;

  const terminal =
    active === "completed" || active === "failed" || active === "cancelled";

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
      role="status"
      aria-live="polite"
      aria-busy={!terminal && !error}
    >
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

      <div className="process-progress__bar-track" aria-hidden>
        <div
          className="process-progress__bar-fill"
          style={{ width: `${Math.round(frac * 100)}%` }}
          data-indeterminate={
            progress && progress.fraction == null && !terminal
              ? "true"
              : "false"
          }
        />
      </div>

      <p className="process-progress__message">
        {error
          ? error
          : (progress?.message ?? (terminal ? phaseLabel(active) : "Working…"))}
      </p>

      {progress ? (
        <dl className="process-progress__stats">
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
