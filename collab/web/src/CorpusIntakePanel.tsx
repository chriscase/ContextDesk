import {
  CORPUS_INTAKE_LIMITS,
  corpusAllowedExtension,
} from "@cd-collab/contracts/corpus-intake";
import type { CorpusIntakeSessionV1 } from "@cd-collab/contracts/corpus-stream";
import { useEffect, useMemo, useRef, useState } from "react";
import { pathFor, type WorkFocus } from "./app-location.js";
import {
  CORPUS_STAGE_COPY,
  CORPUS_UNKNOWN_COPY,
  CorpusIntakeTransferError,
  cancelStreamedIntake,
  commitStreamedIntake,
  forgetIntakeSession,
  formatBytes,
  loadStreamedIntake,
  recallIntakeSession,
  rememberIntakeSession,
  runStreamedIntake,
  summarizeCorpusSelection,
  type CorpusTransferProgress,
} from "./corpus-intake-session.js";
import { protectedApiFetch } from "./protected-api.js";
import { useRouteFocus } from "./route-focus.js";

const MAX_ERROR_LENGTH = 240;
const INITIAL_REPORT_ROWS = 12;

interface PreviewReport {
  previewToken: string;
  accepted: Array<{
    relativePath: string;
    mediaType: string;
    byteLength: number;
    digest: string;
    duplicateDigest: boolean;
    encodingStatus?: "utf8" | "normalized_non_utf8";
  }>;
  rejected: Array<{ relativePath: string; reason: string; detail: string }>;
  limits?: typeof CORPUS_INTAKE_LIMITS;
}

interface CommittedBatch {
  id: string;
  caseId: string;
  origin: string;
  replayed: boolean;
  items: Array<{
    artifactId: string;
    relativePath: string;
    digest: string;
    duplicateDigest: boolean;
    encodingStatus?: "utf8" | "normalized_non_utf8";
  }>;
  rejected: Array<{ relativePath: string; reason: string; detail: string }>;
}

type Origin = "files" | "zip" | "directory";

const REJECTION_COPY: Record<string, { label: string; guidance: string }> = {
  unsupported_media: {
    label: "Unrecognized file type",
    guidance: "Rename genuine text logs to a recognized log or text extension, then preview again.",
  },
  binary_or_unknown: {
    label: "Not safely readable as text",
    guidance: "Inspect these files outside the War Room before deciding whether they belong in the investigation.",
  },
  nested_archive: {
    label: "Nested ZIP archive",
    guidance: "Open and review nested archives separately before adding their relevant files.",
  },
  redaction_failed: {
    label: "Not safe for the selected sharing level",
    guidance: "Keep the upload private or remove sensitive content before previewing it again.",
  },
  file_too_large: {
    label: "Individual file is too large",
    guidance: "Split the file into smaller chronological segments before intake.",
  },
  too_many_files: {
    label: "Too many files in one batch",
    guidance: "Divide the corpus into smaller related batches.",
  },
  oversized_archive: {
    label: "ZIP archive is too large",
    guidance: "Split the archive into smaller related archives.",
  },
  oversized_expanded: {
    label: "Expanded corpus is too large",
    guidance: "Remove unrelated material or divide the corpus into smaller batches.",
  },
  processing_timeout: {
    label: "Preview did not finish in time",
    guidance: "Divide the corpus into smaller batches and retry.",
  },
  unsupported_encoding: {
    label: "Text encoding this investigation does not accept",
    guidance: "Convert these files to UTF-8, or ask an owner to widen the accepted encodings.",
  },
  line_too_long: {
    label: "A single line is too long to read safely",
    guidance: "Split the file, or export it as JSON Lines with one record per line.",
  },
  structured_too_large: {
    label: "Structured document is too large to validate",
    guidance: "Export it as JSON Lines so it can be checked one record at a time.",
  },
  archive_depth_exceeded: {
    label: "Archive nested deeper than this investigation allows",
    guidance: "Unpack the inner archives yourself and add the files that matter.",
  },
  unsafe_archive_path: {
    label: "Archive member points outside the investigation",
    guidance: "Rebuild the archive with plain relative paths and no links.",
  },
  path_traversal: {
    label: "Archive member points outside the investigation",
    guidance: "Rebuild the archive with plain relative paths and no links.",
  },
  absolute_path: {
    label: "Archive member uses an absolute path",
    guidance: "Rebuild the archive with paths relative to its own root.",
  },
  symlink_or_hardlink: {
    label: "Link rather than a file",
    guidance: "Add the files the links point at, not the links themselves.",
  },
  duplicate_normalized_path: {
    label: "Two files claim the same path",
    guidance: "Rename one of them so each file has a distinct path.",
  },
};

