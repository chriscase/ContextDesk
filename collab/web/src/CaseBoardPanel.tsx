import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { parseEvidenceUploadSuccess } from "@cd-collab/contracts/investigation-runtime";
import { protectedApiFetch, protectedMultipartUpload } from "./protected-api.js";
import type { WorkFocus } from "./app-location.js";
import { useRouteFocus } from "./route-focus.js";
import { TechnicalIdentifiers } from "./technical-identity.js";

const ARTIFACT_KINDS = ["log", "email", "attachment", "file_server_ref"] as const;
const UPLOAD_KINDS = ARTIFACT_KINDS.filter(
  (kind): kind is "log" | "email" | "attachment" => kind !== "file_server_ref",
);
const PRIVACY_CLASSES = ["owner_only", "share_safe"] as const;
const MAX_ERROR_LENGTH = 240;
const INITIAL_FINDINGS = 12;
const INITIAL_EVIDENCE = 25;
const PREVIEW_LIMIT_BYTES = 65_536;
const PREVIEW_RANGE = `bytes=0-${PREVIEW_LIMIT_BYTES - 1}`;
const UNKNOWN_UPLOAD_REFRESHED =
  "The upload outcome is unknown. The evidence board has been refreshed; check it before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const UNKNOWN_UPLOAD_REFRESH_FAILED =
  "The upload outcome is unknown, and the evidence board could not be refreshed. Reload and check the inventory before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const UNUSABLE_UPLOAD_RESPONSE =
  "The server returned an unusable upload response. Check the evidence board before retrying.";
const UNUSABLE_UPLOAD_REFRESH_FAILED =
  "The server returned an unusable upload response, and the evidence board could not be refreshed. Reload and check the inventory before retrying.";
const TEXT_LIKE_EXTENSIONS =
  /\.(log|txt|text|md|markdown|json|xml|yml|yaml|csv|tsv|eml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|ini|conf|cfg|env|sh|bash|diff|patch|svg)$/i;

interface ArtifactView {
  id: string;
  kind: string;
  filename: string | null;
  contentHash: string | null;
  verificationStatus: string | null;
  privacyClass: string;
  uploaderId: string;
  relativePath?: string | null;
  intakeBatchId?: string | null;
  mediaType?: string | null;
  byteLength?: number | null;
}

interface ParticipantLabel {
  identityId?: string;
  username?: string;
}

interface SnapshotView {
  id: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  evidence: { evidenceId: string; ordinal: number }[];
  visibility: string;
  createdAt: string;
  createdBy: string;
}

interface BoardFinding {
  id: string;
  bucket: "known" | "unknown" | "agreed" | "disputed" | "newly_concluded";
  statement: string;
  evidenceRefs: string[];
  contributionRefs: string[];
  agreement: string;
  confidence: string;
  basis?: string;
}

const BUCKETS: BoardFinding["bucket"][] = [
  "known",
  "unknown",
  "agreed",
  "disputed",
  "newly_concluded",
];

const BUCKET_DETAILS: Record<
  BoardFinding["bucket"],
  { title: string; description: string; empty: string }
> = {
  known: {
    title: "Known",
    description: "Directly supported by verified evidence or a supported hypothesis.",
    empty: "Nothing recorded yet.",
  },
  unknown: {
    title: "Unknown",
    description: "Unverified evidence and hypotheses still awaiting support.",
    empty:
      "No open unknowns recorded. Only recorded unknowns appear here; an empty list is not proof there are none.",
  },
  agreed: {
    title: "Agreed",
    description: "Independent hypotheses cite the same evidence. Agreement is not correctness.",
    empty: "Nothing recorded yet.",
  },
  disputed: {
    title: "Disputed",
    description: "Contradicted hypotheses that need human adjudication.",
    empty: "No disputes recorded.",
  },
  newly_concluded: {
    title: "Newly concluded",
    description: "Human-accepted decisions from this case's experiment reviews.",
    empty: "No accepted decision recorded yet.",
  },
};

