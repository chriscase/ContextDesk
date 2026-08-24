import { useEffect, useMemo, useRef, useState } from "react";
import { pathFor, type WorkFocus } from "./app-location.js";
import { protectedApiFetch } from "./protected-api.js";
import { useRouteFocus } from "./route-focus.js";

const MAX_ERROR_LENGTH = 240;
const MAX_FILE_BYTES = 1_000_000;
const MAX_ARCHIVE_BYTES = 8_388_608;
const MAX_FILE_COUNT = 64;
const ALLOWED_EXTENSIONS = [".log", ".txt", ".json", ".csv", ".xml", ".eml", ".md"];

interface PreviewReport {
  previewToken: string;
  accepted: Array<{
    relativePath: string;
    mediaType: string;
    byteLength: number;
    digest: string;
    duplicateDigest: boolean;
  }>;
  rejected: Array<{ relativePath: string; reason: string; detail: string }>;
  limits?: { maxFileBytes: number; maxArchiveBytes: number; maxFileCount: number };
}

interface CommittedBatch {
  id: string;
  caseId: string;
  origin: string;
  replayed: boolean;
  items: Array<{ artifactId: string; relativePath: string; digest: string; duplicateDigest: boolean }>;
  rejected: Array<{ relativePath: string; reason: string; detail: string }>;
}

type Origin = "files" | "zip" | "directory";

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

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
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
  const idempotencyKey = useRef(newIdempotencyKey());
  const inputVersion = useRef(0);
  const directoryRef = useRef<HTMLInputElement | null>(null);
  useRouteFocus(props.routeFocus, true);

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
      if (archive.size > MAX_ARCHIVE_BYTES) throw new Error("ZIP archives must be 8 MiB or smaller.");
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
    if (payloadFiles.length > MAX_FILE_COUNT) throw new Error("A batch may include at most 64 files.");
    const encoded = [];
    for (const row of payloadFiles) {
      if (row.file.size > MAX_FILE_BYTES) {
        throw new Error(`${row.relativePath} is larger than 1 MB.`);
      }
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

  async function runPreview() {
    if (props.readOnly || !props.canWrite || busy) return;
    setError(null);
    setBatch(null);
    setBusy("preview");
    const version = inputVersion.current;
    try {
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
      setError(
        cause instanceof Error
          ? boundedError(cause.message, "Preview could not be created.")
          : "Preview could not be created.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function runCommit() {
    if (props.readOnly || !props.canWrite || busy || !preview) return;
    setError(null);
    setBusy("commit");
    const version = inputVersion.current;
    try {
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
        cause instanceof Error
          ? boundedError(cause.message, "Intake could not be committed.")
          : "Intake could not be committed.",
      );
    } finally {
      setBusy(null);
    }
  }

  function resetSelection(next: File[]) {
    inputVersion.current += 1;
    idempotencyKey.current = newIdempotencyKey();
    setFiles(next);
    setPreview(null);
    setBatch(null);
    setError(null);
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
            {batch.items.map((item) => (
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
        <span className="triage-chip triage-chip--human">investigation-scoped</span>
      </header>
      <p className="corpus-intake__copy">
        Upload files, a ZIP, or a browser directory. Every accepted file stays on this investigation
        with its relative path, digest, privacy class, and uploader. Preview before commit. Retry
        uses the same idempotency key and will not duplicate committed evidence.
      </p>
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
        Source label
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
        Privacy class
        <select
          className="login__input"
          value={privacyClass}
          onChange={(event) => {
            setPrivacyClass(event.target.value as "owner_only" | "share_safe");
            invalidatePreview();
          }}
          aria-label="Corpus intake privacy class"
        >
          <option value="owner_only">owner_only</option>
          <option value="share_safe">share_safe</option>
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
        <p className="corpus-intake__meta">
          {payloadFiles.length} selected
          {payloadFiles
            .filter((row) => !ALLOWED_EXTENSIONS.includes(extensionOf(row.relativePath)) && origin !== "zip")
            .length > 0
            ? " · some extensions are outside the allowlist and will be rejected"
            : ""}
        </p>
      ) : null}
      {error ? (
        <p className="case-memory__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="corpus-intake__actions">
        <button className="login__submit" type="button" disabled={Boolean(busy)} onClick={() => void runPreview()}>
          {busy === "preview" ? "Previewing…" : "Preview intake"}
        </button>
        <button
          className="login__submit"
          type="button"
          disabled={Boolean(busy) || !preview}
          onClick={() => void runCommit()}
        >
          {busy === "commit" ? "Committing…" : batch ? "Retry commit" : "Commit accepted files"}
        </button>
      </div>
      {preview ? (
        <div className="corpus-intake__report">
          <h5>Accepted ({preview.accepted.length})</h5>
          {preview.accepted.length === 0 ? <p className="corpus-intake__meta">None.</p> : null}
          <ul>
            {preview.accepted.map((row) => (
              <li key={row.relativePath}>
                <strong>{row.relativePath}</strong>
                <span>
                  {row.mediaType} · {row.byteLength} bytes
                  {row.duplicateDigest ? " · duplicate digest" : ""}
                </span>
              </li>
            ))}
          </ul>
          <h5>Rejected ({preview.rejected.length})</h5>
          {preview.rejected.length === 0 ? <p className="corpus-intake__meta">None.</p> : null}
          <ul>
            {preview.rejected.map((row, index) => (
              <li key={`${row.relativePath}:${row.reason}:${index}`}>
                <strong>{row.relativePath || "(archive)"}</strong>
                <span>
                  {row.reason} · {row.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {batchCard}
    </section>
  );
}
