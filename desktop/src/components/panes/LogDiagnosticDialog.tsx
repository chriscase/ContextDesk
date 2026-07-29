import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { saveFileDialog } from "../../lib/dialogs";
import {
  buildLogDiagnosticReport,
  LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
  type LogDiagnosticActiveViewInput,
  type LogDiagnosticEnvironment,
  type LogDiagnosticStatus,
} from "../../lib/logDiagnosticReport";
import {
  hostSaveLogDiagnosticReport,
  type FailedLogIngestDiagnosticDto,
  type LogCorpusSummaryDto,
} from "../../lib/host";

type PreviewFormat = "markdown" | "json";

export function LogDiagnosticDialog({
  corpus,
  failedIngest = null,
  activeView = null,
  environment,
  currentStatus,
  onDismiss,
}: {
  corpus: LogCorpusSummaryDto | null;
  failedIngest?: FailedLogIngestDiagnosticDto | null;
  activeView?: LogDiagnosticActiveViewInput | null;
  environment: LogDiagnosticEnvironment;
  currentStatus: LogDiagnosticStatus | null;
  onDismiss: () => void;
}) {
  const [userNote, setUserNote] = useState("");
  const [previewFormat, setPreviewFormat] =
    useState<PreviewFormat>("markdown");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const generatedAtRef = useRef(new Date());
  const dialogRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const noteId = useId();

  const report = useMemo(
    () =>
      buildLogDiagnosticReport({
        corpus,
        failedIngest,
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
      userNote,
    ],
  );
  const failed = failedIngest != null;
  const subjectLabel = corpus?.name ?? "the latest failed import";
  const subjectId = corpus?.id.slice(0, 8) ?? "failed-ingest";

  useEffect(() => {
    queueMicrotask(() => noteRef.current?.focus());
  }, []);

  const dismiss = () => {
    if (!busy) onDismiss();
  };

  async function copyPreview() {
    setResult(null);
    const json = previewFormat === "json";
    try {
      await navigator.clipboard.writeText(json ? report.json : report.markdown);
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
    const path = await saveFileDialog(
      markdown
        ? `Save ${failed ? "failed-ingest" : "corpus"} diagnostics`
        : `Save ${failed ? "failed-ingest" : "corpus"} diagnostics as JSON`,
      `contextdesk-${subjectId}-diagnostics.${markdown ? "md" : "json"}`,
      [
        markdown
          ? { name: "Markdown", extensions: ["md"] }
          : { name: "JSON", extensions: ["json"] },
      ],
    );
    if (!path) {
      setResult("Save cancelled. No file was written.");
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      await hostSaveLogDiagnosticReport(
        path,
        format,
        markdown ? report.markdown : report.json,
        // The native save panel performs the overwrite confirmation before it
        // returns an existing destination path.
        true,
      );
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
          {previewFormat === "markdown" ? report.markdown : report.json}
        </pre>

        {result ? (
          <p className="log-diagnostic__result" role="status">
            {result}
          </p>
        ) : null}

        <footer className="log-diagnostic__actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void copyPreview()}
          >
            Copy {previewFormat === "json" ? "JSON" : "Markdown"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void save("json")}
          >
            Save JSON…
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
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