function participantLabel(identityId: string, participants: readonly ParticipantLabel[]): string {
  const username = participants
    .find((participant) => participant.identityId === identityId)
    ?.username
    ?.trim();
  return username || "Recorded participant";
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

function boundedError(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
}

function parseErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

function mapUploadFailure(status: number, body: string): string {
  const code = parseErrorCode(body);
  if (status === 413 || code === "upload exceeds size cap") {
    return "This file is larger than the server allows.";
  }
  if (status === 404 || code === "not_found") {
    return "This investigation is not available.";
  }
  if (status === 503) {
    return "Evidence storage is temporarily unavailable. The file may not have been stored. Check the evidence board before retrying.";
  }
  if (status === 401) {
    return "Your session is no longer valid.";
  }
  if (status === 403) {
    return "You are not allowed to upload evidence.";
  }
  if (status === 400) {
    const detail = code ? `The server rejected this upload: ${code}.` : "The server rejected this upload.";
    return boundedError(detail, "The server rejected this upload.");
  }
  return boundedError(code ?? "Evidence could not be uploaded.", "Evidence could not be uploaded.");
}

function isAbortFailure(cause: unknown): boolean {
  return Boolean(
    cause
      && typeof cause === "object"
      && "name" in cause
      && (cause as { name?: unknown }).name === "AbortError",
  );
}

function formatByteLength(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    const rounded = kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10;
    return `${rounded} KB`;
  }
  const mb = bytes / (1024 * 1024);
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${rounded} MB`;
}

function isTextLikeMediaType(mediaType: string | null | undefined): boolean {
  if (!mediaType) return false;
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/")) return true;
  return (
    type === "application/json"
    || type === "application/ld+json"
    || type === "application/xml"
    || type === "application/javascript"
    || type === "application/x-javascript"
    || type === "application/yaml"
    || type === "application/x-yaml"
    || type === "application/x-ndjson"
    || type.endsWith("+json")
    || type.endsWith("+xml")
  );
}

function isTextLikeFilename(filename: string | null | undefined): boolean {
  return Boolean(filename && TEXT_LIKE_EXTENSIONS.test(filename));
}

function isMetadataOnlyArtifact(artifact: ArtifactView): boolean {
  return artifact.kind === "file_server_ref";
}

function artifactIsPreviewableText(artifact: ArtifactView): boolean {
  if (isMetadataOnlyArtifact(artifact)) return false;
  if (isTextLikeMediaType(artifact.mediaType) || isTextLikeFilename(artifact.filename)) {
    return true;
  }
  return artifact.kind === "log" || artifact.kind === "email";
}

function evidenceContentUrl(caseId: string, artifactId: string): string {
  return `/api/cases/${caseId}/evidence/${artifactId}/content`;
}

function contentLengthOf(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  if (total !== null && !Number.isSafeInteger(total)) return null;
  return { start, end, total };
}

function previewIsTruncated(input: {
  readerTruncated: boolean;
  received: number;
  contentRange: { start: number; end: number; total: number | null } | null;
  byteLength: number | null | undefined;
}): boolean {
  if (input.readerTruncated || input.received > PREVIEW_LIMIT_BYTES) return true;
  if (typeof input.byteLength === "number" && input.byteLength > PREVIEW_LIMIT_BYTES) return true;
  if (input.contentRange) {
    const covered = input.contentRange.end - input.contentRange.start + 1;
    if (input.contentRange.total !== null && input.contentRange.total > covered) return true;
    if (input.contentRange.total !== null && input.contentRange.total > PREVIEW_LIMIT_BYTES) {
      return true;
    }
    if (typeof input.byteLength === "number" && covered < input.byteLength) return true;
  }
  return false;
}

async function cancelPreviewBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch {
    // Best-effort stop of a Range-ignoring transfer.
  }
}

async function readBoundedPreviewBytes(
  response: Response,
): Promise<{ bytes: Uint8Array; truncated: boolean; received: number }> {
  const declared = contentLengthOf(response);
  if (declared !== null && declared > PREVIEW_LIMIT_BYTES) {
    await cancelPreviewBody(response);
    throw new Error("Preview stopped because the server sent more than the 64 KiB limit.");
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    throw new Error("Preview bytes were not available as a readable stream.");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let readerTruncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;
      if (received + value.byteLength > PREVIEW_LIMIT_BYTES) {
        chunks.push(value.subarray(0, PREVIEW_LIMIT_BYTES - received));
        received = PREVIEW_LIMIT_BYTES;
        readerTruncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released after cancel.
    }
  }
  return { bytes: concatBytes(chunks), truncated: readerTruncated, received };
}

function decodePreviewText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\uFFFD")) return null;
    return text;
  } catch {
    return null;
  }
}

function previewControlName(artifact: ArtifactView, open: boolean): string {
  if (artifact.kind === "log") return open ? "Hide log" : "Inspect log";
  return open ? "Hide preview" : "Preview";
}

function triggerSameOriginDownload(url: string, filename: string | null): void {
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename ?? "");
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function LogEvidenceViewer(props: { filename: string; text: string; truncated?: boolean }) {
  const lines = props.text.split(/\r?\n/);
  const interesting = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /error|exception|traceback|at\s+\S+\(/i.test(line));
  const collapsedIndexes = new Set<number>();
  if (interesting.length > 0) {
    for (const row of interesting.slice(0, 4)) {
      for (let around = row.index - 2; around <= row.index + 2; around += 1) {
        if (around >= 0 && around < lines.length) collapsedIndexes.add(around);
      }
    }
  } else {
    for (let index = 0; index < Math.min(8, lines.length); index += 1) collapsedIndexes.add(index);
  }
  const collapsed = [...collapsedIndexes].sort((a, b) => a - b);
  const isLarge = lines.length > 8 || props.text.length > 480;
  return (
    <div className="log-viewer" aria-label={`Log ${props.filename}`}>
      <p className="log-viewer__name">{props.filename}</p>
      {props.truncated ? (
        <p className="case-memory__note">Showing the first 64 KiB of this file.</p>
      ) : null}
      <ol className="log-viewer__lines log-viewer__lines--preview">
        {collapsed.map((index) => (
          <li key={index} value={index + 1}>
            {lines[index]}
          </li>
        ))}
      </ol>
      {isLarge ? (
        <details>
          <summary>
            Expand complete log or stack trace · {lines.length} lines · {props.text.length.toLocaleString()}{" "}
            characters
          </summary>
          <ol className="log-viewer__lines">
            {lines.map((line, index) => (
              <li key={index} value={index + 1}>
                {line}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

export function CaseBoardPanel(props: {
  caseId: string;
  canWrite: boolean;
  canLead: boolean;
  readOnly: boolean;
  participants?: ParticipantLabel[];
  routeFocus?: WorkFocus;
  onOpenCapture?: () => void;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotView[]>([]);
  const [board, setBoard] = useState<{ snapshotId: string | null; findings: BoardFinding[]; notice: string } | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [evidenceFilter, setEvidenceFilter] = useState("");
  const [evidenceLimit, setEvidenceLimit] = useState(INITIAL_EVIDENCE);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<"board" | "upload" | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState<(typeof UPLOAD_KINDS)[number]>("log");
  const [privacyClass, setPrivacyClass] = useState<(typeof PRIVACY_CLASSES)[number]>("owner_only");
  const [freezeAfterUpload, setFreezeAfterUpload] = useState(false);
  const [fileInputGeneration, setFileInputGeneration] = useState(0);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectText, setInspectText] = useState<string | null>(null);
  const [inspectUnavailable, setInspectUnavailable] = useState<string | null>(null);
  const [inspectTruncated, setInspectTruncated] = useState(false);
  const [downloadPendingId, setDownloadPendingId] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const previewAbort = useRef<AbortController | null>(null);
  const previewCache = useRef<{
    artifactId: string;
    etag: string;
    text: string;
    truncated: boolean;
  } | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const uploadInFlight = useRef(false);
  const transferSession = useRef(0);
  const caseIdRef = useRef(props.caseId);
  const loadedCaseRef = useRef<string | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  caseIdRef.current = props.caseId;
  const evidenceRouteKey = props.routeFocus?.section === "triage-evidence-board"
    && props.routeFocus.itemKind === "evidence"
    && props.routeFocus.item
    ? props.routeFocus.item
    : null;
  const handledEvidenceRoute = useRef<string | null>(null);
  const evidenceRouteNeedsFilterReset = Boolean(
    evidenceRouteKey
      && handledEvidenceRoute.current !== evidenceRouteKey
      && evidenceFilter,
  );
  useEffect(() => {
    if (!evidenceRouteKey) {
      handledEvidenceRoute.current = null;
      return;
    }
    if (handledEvidenceRoute.current === evidenceRouteKey) return;
    handledEvidenceRoute.current = evidenceRouteKey;
    if (evidenceFilter) setEvidenceFilter("");
    const routeIndex = artifacts.findIndex((artifact) => artifact.id === evidenceRouteKey);
    if (routeIndex >= evidenceLimit) setEvidenceLimit(routeIndex + 1);
  }, [artifacts, evidenceFilter, evidenceLimit, evidenceRouteKey]);
  useRouteFocus(props.routeFocus, !loading && !evidenceRouteNeedsFilterReset);

  useEffect(() => {
    if (!restoreActionFocusAfterUpload.current || uploading) return;
    restoreActionFocusAfterUpload.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    (retryButtonRef.current ?? submitButtonRef.current)?.focus();
  }, [uploading, error, uploadNotice]);

  function abortPanelTransfers(): void {
    transferSession.current += 1;
    previewGeneration.current += 1;
    previewAbort.current?.abort();
    previewAbort.current = null;
    uploadAbort.current?.abort();
    uploadAbort.current = null;
    downloadAbort.current?.abort();
    downloadAbort.current = null;
    uploadInFlight.current = false;
  }

  const restoreActionFocusAfterUpload = useRef(false);

  function restoreActionFocus(): void {
    restoreActionFocusAfterUpload.current = true;
  }

  useEffect(() => {
    abortPanelTransfers();
    loadedCaseRef.current = null;
    setLoading(true);
    setUploading(false);
    setUploadProgress(null);
    setUploadNotice(null);
    setSelectedFile(null);
    setSummary("");
    setKind("log");
    setPrivacyClass("owner_only");
    setFreezeAfterUpload(false);
    setFileInputGeneration((current) => current + 1);
    setInspecting(null);
    setInspectText(null);
    setInspectUnavailable(null);
    setInspectTruncated(false);
    setDownloadPendingId(null);
    setDownloadNotice(null);
    previewCache.current = null;
    return () => abortPanelTransfers();
  }, [props.caseId]);

  const load = useCallback(async (
    snapshotId?: string | null,
    options?: { preserveError?: boolean },
  ): Promise<boolean> => {
    const caseId = props.caseId;
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current && caseIdRef.current === caseId;
    const blocking = loadedCaseRef.current !== caseId;
    if (blocking) setLoading(true);
    if (!options?.preserveError) {
      setError(null);
      setErrorSource(null);
    }
    try {
      const suffix = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : "";
      const [evidenceResponse, snapshotsResponse, boardResponse] = await Promise.all([
        protectedApiFetch(`/api/cases/${caseId}/evidence`),
        protectedApiFetch(`/api/cases/${caseId}/snapshots`),
        protectedApiFetch(`/api/cases/${caseId}/board${suffix}`),
      ]);
      if (!evidenceResponse.ok) throw new Error(await errorText(evidenceResponse, "Evidence could not be loaded."));
      if (!snapshotsResponse.ok) throw new Error(await errorText(snapshotsResponse, "Snapshots could not be loaded."));
      if (!boardResponse.ok) throw new Error(await errorText(boardResponse, "Case board could not be loaded."));
      if (!isCurrent()) return false;
      const evidenceBody = (await evidenceResponse.json()) as { artifacts?: ArtifactView[] };
      const snapshotsBody = (await snapshotsResponse.json()) as { snapshots?: SnapshotView[] };
      const boardBody = (await boardResponse.json()) as { snapshotId: string | null; findings: BoardFinding[]; notice: string };
      const nextArtifacts = evidenceBody.artifacts ?? [];
      setArtifacts(nextArtifacts);
      setSelectedEvidence((current) => current.filter((id) => nextArtifacts.some((artifact) => artifact.id === id)));
      setSnapshots(snapshotsBody.snapshots ?? []);
      setBoard(boardBody);
      setSelectedSnapshotId(boardBody.snapshotId);
      loadedCaseRef.current = caseId;
      return true;
    } catch (cause) {
      if (isCurrent() && !options?.preserveError) {
        setError(cause instanceof Error ? cause.message : "Case memory could not be loaded.");
        setErrorSource("board");
      }
      return false;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [props.caseId]);

  useEffect(() => {
    setSelectedEvidence([]);
    void load(null);
  }, [load]);

  useEffect(() => {
    const onIntake = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: string }>).detail;
      if (detail?.caseId === props.caseId) void load(null);
    };
    window.addEventListener("contextdesk:corpus-intake-committed", onIntake);
    return () => window.removeEventListener("contextdesk:corpus-intake-committed", onIntake);
  }, [load, props.caseId]);

  function clearPreview(): void {
    previewGeneration.current += 1;
    previewAbort.current?.abort();
    previewAbort.current = null;
    setInspecting(null);
    setInspectText(null);
    setInspectUnavailable(null);
    setInspectTruncated(false);
  }

  function applyPreviewUnavailable(message: string): void {
    setInspectUnavailable(message);
    setInspectText(null);
  }

  async function inspectArtifact(artifact: ArtifactView) {
    if (inspecting === artifact.id) {
      clearPreview();
      return;
    }
    const caseId = props.caseId;
    const session = transferSession.current;
    const generation = ++previewGeneration.current;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setInspecting(artifact.id);
    setInspectText(null);
    setInspectUnavailable(null);
    setInspectTruncated(false);
    const stillCurrent = () =>
      generation === previewGeneration.current
      && transferSession.current === session
      && caseIdRef.current === caseId
      && !controller.signal.aborted;

    if (isMetadataOnlyArtifact(artifact)) {
      if (stillCurrent()) {
        applyPreviewUnavailable(
          "Bytes are not stored for this artifact. Only recorded metadata is available.",
        );
      }
      return;
    }
    if (!artifactIsPreviewableText(artifact)) {
      if (stillCurrent()) {
        applyPreviewUnavailable(
          "Preview is unavailable for this file type. Use Download to retrieve the original bytes.",
        );
      }
      return;
    }

    try {
      const cached = previewCache.current;
      const headers: Record<string, string> = { Range: PREVIEW_RANGE };
      if (cached && cached.artifactId === artifact.id && cached.etag) {
        headers["If-None-Match"] = cached.etag;
      }
      const response = await protectedApiFetch(
        evidenceContentUrl(caseId, artifact.id),
        { headers, signal: controller.signal },
      );
      if (!stillCurrent()) {
        await cancelPreviewBody(response);
        return;
      }
      if (response.status === 404) {
        await cancelPreviewBody(response);
        applyPreviewUnavailable("This evidence is not available.");
        return;
      }
      if (response.status === 416) {
        await cancelPreviewBody(response);
        applyPreviewUnavailable("A bounded preview is not available for this evidence.");
        return;
      }
      if (response.status === 503) {
        await cancelPreviewBody(response);
        applyPreviewUnavailable(
          "Evidence storage is temporarily unavailable. Try previewing again later.",
        );
        return;
      }
      if (response.status === 304) {
        await cancelPreviewBody(response);
        if (cached && cached.artifactId === artifact.id) {
          setInspectText(cached.text);
          setInspectTruncated(cached.truncated);
          setInspectUnavailable(null);
          return;
        }
        applyPreviewUnavailable(
          "The preview was not modified, but no cached preview is available.",
        );
        return;
      }
      if (response.status !== 200 && response.status !== 206) {
        await cancelPreviewBody(response);
        applyPreviewUnavailable("This evidence could not be previewed.");
        return;
      }
      const preview = await readBoundedPreviewBytes(response);
      if (!stillCurrent()) return;
      const text = decodePreviewText(preview.bytes);
      if (text === null) {
        applyPreviewUnavailable(
          "This file is not valid text; bytes are not decoded as a preview.",
        );
        return;
      }
      const truncated = previewIsTruncated({
        readerTruncated: preview.truncated,
        received: preview.received,
        contentRange: parseContentRange(
          response.headers.get("content-range") ?? response.headers.get("Content-Range"),
        ),
        byteLength: artifact.byteLength,
      });
      const etag = response.headers.get("etag") ?? response.headers.get("ETag") ?? "";
      previewCache.current = {
        artifactId: artifact.id,
        etag,
        text,
        truncated,
      };
      setInspectTruncated(truncated);
      setInspectText(text);
    } catch (cause) {
      if (!stillCurrent() || isAbortFailure(cause)) return;
      applyPreviewUnavailable(
        cause instanceof Error
          ? boundedError(cause.message, "This evidence could not be previewed.")
          : "This evidence could not be previewed.",
      );
    }
  }

  async function downloadArtifact(artifact: ArtifactView) {
    const caseId = props.caseId;
    const session = transferSession.current;
    downloadAbort.current?.abort();
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloadPendingId(artifact.id);
    setDownloadNotice("Preparing download…");
    const url = evidenceContentUrl(caseId, artifact.id);
    const stillThisDownload = () =>
      transferSession.current === session
      && caseIdRef.current === caseId
      && !controller.signal.aborted;
    try {
      const response = await protectedApiFetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      if (!stillThisDownload()) return;
      if (response.status === 404) {
        setDownloadNotice("This evidence is not available.");
        return;
      }
      if (response.status === 503) {
        setDownloadNotice("Evidence storage is temporarily unavailable.");
        return;
      }
      if (!response.ok) {
        setDownloadNotice("This evidence could not be downloaded.");
        return;
      }
      setDownloadNotice(null);
      triggerSameOriginDownload(url, artifact.filename);
    } catch (cause) {
      if (!stillThisDownload() || isAbortFailure(cause)) return;
      setDownloadNotice("This evidence could not be downloaded.");
    } finally {
      if (downloadAbort.current === controller) downloadAbort.current = null;
      if (stillThisDownload()) setDownloadPendingId(null);
    }
  }

  async function freezeSnapshot() {
    const visibleIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
    const evidenceIds = selectedEvidence.filter((id) => visibleIds.has(id));
    if (evidenceIds.length === 0) return;
    setError(null);
    setErrorSource(null);
    const response = await protectedApiFetch(`/api/cases/${props.caseId}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidenceIds }),
    });
    if (!response.ok) {
      setError(await errorText(response, "Snapshot could not be frozen."));
      setErrorSource("board");
      return;
    }
    const snapshot = (await response.json()) as SnapshotView;
    setSelectedEvidence([]);
    await load(snapshot.id);
    window.dispatchEvent(
      new CustomEvent("contextdesk:snapshot-frozen", {
        detail: { caseId: props.caseId, snapshotId: snapshot.id },
      }),
    );
  }

  /**
   * Analyze shows this board and the Log workbench side by side over the same
   * investigation. A file uploaded here belongs in both, so the upload says so
   * rather than leaving the workbench listing a stale inventory until reload.
   */
  function announceEvidenceChanged() {
    window.dispatchEvent(
      new CustomEvent("contextdesk:evidence-changed", {
        detail: { caseId: props.caseId },
      }),
    );
  }

  function resetUploadForm(): void {
    setSelectedFile(null);
    setSummary("");
    setKind("log");
    setPrivacyClass("owner_only");
    setFreezeAfterUpload(false);
    setFileInputGeneration((current) => current + 1);
  }

  async function runUpload() {
    if (props.readOnly || !props.canWrite || uploadInFlight.current) return;
    if (!selectedFile) {
      setError("Choose an evidence file to upload.");
      setErrorSource("upload");
      return;
    }
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setError("Add a short evidence summary.");
      setErrorSource("upload");
      return;
    }

    const caseId = props.caseId;
    const session = transferSession.current;
    const file = selectedFile;
    const artifactKind = kind;
    const privacy = privacyClass;
    const shouldFreeze = props.canLead && freezeAfterUpload;
    const payload = new FormData();
    payload.append("kind", artifactKind);
    payload.append("summary", trimmedSummary);
    payload.append("privacyClass", privacy);
    payload.append("file", file);

    const controller = new AbortController();
    uploadAbort.current?.abort();
    uploadAbort.current = controller;
    uploadInFlight.current = true;
    setError(null);
    setErrorSource(null);
    setUploadNotice(null);
    setUploading(true);
    setUploadProgress(
      Number.isFinite(file.size) && file.size > 0
        ? { loaded: 0, total: file.size }
        : { loaded: 0, total: null },
    );
    const stillThisUpload = () =>
      transferSession.current === session
      && caseIdRef.current === caseId
      && uploadAbort.current === controller;

    try {
      const response = await protectedMultipartUpload(
        `/api/cases/${caseId}/evidence/stream`,
        {
          body: payload,
          signal: controller.signal,
          onUploadProgress: (progress) => {
            if (stillThisUpload() && !controller.signal.aborted) setUploadProgress(progress);
          },
        },
      );
      if (!stillThisUpload()) return;
      const bodyText = await response.text();
      if (!stillThisUpload()) return;
      if (response.status === 503 && parseErrorCode(bodyText) === "commit_outcome_unknown") {
        const refreshed = await load(null, { preserveError: true });
        if (!stillThisUpload()) return;
        setError(refreshed ? UNKNOWN_UPLOAD_REFRESHED : UNKNOWN_UPLOAD_REFRESH_FAILED);
        setErrorSource("upload");
        if (refreshed) announceEvidenceChanged();
        restoreActionFocus();
        return;
      }
      if (!response.ok) {
        setError(mapUploadFailure(response.status, bodyText));
        setErrorSource("upload");
        restoreActionFocus();
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        parsed = null;
      }
      let uploaded = null;
      try {
        uploaded = parseEvidenceUploadSuccess(parsed);
      } catch {
        uploaded = null;
      }
      if (
        !uploaded
        || uploaded.caseId !== caseId
        || uploaded.artifact.id.trim().length === 0
      ) {
        const refreshed = await load(null, { preserveError: true });
        if (!stillThisUpload()) return;
        setError(refreshed ? UNUSABLE_UPLOAD_RESPONSE : UNUSABLE_UPLOAD_REFRESH_FAILED);
        setErrorSource("upload");
        if (refreshed) announceEvidenceChanged();
        restoreActionFocus();
        return;
      }
      if (shouldFreeze) {
        const visibleIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
        const evidenceIds = [...new Set([
          ...selectedEvidence.filter((id) => visibleIds.has(id)),
          uploaded.artifact.id,
        ])];
        const snapshotResponse = await protectedApiFetch(`/api/cases/${caseId}/snapshots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ evidenceIds }),
        });
        if (!stillThisUpload()) return;
        if (!snapshotResponse.ok) {
          setError(await errorText(snapshotResponse, "Upload succeeded but the snapshot could not be frozen."));
          setErrorSource("upload");
          resetUploadForm();
          await load(null, { preserveError: true });
          announceEvidenceChanged();
          restoreActionFocus();
          return;
        }
        const snapshot = (await snapshotResponse.json()) as SnapshotView;
        if (!stillThisUpload()) return;
        setSelectedEvidence([]);
        resetUploadForm();
        setUploadNotice("Evidence uploaded and a snapshot was frozen.");
        await load(snapshot.id);
        window.dispatchEvent(
          new CustomEvent("contextdesk:snapshot-frozen", {
            detail: { caseId, snapshotId: snapshot.id },
          }),
        );
        announceEvidenceChanged();
        restoreActionFocus();
        return;
      }
      resetUploadForm();
      setUploadNotice("Evidence uploaded.");
      await load(null);
      announceEvidenceChanged();
      restoreActionFocus();
    } catch (cause) {
      if (!stillThisUpload()) return;
      if (isAbortFailure(cause)) {
        setUploadNotice("Upload cancelled.");
        setError(null);
        setErrorSource(null);
        restoreActionFocus();
        return;
      }
      setError(
        cause instanceof Error
          ? boundedError(
            /failed to fetch/i.test(cause.message)
              ? "The upload did not reach the server. Check the evidence board before retrying."
              : cause.message,
            "Evidence could not be uploaded.",
          )
          : "The upload did not reach the server. Check the evidence board before retrying.",
      );
      setErrorSource("upload");
      restoreActionFocus();
    } finally {
      if (uploadAbort.current === controller) {
        uploadInFlight.current = false;
        uploadAbort.current = null;
        if (transferSession.current === session && caseIdRef.current === caseId) {
          setUploading(false);
          setUploadProgress(null);
        }
      }
    }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runUpload();
  }

  function cancelUpload() {
    uploadAbort.current?.abort();
  }

  const byBucket = (bucket: BoardFinding["bucket"]) =>
    (board?.findings ?? []).filter((finding) => finding.bucket === bucket);
  const normalizedEvidenceFilter = evidenceFilter.trim().toLocaleLowerCase();
  const visibleArtifacts = normalizedEvidenceFilter
    ? artifacts.filter((artifact) =>
        [artifact.filename, artifact.relativePath, artifact.kind]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedEvidenceFilter)),
      )
    : artifacts;
  const renderedArtifacts = visibleArtifacts.slice(0, evidenceLimit);
  const hiddenArtifactCount = Math.max(0, visibleArtifacts.length - renderedArtifacts.length);
  const progressPercent =
    uploadProgress && uploadProgress.total && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
      : null;
  const canRetryUpload = Boolean(selectedFile && !uploading && (errorSource === "upload" || uploadNotice === "Upload cancelled."));
  const visibleSelectedIds = selectedEvidence.filter((id) =>
    visibleArtifacts.some((artifact) => artifact.id === id),
  );
  const statusLiveText = uploading
    ? progressPercent === null
      ? `Uploading${selectedFile ? ` ${selectedFile.name}` : ""}…`
      : `Uploading${selectedFile ? ` ${selectedFile.name}` : ""} — ${progressPercent}%`
    : [uploadNotice, downloadNotice].filter(Boolean).join(" ");

  function selectVisibleEvidence() {
    const visibleIds = visibleArtifacts.map((artifact) => artifact.id);
    setSelectedEvidence((current) => [...new Set([...current, ...visibleIds])]);
  }

  return (
    <section className="case-memory" aria-labelledby="case-memory-heading">
      <div className="case-memory__header">
        <div>
          <p className="case-memory__eyebrow">War-room memory</p>
          <h3 id="case-memory-heading">Evidence and snapshots</h3>
          <p className="case-memory__copy">Freeze exactly what a later triage is allowed to see. New evidence creates a new lineage point.</p>
        </div>
        <span className="case-memory__badge">{artifacts.length} evidence · {snapshots.length} snapshots</span>
      </div>
      {error ? (
        <p className="case-memory__error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="case-memory__upload-live" role="status" aria-live="polite" aria-atomic="true">
        {error ? "" : statusLiveText}
      </p>
      {loading ? <p className="case-memory__empty">Loading case memory…</p> : null}
      {!loading ? (
        <>
          <div className="case-memory__grid">
            <section className="case-memory__card" aria-labelledby="case-evidence-heading">
              <h4 id="case-evidence-heading">Evidence board</h4>
              <p className="case-memory__card-copy">
                Find files by name, path, or kind. In Capture, resolve ambiguous log times before
                freezing a snapshot.
              </p>
              {props.onOpenCapture ? (
                <button
                  type="button"
                  className="case-memory__review-times"
                  onClick={props.onOpenCapture}
                >
                  Review timestamps in Capture
                </button>
              ) : null}
              {artifacts.length === 0 ? <p className="case-memory__empty">No evidence has been registered yet.</p> : null}
              {artifacts.length > 0 ? (
                <div className="case-memory__evidence-tools">
                  <label htmlFor="case-evidence-filter">
                    Filter evidence
                    <input
                      className="login__input"
                      id="case-evidence-filter"
                      type="search"
                      value={evidenceFilter}
                      onChange={(event) => {
                        setEvidenceFilter(event.target.value);
                        setEvidenceLimit(INITIAL_EVIDENCE);
                      }}
                      placeholder="Filename, path, or kind"
                    />
                  </label>
                  <p aria-live="polite">
                    {visibleArtifacts.length.toLocaleString()} matching · showing{" "}
                    {Math.min(renderedArtifacts.length, visibleArtifacts.length).toLocaleString()} ·{" "}
                    {visibleSelectedIds.length.toLocaleString()} selected
                  </p>
                  {!props.readOnly && props.canLead ? (
                    <div className="case-memory__selection-actions">
                      <button
                        type="button"
                        onClick={selectVisibleEvidence}
                        disabled={visibleArtifacts.length === 0}
                      >
                        {evidenceFilter.trim() ? "Select all matching" : "Select all evidence"}
                      </button>
                      <button type="button" onClick={() => setSelectedEvidence([])} disabled={selectedEvidence.length === 0}>
                        Clear selection
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ul className="case-memory__list">
                {renderedArtifacts.map((artifact) => {
                  const selected = selectedEvidence.includes(artifact.id);
                  const selectable = !props.readOnly && props.canLead;
                  const label = artifact.filename ?? artifact.kind;
                  const sizeLabel = formatByteLength(artifact.byteLength);
                  const itemClass = [
                    "case-memory__item",
                    selectable ? "case-memory__item--selectable" : "",
                    selected ? "is-selected" : "",
                  ].filter(Boolean).join(" ");
                  return (
                  <li
                    key={artifact.id}
                    className={itemClass}
                    data-route-item={artifact.id}
                    data-route-kind="evidence"
                    tabIndex={-1}
                  >
                    {selectable ? (
                      <input
                        type="checkbox"
                        aria-label={`Include ${label} in snapshot`}
                        checked={selected}
                        onChange={(event) =>
                          setSelectedEvidence((current) =>
                            event.target.checked
                              ? [...current, artifact.id]
                              : current.filter((id) => id !== artifact.id),
                          )
                        }
                      />
                    ) : null}
                    <div className="case-memory__item-body">
                      <div className="case-memory__item-heading">
                        <strong>{label}</strong>
                        <span className="case-memory__item-identity">
                          <span className="case-memory__item-kind">Kind: {artifact.kind}</span>
                          {sizeLabel ? <span className="case-memory__item-size">{sizeLabel}</span> : null}
                          {artifact.mediaType ? (
                            <span className="case-memory__item-type">{artifact.mediaType}</span>
                          ) : null}
                          <span className="case-memory__item-status">
                            {artifact.verificationStatus ?? "verification unknown"}
                          </span>
                        </span>
                      </div>
                      <div className="case-memory__item-meta">
                        <span className="case-memory__meta">
                          uploaded by {participantLabel(artifact.uploaderId, props.participants ?? [])}
                        </span>
                        <span className="case-memory__meta">{artifact.privacyClass}</span>
                      </div>
                      <div className="case-memory__item-actions">
                        <TechnicalIdentifiers
                          record={label}
                          items={[
                            {
                              label: "Content hash",
                              value: artifact.contentHash,
                              hint: "matches this exact evidence against another system",
                            },
                            { label: "Evidence id", value: artifact.id },
                          ]}
                        />
                        <button
                          type="button"
                          className="case-memory__inspect"
                          aria-expanded={inspecting === artifact.id}
                          onClick={() => void inspectArtifact(artifact)}
                        >
                          {previewControlName(artifact, inspecting === artifact.id)}
                        </button>
                        {artifact.kind !== "file_server_ref" ? (
                          <button
                            type="button"
                            className="case-memory__download"
                            disabled={downloadPendingId === artifact.id}
                            onClick={() => void downloadArtifact(artifact)}
                          >
                            {downloadPendingId === artifact.id
                              ? `Preparing download of ${label}`
                              : `Download ${label}`}
                          </button>
                        ) : null}
                      </div>
                      {inspecting === artifact.id ? (
                        inspectUnavailable ? (
                          <p className="case-memory__note">{inspectUnavailable}</p>
                        ) : inspectText !== null ? (
                          <LogEvidenceViewer
                            filename={label}
                            text={inspectText}
                            truncated={inspectTruncated}
                          />
                        ) : (
                          <p className="case-memory__empty">Loading preview…</p>
                        )
                      ) : null}
                    </div>
                  </li>
                  );
                })}
              </ul>
              {hiddenArtifactCount > 0 ? (
                <div className="case-memory__more">
                  <p>
                    Showing {renderedArtifacts.length.toLocaleString()} of {visibleArtifacts.length.toLocaleString()} matching items.
                  </p>
                  <button
                    type="button"
                    onClick={() => setEvidenceLimit((current) => current + INITIAL_EVIDENCE)}
                  >
                    Show {Math.min(INITIAL_EVIDENCE, hiddenArtifactCount).toLocaleString()} more matching
                  </button>
                </div>
              ) : null}
              {artifacts.length > 0 && visibleArtifacts.length === 0 ? (
                <p className="case-memory__empty">No evidence matches this filter.</p>
              ) : null}
              {!props.readOnly && props.canWrite ? (
                <form
                  className="case-memory__upload-form"
                  aria-labelledby="case-evidence-upload-heading"
                  aria-busy={uploading}
                  onSubmit={(event) => void uploadEvidence(event)}
                >
                  <h5 id="case-evidence-upload-heading">Upload evidence</h5>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-file">
                    File
                    <input
                      className="login__input"
                      id="case-evidence-file"
                      name="file"
                      type="file"
                      required
                      key={fileInputGeneration}
                      disabled={uploading}
                      onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  {selectedFile ? (
                    <p className="case-memory__note">Selected: {selectedFile.name}</p>
                  ) : null}
                  <label className="case-memory__upload-field" htmlFor="case-evidence-summary">
                    Summary
                    <textarea
                      className="login__input"
                      id="case-evidence-summary"
                      name="summary"
                      required
                      rows={3}
                      value={summary}
                      disabled={uploading}
                      onChange={(event) => setSummary(event.target.value)}
                    />
                  </label>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-kind">
                    Artifact kind
                    <select
                      className="login__input"
                      id="case-evidence-kind"
                      name="kind"
                      value={kind}
                      disabled={uploading}
                      onChange={(event) => setKind(event.target.value as (typeof UPLOAD_KINDS)[number])}
                    >
                      {UPLOAD_KINDS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="case-memory__upload-field" htmlFor="case-evidence-privacy">
                    Privacy class
                    <select
                      className="login__input"
                      id="case-evidence-privacy"
                      name="privacyClass"
                      value={privacyClass}
                      disabled={uploading}
                      onChange={(event) =>
                        setPrivacyClass(event.target.value as (typeof PRIVACY_CLASSES)[number])
                      }
                    >
                      {PRIVACY_CLASSES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  {props.canLead ? (
                    <label className="case-memory__upload-field case-memory__freeze-toggle">
                      <span>
                        <input
                          name="freezeAfterUpload"
                          type="checkbox"
                          checked={freezeAfterUpload}
                          disabled={uploading}
                          onChange={(event) => setFreezeAfterUpload(event.target.checked)}
                        /> Freeze a snapshot with
                        this upload
                      </span>
                      <small>
                        One step: the sanitized file is uploaded and a snapshot is frozen with it
                        (plus any evidence already selected above). Upload sanitized content only;
                        the server's media and privacy policy still applies.
                      </small>
                    </label>
                  ) : null}
                  <div className="case-memory__upload-status">
                    {uploading && uploadProgress?.total && uploadProgress.total > 0 ? (
                      <progress
                        aria-label="Upload progress"
                        value={uploadProgress.loaded}
                        max={uploadProgress.total}
                      />
                    ) : null}
                    <div className="case-memory__upload-actions">
                      <button
                        className="login__submit"
                        type="submit"
                        disabled={uploading}
                        ref={submitButtonRef}
                      >
                        {uploading ? "Uploading…" : "Upload evidence"}
                      </button>
                      {uploading ? (
                        <button
                          className="case-memory__secondary-button"
                          type="button"
                          onClick={cancelUpload}
                        >
                          Cancel
                        </button>
                      ) : null}
                      {canRetryUpload ? (
                        <button
                          className="case-memory__secondary-button"
                          type="button"
                          ref={retryButtonRef}
                          onClick={() => void runUpload()}
                        >
                          Retry upload
                        </button>
                      ) : null}
                    </div>
                  </div>
                </form>
              ) : null}
              {!props.readOnly && props.canLead ? (
                <button
                  className="login__submit"
                  type="button"
                  onClick={() => void freezeSnapshot()}
                  disabled={visibleSelectedIds.length === 0}
                >
                  Freeze selected evidence ({visibleSelectedIds.length})
                </button>
              ) : null}
            </section>
            <section className="case-memory__card" aria-labelledby="case-snapshots-heading">
              <h4 id="case-snapshots-heading">Snapshot lineage</h4>
              {snapshots.length === 0 ? <p className="case-memory__empty">No snapshot frozen yet. The current board is provisional.</p> : null}
              <div className="case-memory__snapshots">
                {snapshots.map((snapshot, index) => (
                  <button
                    className={snapshot.id === selectedSnapshotId ? "case-memory__snapshot is-selected" : "case-memory__snapshot"}
                    type="button"
                    key={snapshot.id}
                    data-route-item={snapshot.id}
                    data-route-kind="snapshot"
                    aria-current={snapshot.id === selectedSnapshotId ? "page" : undefined}
                    onClick={() => {
                      setSelectedSnapshotId(snapshot.id);
                      void load(snapshot.id);
                    }}
                  >
                    <strong>S{index}</strong>
                    <span>{snapshot.evidence.length} items · frozen by {participantLabel(snapshot.createdBy, props.participants ?? [])}</span>
                    {/* No truncated fingerprint: a picker is where snapshots are
                        told apart, and twelve characters of a digest cannot do
                        that job — the snapshot's own number, size, and author
                        can. The exact fingerprint is shown in full, with a copy
                        control, once a snapshot is inspected. */}
                  </button>
                ))}
              </div>
              <p className="case-memory__note">Runs bound to a snapshot never silently widen to newer evidence.</p>
            </section>
          </div>
          <section className="case-memory__card case-memory__board" aria-labelledby="case-board-heading">
            <div className="case-memory__board-header">
              <div>
                <h4 id="case-board-heading">What the case currently supports</h4>
                <p className="case-memory__note">Agreement is not proof of correctness. Gold remains a separate human benchmark.</p>
              </div>
              {board?.snapshotId ? <span className="case-memory__badge">bound to selected snapshot</span> : null}
            </div>
            <div className="case-memory__board-grid">
              {BUCKETS.map((bucket) => {
                const findings = byBucket(bucket);
                const renderFinding = (finding: BoardFinding) => (
                  <article key={finding.id} className="case-memory__finding">
                    {finding.basis === "accepted_decision" ? (
                      <span className="case-memory__finding-tag">Accepted decision</span>
                    ) : null}
                    <p>{finding.statement}</p>
                    <small>
                      agreement {finding.agreement} · confidence {finding.confidence} ·{" "}
                      {finding.evidenceRefs.length} evidence{" "}
                      {finding.evidenceRefs.length === 1 ? "ref" : "refs"}
                    </small>
                  </article>
                );
                return <div key={bucket} className="case-memory__bucket">
                  <h5>{BUCKET_DETAILS[bucket].title}</h5>
                  <p className="case-memory__bucket-hint">{BUCKET_DETAILS[bucket].description}</p>
                  {findings.length === 0 ? (
                    <p className="case-memory__empty">{BUCKET_DETAILS[bucket].empty}</p>
                  ) : null}
                  {findings.slice(0, INITIAL_FINDINGS).map(renderFinding)}
                  {findings.length > INITIAL_FINDINGS ? (
                    <details className="case-memory__findings-more">
                      <summary>Show {findings.length - INITIAL_FINDINGS} more {BUCKET_DETAILS[bucket].title.toLocaleLowerCase()} items</summary>
                      {findings.slice(INITIAL_FINDINGS).map(renderFinding)}
                    </details>
                  ) : null}
                </div>;
              })}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