export interface CorpusRejectionSummary {
  reason: string;
  label: string;
  guidance: string;
  count: number;
}

export function summarizeCorpusRejections(
  rejected: ReadonlyArray<{ reason: string }>,
): CorpusRejectionSummary[] {
  const counts = new Map<string, number>();
  for (const row of rejected) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      label: REJECTION_COPY[reason]?.label ?? "Could not be accepted",
      guidance: REJECTION_COPY[reason]?.guidance ?? "Open the file details for the recorded reason.",
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/**
 * Selection problems the browser can name without asking the server.
 *
 * Kept as its own export because the same judgement drives both the disabled
 * state on the buttons and the preflight card's blocking line.
 */
export function corpusSelectionLimitError(
  origin: Origin,
  selected: ReadonlyArray<{ relativePath: string; size: number }>,
): string | null {
  return summarizeCorpusSelection(origin, selected, CORPUS_INTAKE_LIMITS).blocking;
}

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…` : trimmed;
}

function errorText(response: Response, fallback: string): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (typeof body === "object" && body !== null && "error" in body) {
        const error = (body as { error?: unknown }).error;
        if (typeof error === "string") return boundedError(error, fallback);
      }
      return fallback;
    })
    .catch(() => fallback);
}

function relativeOf(file: File): string {
  const relative = "webkitRelativePath" in file ? String(file.webkitRelativePath || "") : "";
  return relative || file.name;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Selected file could not be read."));
        return;
      }
      const separator = reader.result.indexOf(",");
      resolve(separator === -1 ? reader.result : reader.result.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error("Selected file could not be read."));
    reader.readAsDataURL(file);
  });
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `batch-${crypto.randomUUID()}`;
  }
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CorpusIntakePanel(props: {
  caseId: string;
  canWrite: boolean;
  readOnly: boolean;
  routeFocus?: WorkFocus;
}) {
  const [origin, setOrigin] = useState<Origin>("files");
  const [sourceLabel, setSourceLabel] = useState("investigation upload");
  const [privacyClass, setPrivacyClass] = useState<"owner_only" | "share_safe">("owner_only");
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<PreviewReport | null>(null);
  const [batch, setBatch] = useState<CommittedBatch | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CorpusTransferProgress | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState<CorpusIntakeSessionV1 | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const inputVersion = useRef(0);
  const directoryRef = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The state copy drives rendering; the ref is what an async handler reads,
  // because a handler created in an earlier render would otherwise decide what
  // to clean up from a session id that has since changed.
  const openSession = useRef<string | null>(null);
  useRouteFocus(props.routeFocus, true);

  function noteSession(id: string | null): void {
    openSession.current = id;
    setSessionId(id);
    if (id) rememberIntakeSession(props.caseId, id);
    else forgetIntakeSession();
  }

  // A reload cannot keep the picked files, but the server still holds the bytes
  // it already received. Surfacing that is the difference between resuming a
  // large upload and starting it over.
  useEffect(() => {
    const remembered = recallIntakeSession(props.caseId);
    if (!remembered) return;
    let cancelled = false;
    void loadStreamedIntake(props.caseId, remembered).then((session) => {
      if (cancelled) return;
      if (!session || session.state === "committed" || session.state === "cancelled") {
        forgetIntakeSession();
        return;
      }
      setInterrupted(session);
    });
    return () => {
      cancelled = true;
    };
  }, [props.caseId]);

  useEffect(() => {
    const batchId =
      props.routeFocus?.itemKind === "intake-batch" ? props.routeFocus.item : null;
    if (!batchId) return;
    void protectedApiFetch(`/api/cases/${props.caseId}/corpus-intake/${batchId}`).then(
      async (response) => {
        if (!response.ok) return;
        setBatch((await response.json()) as CommittedBatch);
      },
    );
  }, [props.caseId, props.routeFocus?.item, props.routeFocus?.itemKind]);

  const payloadFiles = useMemo(
    () =>
      files.map((file) => ({
        file,
        relativePath: relativeOf(file).replace(/\\/g, "/"),
      })),
    [files],
  );

  const selection = useMemo(
    () =>
      summarizeCorpusSelection(
        origin,
        payloadFiles.map((row) => ({ relativePath: row.relativePath, size: row.file.size })),
      ),
    [origin, payloadFiles],
  );

  function invalidatePreview(): void {
    inputVersion.current += 1;
    idempotencyKey.current = newIdempotencyKey();
    setPreview(null);
    setBatch(null);
    setError(null);
  }

  async function buildBody(schemaId: string, previewToken?: string) {
    if (origin === "zip") {
      const archive = files[0];
      if (!archive) throw new Error("Choose a ZIP archive.");
      const limitError = corpusSelectionLimitError(origin, [{ relativePath: archive.name, size: archive.size }]);
      if (limitError) throw new Error(limitError);
      return {
        schemaId,
        origin,
        sourceLabel: sourceLabel.trim() || "investigation upload",
        privacyClass,
        idempotencyKey: idempotencyKey.current,
        ...(previewToken ? { previewToken } : {}),
        files: [],
        archiveBase64: await toBase64(archive),
      };
    }
    if (payloadFiles.length === 0) throw new Error("Choose at least one file.");
    const limitError = corpusSelectionLimitError(
      origin,
      payloadFiles.map((row) => ({ relativePath: row.relativePath, size: row.file.size })),
    );
    if (limitError) throw new Error(limitError);
    const encoded = [];
    for (const row of payloadFiles) {
      encoded.push({
        relativePath: row.relativePath,
        mediaType: row.file.type || "application/octet-stream",
        contentBase64: await toBase64(row.file),
      });
    }
    return {
      schemaId,
      origin,
      sourceLabel: sourceLabel.trim() || "investigation upload",
      privacyClass,
      idempotencyKey: idempotencyKey.current,
      ...(previewToken ? { previewToken } : {}),
      files: encoded,
      archiveBase64: null,
    };
  }

  async function runStreamedPreview(version: number): Promise<void> {
    const controller = new AbortController();
    abort.current = controller;
    try {
      const outcome = await runStreamedIntake({
        caseId: props.caseId,
        origin,
        sourceLabel: sourceLabel.trim() || "investigation upload",
        privacyClass,
        idempotencyKey: idempotencyKey.current,
        files: payloadFiles.map((row) => ({ relativePath: row.relativePath, file: row.file })),
        resumeSession: interrupted,
        signal: controller.signal,
        onSession: (session) => noteSession(session.sessionId),
        onProgress: setProgress,
      });
      setInterrupted(null);
      if (inputVersion.current === version) {
        noteSession(outcome.sessionId);
        setPreview(outcome.report as unknown as PreviewReport);
      }
    } finally {
      abort.current = null;
    }
  }

  async function runPreview() {
    if (props.readOnly || !props.canWrite || busy) return;
    setError(null);
    setBatch(null);
    setProgress(null);
    setBusy("preview");
    const version = inputVersion.current;
    try {
      if (selection.blocking) throw new Error(selection.blocking);
      if (selection.lane === "streamed") {
        if (payloadFiles.length === 0) throw new Error("Choose at least one file.");
        await runStreamedPreview(version);
        return;
      }
      const body = await buildBody("cd-collab.corpus_intake_preview.v1");
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/corpus-intake/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await errorText(response, "Preview could not be created."));
        return;
      }
      const report = (await response.json()) as PreviewReport;
      if (inputVersion.current === version) setPreview(report);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setError("Upload cancelled. Nothing was added to this investigation.");
      } else {
        setError(
          cause instanceof CorpusIntakeTransferError
            ? boundedError(cause.payload.message, "Preview could not be created.")
            : cause instanceof Error
              ? boundedError(cause.message, "Preview could not be created.")
              : "Preview could not be created.",
        );
        // A session that is still waiting for bytes survives a dropped
        // connection. Holding onto it means the next attempt continues from
        // what the server already has instead of orphaning it and starting the
        // whole upload again.
        await keepResumableSession();
      }
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function keepResumableSession(): Promise<void> {
    const open = openSession.current;
    if (!open) return;
    const live = await loadStreamedIntake(props.caseId, open);
    if (live?.state === "awaiting_bytes") {
      setInterrupted(live);
      return;
    }
    noteSession(null);
  }

  /**
   * Stop an upload or expansion in flight.
   *
   * The server drops the session's spooled bytes as it unwinds, so a cancelled
   * intake leaves no half-corpus behind for someone to wonder about later.
   */
  async function cancelIntake() {
    abort.current?.abort();
    const open = openSession.current;
    if (open) await cancelStreamedIntake(props.caseId, open);
    noteSession(null);
    setInterrupted(null);
    setProgress(null);
    setPreview(null);
    setBusy(null);
    setError("Upload cancelled. Nothing was added to this investigation.");
  }

  function discardInterrupted() {
    const open = interrupted?.sessionId;
    if (open) void cancelStreamedIntake(props.caseId, open);
    noteSession(null);
    setInterrupted(null);
  }

  async function runCommit() {
    if (props.readOnly || !props.canWrite || busy || !preview) return;
    setError(null);
    setBusy("commit");
    const version = inputVersion.current;
    try {
      if (sessionId) {
        const committed = await commitStreamedIntake(
          props.caseId,
          sessionId,
          preview.previewToken,
          idempotencyKey.current,
        ) as CommittedBatch;
        noteSession(null);
        if (inputVersion.current === version) setBatch(committed);
        window.dispatchEvent(
          new CustomEvent("contextdesk:corpus-intake-committed", {
            detail: { caseId: props.caseId, batchId: committed.id },
          }),
        );
        return;
      }
      const body = await buildBody("cd-collab.corpus_intake_commit.v1", preview.previewToken);
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/corpus-intake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setError(await errorText(response, "Intake could not be committed."));
        return;
      }
      const committed = (await response.json()) as CommittedBatch;
      if (inputVersion.current === version) setBatch(committed);
      window.dispatchEvent(
        new CustomEvent("contextdesk:corpus-intake-committed", {
          detail: { caseId: props.caseId, batchId: committed.id },
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof CorpusIntakeTransferError
          ? boundedError(cause.payload.message, "Intake could not be committed.")
          : cause instanceof Error
            ? boundedError(cause.message, "Intake could not be committed.")
            : "Intake could not be committed.",
      );
    } finally {
      setBusy(null);
    }
  }

  function resetSelection(next: File[]) {
    inputVersion.current += 1;
    if (!interrupted) idempotencyKey.current = newIdempotencyKey();
    setFiles(next);
    setPreview(null);
    setBatch(null);
    setError(null);
    setProgress(null);
  }

  const batchCard = batch ? (
        <div
          className="corpus-intake__batch"
          data-route-item={batch.id}
          data-route-kind="intake-batch"
          tabIndex={-1}
        >
          <h5>{batch.replayed ? "Replayed batch" : "Committed batch"}</h5>
          <p className="corpus-intake__meta">
            {batch.items.length} accepted · {batch.rejected.length} rejected · origin {batch.origin}
          </p>
          <ul>
            {batch.items.slice(0, INITIAL_REPORT_ROWS).map((item) => (
              <li key={`${item.artifactId}:${item.relativePath}`}>
                <a
                  href={pathFor({
                    area: "investigations",
                    caseId: props.caseId,
                    stage: "analyze",
                    focus: {
                      section: "triage-evidence-board",
                      item: item.artifactId,
                      itemKind: "evidence",
                      lane: null,
                      experiment: null,
                    },
                  })}
                >
                  {item.relativePath}
                </a>
                {item.duplicateDigest ? " · reused stored bytes" : ""}
              </li>
            ))}
          </ul>
          {batch.items.length > INITIAL_REPORT_ROWS ? (
            <details>
              <summary>Show {batch.items.length - INITIAL_REPORT_ROWS} more committed files</summary>
              <ul>
                {batch.items.slice(INITIAL_REPORT_ROWS).map((item) => (
                  <li key={`${item.artifactId}:${item.relativePath}`}>
                    <a
                      href={pathFor({
                        area: "investigations",
                        caseId: props.caseId,
                        stage: "analyze",
                        focus: {
                          section: "triage-evidence-board",
                          item: item.artifactId,
                          itemKind: "evidence",
                          lane: null,
                          experiment: null,
                        },
                      })}
                    >
                      {item.relativePath}
                    </a>
                    {item.duplicateDigest ? " · reused stored bytes" : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <a
            className="corpus-intake__deeplink"
            href={pathFor({
              area: "investigations",
              caseId: props.caseId,
              stage: "capture",
              focus: {
                section: "corpus-intake",
                item: batch.id,
                itemKind: "intake-batch",
                lane: null,
                experiment: null,
              },
            })}
          >
            Deep link to this batch
          </a>
        </div>
  ) : null;
  const rejectionSummary = preview ? summarizeCorpusRejections(preview.rejected) : [];

  if (props.readOnly || !props.canWrite) {
    return (
      <section className="corpus-intake" id="corpus-intake" aria-labelledby="corpus-intake-heading">
        <h4 id="corpus-intake-heading">Logs and files for this investigation</h4>
        <p className="corpus-intake__copy">
          Contributors can add individual files, a ZIP, or a directory of logs to this investigation.
        </p>
        {batchCard}
      </section>
    );
  }

  return (
    <section className="corpus-intake" id="corpus-intake" aria-labelledby="corpus-intake-heading">
      <header className="corpus-intake__head">
        <h4 id="corpus-intake-heading">Logs and files for this investigation</h4>
        <span className="triage-chip triage-chip--human">stays with this investigation</span>
      </header>
      <p className="corpus-intake__copy">
        Add files, a ZIP, or a browser directory. Preview the selection before saving it. Repeating
        the same upload will not create duplicate evidence.
      </p>
      {interrupted ? (
        <div className="corpus-intake__resume" role="status">
          <p>
            An upload to this investigation was interrupted.{" "}
            {formatBytes(interrupted.progress.uploadedBytes)} of{" "}
            {formatBytes(interrupted.selection.declaredBytes)} is already here. Choose the same
            files again to continue from where it stopped.
          </p>
          <button className="login__submit" type="button" onClick={discardInterrupted}>
            Discard the interrupted upload
          </button>
        </div>
      ) : null}
      <fieldset className="corpus-intake__origin" aria-label="Intake origin">
        {(["files", "zip", "directory"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="corpus-origin"
              value={value}
              checked={origin === value}
              onChange={() => {
                setOrigin(value);
                resetSelection([]);
              }}
            />
            {value === "files" ? "Files" : value === "zip" ? "ZIP archive" : "Directory"}
          </label>
        ))}
      </fieldset>
      <label className="corpus-intake__field">
        How should this upload be labeled?
        <input
          className="login__input"
          value={sourceLabel}
          onChange={(event) => {
            setSourceLabel(event.target.value);
            invalidatePreview();
          }}
          aria-label="Corpus intake source label"
        />
      </label>
      <label className="corpus-intake__field">
        Who can use these files?
        <select
          className="login__input"
          value={privacyClass}
          onChange={(event) => {
            setPrivacyClass(event.target.value as "owner_only" | "share_safe");
            invalidatePreview();
          }}
          aria-label="Corpus intake privacy class"
        >
          <option value="owner_only">Only people in this investigation</option>
          <option value="share_safe">Eligible for approved exports</option>
        </select>
      </label>
      {origin === "zip" ? (
        <label className="corpus-intake__field">
          ZIP archive
          <input
            className="login__input"
            type="file"
            accept=".zip,application/zip"
            aria-label="ZIP file to upload"
            onChange={(event) => resetSelection(event.target.files ? [...event.target.files] : [])}
          />
        </label>
      ) : origin === "directory" ? (
        <label className="corpus-intake__field">
          Directory
          <input
            className="login__input"
            type="file"
            multiple
            aria-label="Log directory"
            ref={(node) => {
              directoryRef.current = node;
              if (node) {
                node.setAttribute("webkitdirectory", "");
                node.setAttribute("directory", "");
                (node as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
              }
            }}
            onChange={(event) => resetSelection(event.target.files ? [...event.target.files] : [])}
          />
        </label>
      ) : (
        <label className="corpus-intake__field">
          Files
          <input
            className="login__input"
            type="file"
            multiple
            aria-label="Evidence files"
            onChange={(event) => resetSelection(event.target.files ? [...event.target.files] : [])}
          />
        </label>
      )}
      {payloadFiles.length > 0 ? (
        <section className="corpus-preflight" aria-labelledby="corpus-preflight-heading">
          <h5 id="corpus-preflight-heading">Before this upload starts</h5>
          <dl className="corpus-preflight__facts">
            <div>
              <dt>{origin === "zip" ? "Archives selected" : "Files selected"}</dt>
              <dd>{selection.fileCount.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>{origin === "zip" ? "Compressed bytes" : "Selected bytes"}</dt>
              <dd>{formatBytes(selection.selectedBytes)}</dd>
            </div>
            <div>
              <dt>{origin === "zip" ? "Archive limit" : "Corpus limit"}</dt>
              <dd>
                {formatBytes(
                  origin === "zip"
                    ? selection.limits.maxArchiveBytes
                    : selection.limits.maxExpandedBytes,
                )}
              </dd>
            </div>
            <div>
              <dt>How it is sent</dt>
              <dd>
                {selection.lane === "streamed"
                  ? `Resumable chunks of ${formatBytes(selection.limits.maxRequestBytes)}`
                  : "One request"}
              </dd>
            </div>
          </dl>
          <details className="corpus-preflight__stages">
            <summary>What will be checked ({selection.stages.length} stages)</summary>
            <ol>
              {selection.stages.map((stage) => (
                <li key={stage}>{CORPUS_STAGE_COPY[stage]}</li>
              ))}
            </ol>
          </details>
          {selection.unknowns.length > 0 ? (
            <p className="corpus-intake__meta">
              Not knowable yet:{" "}
              {selection.unknowns.map((unknown) => CORPUS_UNKNOWN_COPY[unknown]).join("; ")}.
            </p>
          ) : null}
          {payloadFiles
            .filter((row) => corpusAllowedExtension(row.relativePath) === null && origin !== "zip")
            .length > 0
            ? (
              <p className="corpus-intake__meta">
                Some extensions are outside the allowlist and will be rejected.
              </p>
            )
            : null}
          {selection.blocking ? (
            <p className="case-memory__error" role="alert">{selection.blocking}</p>
          ) : null}
        </section>
      ) : null}
      {error ? (
        <p className="case-memory__error" role="alert">
          {error}
        </p>
      ) : null}
      {progress ? (
        <div className="corpus-progress" role="status" aria-live="polite">
          <p className="corpus-progress__stage">{CORPUS_STAGE_COPY[progress.stage]}</p>
          {progress.stage === "upload" && progress.totalBytes !== null ? (
            <>
              <progress
                className="corpus-progress__bar"
                aria-label="Upload progress"
                value={progress.uploadedBytes}
                max={progress.totalBytes}
              />
              <p className="corpus-intake__meta">
                {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)} sent
              </p>
            </>
          ) : progress.expectedExpandedBytes !== null ? (
            <>
              <progress
                className="corpus-progress__bar"
                aria-label="Expansion progress"
                value={progress.expandedBytes}
                max={progress.expectedExpandedBytes}
              />
              <p className="corpus-intake__meta">
                {formatBytes(progress.expandedBytes)} of{" "}
                {formatBytes(progress.expectedExpandedBytes)} expanded ·{" "}
                {progress.filesAccepted} accepted · {progress.filesRejected} need attention
              </p>
            </>
          ) : (
            <>
              {/* No total is knowable yet, so no bar claims one. */}
              <progress className="corpus-progress__bar" aria-label="Working" />
              <p className="corpus-intake__meta">
                Total size is not known until the archive index is read.
              </p>
            </>
          )}
        </div>
      ) : null}
      <div className="corpus-intake__actions">
        <button
          className="login__submit"
          type="button"
          disabled={Boolean(busy) || Boolean(selection.blocking)}
          onClick={() => void runPreview()}
        >
          {busy === "preview" ? "Previewing…" : "Preview intake"}
        </button>
        <button
          className="login__submit"
          type="button"
          disabled={Boolean(busy) || !preview || Boolean(batch)}
          onClick={() => void runCommit()}
        >
          {busy === "commit" ? "Committing…" : batch ? "Committed" : "Commit accepted files"}
        </button>
        {busy === "preview" && selection.lane === "streamed" ? (
          <button
            className="login__submit corpus-intake__cancel"
            type="button"
            onClick={() => void cancelIntake()}
          >
            Cancel upload
          </button>
        ) : null}
      </div>
      {preview ? (
        <div className="corpus-intake__report">
          <h5>Accepted ({preview.accepted.length})</h5>
          {preview.accepted.length === 0 ? <p className="corpus-intake__meta">None.</p> : null}
          <ul>
            {preview.accepted.slice(0, INITIAL_REPORT_ROWS).map((row) => (
              <li key={row.relativePath}>
                <strong>{row.relativePath}</strong>
                <span>
                  {row.mediaType} · {row.byteLength} bytes
                  {row.duplicateDigest ? " · duplicate digest" : ""}
                  {row.encodingStatus === "normalized_non_utf8"
                    ? " · original bytes preserved; unreadable bytes replaced in analysis text"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {preview.accepted.length > INITIAL_REPORT_ROWS ? (
            <details>
              <summary>Show {preview.accepted.length - INITIAL_REPORT_ROWS} more accepted files</summary>
              <ul>
                {preview.accepted.slice(INITIAL_REPORT_ROWS).map((row) => (
                  <li key={row.relativePath}>
                    <strong>{row.relativePath}</strong>
                    <span>
                      {row.mediaType} · {row.byteLength} bytes
                      {row.duplicateDigest ? " · duplicate digest" : ""}
                      {row.encodingStatus === "normalized_non_utf8"
                        ? " · original bytes preserved; unreadable bytes replaced in analysis text"
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <h5>Needs attention ({preview.rejected.length})</h5>
          {preview.rejected.length === 0 ? (
            <p className="corpus-intake__meta">Every selected file can be committed.</p>
          ) : (
            <>
              <ul>
                {rejectionSummary.map((row) => (
                  <li key={row.reason}>
                    <strong>{row.count} · {row.label}</strong>
                    <span>{row.guidance}</span>
                  </li>
                ))}
              </ul>
              <details>
                <summary>Review rejected file details</summary>
                <ul>
                  {preview.rejected.slice(0, INITIAL_REPORT_ROWS).map((row, index) => (
                    <li key={`${row.relativePath}:${row.reason}:${index}`}>
                      <strong>{row.relativePath || "(archive)"}</strong>
                      <span>{row.detail}</span>
                    </li>
                  ))}
                </ul>
                {preview.rejected.length > INITIAL_REPORT_ROWS ? (
                  <details>
                    <summary>Show {preview.rejected.length - INITIAL_REPORT_ROWS} more rejected files</summary>
                    <ul>
                      {preview.rejected.slice(INITIAL_REPORT_ROWS).map((row, index) => (
                        <li key={`${row.relativePath}:${row.reason}:${index + INITIAL_REPORT_ROWS}`}>
                          <strong>{row.relativePath || "(archive)"}</strong>
                          <span>{row.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </details>
            </>
          )}
        </div>
      ) : null}
      {batchCard}
    </section>
  );
}
