import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildLogDiagnosticReport,
  LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
  type LogDiagnosticActiveViewInput,
  type LogDiagnosticEnvironment,
  type LogDiagnosticSuppressionPolicyInput,
  type LogDiagnosticStatus,
} from "../../lib/logDiagnosticReport";
import {
  hostPrepareLogDiagnosticReport,
  hostReleaseLogDiagnosticReport,
  hostSaveLogDiagnosticReport,
  type FailedLogIngestDiagnosticDto,
  type LogCorpusSummaryDto,
  type PreparedLogDiagnosticDto,
} from "../../lib/host";

type PreviewFormat = "markdown" | "json";
export const PREPARE_DEBOUNCE_MS = 140;

async function releasePreparedReport(reportId: string) {
  try {
    await hostReleaseLogDiagnosticReport(reportId);
  } catch {
    // The store is bounded and process-local; an expired id is already released.
  }
}

export function LogDiagnosticDialog({
  corpus,
  failedIngest = null,
  suppressionPolicy = null,
  activeView = null,
  environment,
  currentStatus,
  onDismiss,
}: {
  corpus: LogCorpusSummaryDto | null;
  failedIngest?: FailedLogIngestDiagnosticDto | null;
  suppressionPolicy?: LogDiagnosticSuppressionPolicyInput | null;
  activeView?: LogDiagnosticActiveViewInput | null;
  environment: LogDiagnosticEnvironment;
  currentStatus: LogDiagnosticStatus | null;
  onDismiss: () => void;
}) {
  const [userNote, setUserNote] = useState("");
  const [previewFormat, setPreviewFormat] = useState<PreviewFormat>("markdown");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedLogDiagnosticDto | null>(
    null,
  );
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const generatedAtRef = useRef(new Date());
  const dialogRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const prepareVersionRef = useRef(0);
  const prepareQueueRef = useRef<Promise<void>>(Promise.resolve());
  const preparedRef = useRef<PreparedLogDiagnosticDto | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const noteId = useId();

  const report = useMemo(
    () =>
      buildLogDiagnosticReport({
        corpus,
        failedIngest,
        suppressionPolicy,
        activeView,
        environment,
        currentStatus,
        userNote,
        generatedAt: generatedAtRef.current,
      }),
    [
      activeView,
      corpus,
      currentStatus,
      environment,
      failedIngest,
      suppressionPolicy,
      userNote,
    ],
  );
  const failed = failedIngest != null;
  const subjectLabel = corpus?.name ?? "the latest failed import";

  useEffect(() => {
    queueMicrotask(() => noteRef.current?.focus());
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      prepareVersionRef.current += 1;
      const selected = preparedRef.current;
      preparedRef.current = null;
      if (selected) void releasePreparedReport(selected.reportId);
    };
  }, []);

  useEffect(() => {
    const version = ++prepareVersionRef.current;
    setPrepared(null);
    setPrepareError(null);
    setResult(null);
    const timer = window.setTimeout(() => {
      prepareQueueRef.current = prepareQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!mountedRef.current || version !== prepareVersionRef.current) {
            return;
          }
          try {
            const next = await hostPrepareLogDiagnosticReport(report.manifest);
            if (!mountedRef.current || version !== prepareVersionRef.current) {
              await releasePreparedReport(next.reportId);
              return;
            }
            const previous = preparedRef.current;
            preparedRef.current = next;
            setPrepared(next);
            if (previous && previous.reportId !== next.reportId) {
              await releasePreparedReport(previous.reportId);
            }
          } catch (error) {
            if (!mountedRef.current || version !== prepareVersionRef.current) {
              return;
            }
            const previous = preparedRef.current;
            preparedRef.current = null;
            if (previous) await releasePreparedReport(previous.reportId);
            setPrepareError(`Could not prepare diagnostics: ${String(error)}`);
          }
        });
    }, PREPARE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [report.manifest]);

  const dismiss = () => {
    if (!busy) onDismiss();
  };

  async function copyPreview() {
    setResult(null);
    const json = previewFormat === "json";
    if (!prepared) {
      setResult(
        prepareError ?? "The trusted host is still preparing the preview.",
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(
        json ? prepared.json : prepared.markdown,
      );
      setResult(
        `Copied redacted ${json ? "JSON" : "Markdown"}. Review it before sharing.`,
      );
    } catch {
      setResult(
        `Clipboard unavailable. Use Save ${json ? "JSON" : "Markdown"} instead.`,
      );
    }
  }

  async function save(format: PreviewFormat) {
    const markdown = format === "markdown";
    if (!prepared) {
      setResult(
        prepareError ?? "The trusted host is still preparing the preview.",
      );
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const outcome = await hostSaveLogDiagnosticReport(
        prepared.reportId,
        format,
      );
      if (outcome.status === "cancelled") {
        setResult("Save cancelled. No file was written.");
        return;
      }
      if (outcome.status === "saved_with_warning") {
        setResult(
          `Saved redacted ${markdown ? "Markdown" : "JSON"} diagnostics, but the host reported a durability warning: ${outcome.warning}`,
        );
        return;
      }
      setResult(
        `Saved redacted ${markdown ? "Markdown" : "JSON"} diagnostics. Review before sharing.`,
      );
    } catch (error) {
      setResult(`Diagnostics were not saved: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <div
      className="log-diagnostic__backdrop"
      data-testid="log-diagnostic-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
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
            'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
    >
      <div
        ref={dialogRef}
        className="log-diagnostic__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="log-diagnostic__header">
          <div>
            <h3 id={titleId}>
              Export {failed ? "failed-ingest" : "corpus"} diagnostics
            </h3>
            <p id={descriptionId}>
              A bounded, redacted support report for{" "}
              <strong>{subjectLabel}</strong>.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={dismiss}
            aria-label="Close diagnostic export"
          >
            Close
          </button>
        </header>

        <div
          className="log-diagnostic__body"
          data-testid="log-diagnostic-scroll-body"
          role="region"
          aria-label="Diagnostic details and exact preview"
          tabIndex={0}
        >
          <div className="log-diagnostic__privacy" role="note">
            <strong>Review before sharing.</strong>
            <span>
              Raw logs and event payloads, absolute paths, chats, provider/model
              inventories, secrets, and evaluator truth are excluded.
            </span>
          </div>

          <label className="log-diagnostic__note" htmlFor={noteId}>
            <span>
              Optional reproduction note
              <small>
                {Array.from(userNote).length}/{LOG_DIAGNOSTIC_NOTE_MAX_CHARS}
              </small>
            </span>
            <textarea
              ref={noteRef}
              id={noteId}
              value={userNote}
              maxLength={LOG_DIAGNOSTIC_NOTE_MAX_CHARS}
              disabled={busy}
              placeholder="What did you do, and what did you expect?"
              onChange={(event) => setUserNote(event.target.value)}
            />
          </label>

          <div className="log-diagnostic__preview-header">
            <strong>Exact export preview</strong>
            <div
              className="log-diagnostic__format"
              role="group"
              aria-label="Diagnostic preview format"
            >
              <button
                type="button"
                className="btn btn--ghost"
                aria-pressed={previewFormat === "markdown"}
                data-active={previewFormat === "markdown" ? "true" : "false"}
                onClick={() => setPreviewFormat("markdown")}
              >
                Markdown
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                aria-pressed={previewFormat === "json"}
                data-active={previewFormat === "json" ? "true" : "false"}
                onClick={() => setPreviewFormat("json")}
              >
                JSON
              </button>
            </div>
          </div>
          <pre
            className="log-diagnostic__preview"
            tabIndex={0}
            aria-label={`${previewFormat === "markdown" ? "Markdown" : "JSON"} diagnostic preview`}
          >
            {prepared
              ? previewFormat === "markdown"
                ? prepared.markdown
                : prepared.json
              : (prepareError ??
                "Preparing exact preview in the trusted host…")}
          </pre>

          {result ? (
            <p className="log-diagnostic__result" role="status">
              {result}
            </p>
          ) : null}
        </div>

        <footer className="log-diagnostic__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !prepared}
            onClick={() => void copyPreview()}
          >
            Copy {previewFormat === "json" ? "JSON" : "Markdown"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !prepared}
            onClick={() => void save("json")}
          >
            Save JSON…
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !prepared}
            onClick={() => void save("markdown")}
          >
            {busy ? "Saving…" : "Save Markdown…"}
          </button>
        </footer>
      </div>
    </div>
  );

  return typeof document === "undefined"
    ? null
    : createPortal(dialog, document.body);
}
