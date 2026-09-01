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
const SHARE_SAFE_PRIVACY_CLASSES = ["share_safe"] as const;
const MAX_ERROR_LENGTH = 240;
const MAX_KNOWN_ERROR_BODY_BYTES = 1_024;
const INITIAL_FINDINGS = 12;
const INITIAL_EVIDENCE = 25;
const PREVIEW_LIMIT_BYTES = 65_536;
const PREVIEW_RANGE = `bytes=0-${PREVIEW_LIMIT_BYTES - 1}`;
const UNKNOWN_UPLOAD_REFRESHED =
  "The upload outcome is unknown. The evidence board has been refreshed; check it before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const UNKNOWN_UPLOAD_REFRESH_FAILED =
  "The upload outcome is unknown, and the evidence board could not be refreshed. Reload and check the inventory before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const CANCELLED_UPLOAD_REFRESHED =
  "The upload was cancelled. The evidence board has been refreshed; check it before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const CANCELLED_UPLOAD_REFRESH_FAILED =
  "The upload was cancelled, and the evidence board could not be refreshed. Reload and check the inventory before retrying. This is not confirmation that the file was stored or that it was rolled back.";
const UNKNOWN_FREEZE_REFRESHED =
  "The freeze outcome is unknown. The evidence board has been refreshed; check snapshots before freezing again. This is not confirmation that a snapshot was created or that it was rolled back.";
const UNKNOWN_FREEZE_REFRESH_FAILED =
  "The freeze outcome is unknown, and the evidence board could not be refreshed. Reload and check snapshots before freezing again. This is not confirmation that a snapshot was created or that it was rolled back.";
const UNKNOWN_UPLOAD_FREEZE_REFRESHED =
  "The file was uploaded, but the freeze outcome is unknown. The evidence board has been refreshed; check snapshots before freezing again. This is not confirmation that a snapshot was created or that it was rolled back.";
const UNKNOWN_UPLOAD_FREEZE_REFRESH_FAILED =
  "The file was uploaded, but the freeze outcome is unknown, and the evidence board could not be refreshed. Reload and check snapshots before freezing again. This is not confirmation that a snapshot was created or that it was rolled back.";
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

const EMPTY_ARTIFACTS: ArtifactView[] = [];
const EMPTY_SNAPSHOTS: SnapshotView[] = [];

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
    .then(() => fallback)
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

function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Failure cleanup must not delay truthful UI reconciliation.
  }
}

async function readKnownErrorCode(response: Response, signal: AbortSignal): Promise<string | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    signal.aborted
    || response.body === null
    || !contentType
    || (contentType !== "application/json" && !contentType.endsWith("+json"))
  ) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let wakeAbort: (() => void) | null = null;
  const abortWake = new Promise<null>((resolve) => {
    wakeAbort = () => resolve(null);
  });
  const onAbort = () => {
    cancelResponseReader(reader);
    wakeAbort?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortWake]);
      if (next === null || signal.aborted) return null;
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      if (next.value.byteLength > MAX_KNOWN_ERROR_BODY_BYTES - byteLength) {
        cancelResponseReader(reader);
        return null;
      }
      chunks.push(next.value.slice());
      byteLength += next.value.byteLength;
    }
    if (signal.aborted) return null;
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return parseErrorCode(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A hostile pending read may retain the lock after best-effort cancel.
    }
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

function cancelPreviewBody(response: Response): void {
  const body = response.body;
  if (!body || typeof body.cancel !== "function") return;
  try {
    void body.cancel().catch(() => undefined);
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
  const bounded = new Uint8Array(PREVIEW_LIMIT_BYTES);
  let received = 0;
  let readerTruncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;
      const remaining = PREVIEW_LIMIT_BYTES - received;
      const retained = Math.min(value.byteLength, remaining);
      if (retained > 0) {
        bounded.set(value.subarray(0, retained), received);
        received += retained;
      }
      if (value.byteLength > remaining) {
        readerTruncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released after cancel.
    }
  }
  return {
    bytes: bounded.subarray(0, received),
    truncated: readerTruncated,
    received,
  };
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

function openSameOriginDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
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
  canReadPrivate: boolean;
  readOnly: boolean;
  participants?: ParticipantLabel[];
  routeFocus?: WorkFocus;
  onOpenCapture?: () => void;
}) {
  const canReadPrivate = props.canReadPrivate;
  const defaultPrivacyClass = canReadPrivate ? "owner_only" : "share_safe";
  const privacyClasses = canReadPrivate ? PRIVACY_CLASSES : SHARE_SAFE_PRIVACY_CLASSES;
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
  const [privacyClass, setPrivacyClass] = useState<(typeof PRIVACY_CLASSES)[number]>(
    defaultPrivacyClass,
  );
  const [freezeAfterUpload, setFreezeAfterUpload] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [uploadReconciliationRequired, setUploadReconciliationRequired] = useState(false);
  const [freezeReconciliationRequired, setFreezeReconciliationRequired] = useState(false);
  const [fileInputGeneration, setFileInputGeneration] = useState(0);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectText, setInspectText] = useState<string | null>(null);
  const [inspectUnavailable, setInspectUnavailable] = useState<string | null>(null);
  const [inspectTruncated, setInspectTruncated] = useState(false);
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
  const loadAbort = useRef<AbortController | null>(null);
  const freezeAbort = useRef<AbortController | null>(null);
  const uploadInFlight = useRef(false);
  const freezeInFlight = useRef(false);
  const freezeGeneration = useRef(0);
  const transferSession = useRef(0);
  const caseIdRef = useRef(props.caseId);
  const loadedCaseRef = useRef<string | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreActionFocusAfterUpload = useRef(false);
  caseIdRef.current = props.caseId;
  const dataMatchesCase = loadedCaseRef.current === props.caseId;
  const currentArtifacts = dataMatchesCase ? artifacts : EMPTY_ARTIFACTS;
  const currentSnapshots = dataMatchesCase ? snapshots : EMPTY_SNAPSHOTS;
  const currentBoard = dataMatchesCase ? board : null;
  const caseLoading = loading || !dataMatchesCase;
  const visibleError = dataMatchesCase ? error : null;
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
    const routeIndex = currentArtifacts.findIndex((artifact) => artifact.id === evidenceRouteKey);
    if (routeIndex >= evidenceLimit) setEvidenceLimit(routeIndex + 1);
  }, [currentArtifacts, evidenceFilter, evidenceLimit, evidenceRouteKey]);
  useRouteFocus(props.routeFocus, !caseLoading && !evidenceRouteNeedsFilterReset);

  useEffect(() => {
    if (!restoreActionFocusAfterUpload.current || uploading) return;
    restoreActionFocusAfterUpload.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    (retryButtonRef.current ?? submitButtonRef.current)?.focus();
  }, [uploading, error, uploadNotice]);

  function abortPanelTransfers(): void {
    transferSession.current += 1;
    loadGeneration.current += 1;
    previewGeneration.current += 1;
    freezeGeneration.current += 1;
    loadAbort.current?.abort();
    loadAbort.current = null;
    previewAbort.current?.abort();
    previewAbort.current = null;
    uploadAbort.current?.abort();
    uploadAbort.current = null;
    freezeAbort.current?.abort();
    freezeAbort.current = null;
    uploadInFlight.current = false;
    freezeInFlight.current = false;
    restoreActionFocusAfterUpload.current = false;
  }

  function restoreActionFocus(): void {
    restoreActionFocusAfterUpload.current = true;
  }

  useEffect(() => {
    abortPanelTransfers();
    loadedCaseRef.current = null;
    handledEvidenceRoute.current = null;
    setArtifacts([]);
    setSnapshots([]);
    setBoard(null);
    setSelectedSnapshotId(null);
    setSelectedEvidence([]);
    setEvidenceFilter("");
    setEvidenceLimit(INITIAL_EVIDENCE);
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setUploading(false);
    setFreezing(false);
    setUploadProgress(null);
    setUploadNotice(null);
    setSelectedFile(null);
    setSummary("");
    setKind("log");
    setPrivacyClass(defaultPrivacyClass);
    setFreezeAfterUpload(false);
    setUploadReconciliationRequired(false);
    setFreezeReconciliationRequired(false);
    setFileInputGeneration((current) => current + 1);
    setInspecting(null);
    setInspectText(null);
    setInspectUnavailable(null);
    setInspectTruncated(false);
    previewCache.current = null;
    return () => abortPanelTransfers();
  }, [defaultPrivacyClass, props.caseId]);

  const load = useCallback(async (
    snapshotId?: string | null,
    options?: { preserveError?: boolean },
  ): Promise<boolean> => {
    const caseId = props.caseId;
    const session = transferSession.current;
    const generation = ++loadGeneration.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const isCurrent = () =>
      generation === loadGeneration.current
      && transferSession.current === session
      && caseIdRef.current === caseId
      && loadAbort.current === controller
      && !controller.signal.aborted;
    const blocking = loadedCaseRef.current !== caseId;
    if (blocking) setLoading(true);
    if (!options?.preserveError) {
      setError(null);
      setErrorSource(null);
    }
    try {
      const suffix = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : "";
      const [evidenceResponse, snapshotsResponse, boardResponse] = await Promise.all([
        protectedApiFetch(`/api/cases/${caseId}/evidence`, { signal: controller.signal }),
        protectedApiFetch(`/api/cases/${caseId}/snapshots`, { signal: controller.signal }),
        protectedApiFetch(`/api/cases/${caseId}/board${suffix}`, { signal: controller.signal }),
      ]);
      if (!isCurrent()) return false;
      if (!evidenceResponse.ok) {
        const message = await errorText(evidenceResponse, "Evidence could not be loaded.");
        if (!isCurrent()) return false;
        throw new Error(message);
      }
      if (!snapshotsResponse.ok) {
        const message = await errorText(snapshotsResponse, "Snapshots could not be loaded.");
        if (!isCurrent()) return false;
        throw new Error(message);
      }
      if (!boardResponse.ok) {
        const message = await errorText(boardResponse, "Case board could not be loaded.");
        if (!isCurrent()) return false;
        throw new Error(message);
      }
      const evidenceBody = (await evidenceResponse.json()) as { artifacts?: ArtifactView[] };
      if (!isCurrent()) return false;
      const snapshotsBody = (await snapshotsResponse.json()) as { snapshots?: SnapshotView[] };
      if (!isCurrent()) return false;
      const boardBody = (await boardResponse.json()) as { snapshotId: string | null; findings: BoardFinding[]; notice: string };
      if (!isCurrent()) return false;
      const nextArtifacts = evidenceBody.artifacts ?? [];
      setArtifacts(nextArtifacts);
      setSelectedEvidence((current) => current.filter((id) => nextArtifacts.some((artifact) => artifact.id === id)));
      setSnapshots(snapshotsBody.snapshots ?? []);
      setBoard(boardBody);
      setSelectedSnapshotId(boardBody.snapshotId);
      setUploadReconciliationRequired(false);
      setFreezeReconciliationRequired(false);
      loadedCaseRef.current = caseId;
      return true;
    } catch (cause) {
      if (isCurrent() && !isAbortFailure(cause) && !options?.preserveError) {
        loadedCaseRef.current = caseId;
        setError(cause instanceof Error ? cause.message : "Case memory could not be loaded.");
        setErrorSource("board");
      }
      return false;
    } finally {
      if (isCurrent()) {
        loadAbort.current = null;
        setLoading(false);
      }
    }
  }, [defaultPrivacyClass, props.caseId]);

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
        cancelPreviewBody(response);
        return;
      }
      if (response.status === 404) {
        cancelPreviewBody(response);
        applyPreviewUnavailable("This evidence is not available.");
        return;
      }
      if (response.status === 416) {
        cancelPreviewBody(response);
        applyPreviewUnavailable("A bounded preview is not available for this evidence.");
        return;
      }
      if (response.status === 503) {
        cancelPreviewBody(response);
        applyPreviewUnavailable(
          "Evidence storage is temporarily unavailable. Try previewing again later.",
        );
        return;
      }
      if (response.status === 304) {
        cancelPreviewBody(response);
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
        cancelPreviewBody(response);
        applyPreviewUnavailable("This evidence could not be previewed.");
        return;
      }
      const contentRange = parseContentRange(
        response.headers.get("content-range") ?? response.headers.get("Content-Range"),
      );
      if (response.status === 206 && (!contentRange || contentRange.start !== 0)) {
        cancelPreviewBody(response);
        applyPreviewUnavailable("A bounded preview is not available for this evidence.");
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
        contentRange,
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

  function downloadArtifact(artifact: ArtifactView): void {
    const caseId = props.caseId;
    const session = transferSession.current;
    if (transferSession.current !== session || caseIdRef.current !== caseId) return;
    openSameOriginDownload(evidenceContentUrl(caseId, artifact.id));
  }

  async function freezeSnapshot() {
    if (freezeInFlight.current || freezeReconciliationRequired) return;
    const visibleIds = new Set(visibleArtifacts.map((artifact) => artifact.id));
    const evidenceIds = selectedEvidence.filter((id) => visibleIds.has(id));
    if (evidenceIds.length === 0) return;
    const caseId = props.caseId;
    const session = transferSession.current;
    const generation = ++freezeGeneration.current;
    freezeAbort.current?.abort();
    const controller = new AbortController();
    freezeAbort.current = controller;
    freezeInFlight.current = true;
    setFreezing(true);
    const isCurrent = () =>
      generation === freezeGeneration.current
      && transferSession.current === session
      && caseIdRef.current === caseId
      && freezeAbort.current === controller
      && !controller.signal.aborted;
    setError(null);
    setErrorSource(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidenceIds }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setError("Snapshot could not be frozen.");
          setErrorSource("board");
          return;
        }
        const errorCode = await readKnownErrorCode(response, controller.signal);
        if (!isCurrent()) return;
        if (response.status === 503 && errorCode === "commit_outcome_unknown") {
          const refreshed = await load(null, { preserveError: true });
          if (!isCurrent()) return;
          setFreezeReconciliationRequired(!refreshed);
          if (!refreshed) setFreezeAfterUpload(false);
          setError(refreshed ? UNKNOWN_FREEZE_REFRESHED : UNKNOWN_FREEZE_REFRESH_FAILED);
          setErrorSource("board");
          return;
        }
        setError("Snapshot could not be frozen.");
        setErrorSource("board");
        return;
      }
      const snapshot = (await response.json()) as SnapshotView;
      if (!isCurrent()) return;
      setSelectedEvidence([]);
      const refreshed = await load(snapshot.id);
      if (!isCurrent() || !refreshed) return;
      window.dispatchEvent(
        new CustomEvent("contextdesk:snapshot-frozen", {
          detail: { caseId, snapshotId: snapshot.id },
        }),
      );
    } catch (cause) {
      if (!isCurrent() || isAbortFailure(cause)) return;
      setError("Snapshot could not be frozen.");
      setErrorSource("board");
    } finally {
      if (freezeAbort.current === controller) {
        freezeAbort.current = null;
        freezeInFlight.current = false;
        if (transferSession.current === session && caseIdRef.current === caseId) {
          setFreezing(false);
        }
      }
    }
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
    setPrivacyClass(defaultPrivacyClass);
    setFreezeAfterUpload(false);
    setFileInputGeneration((current) => current + 1);
  }

  async function runUpload() {
    if (
      props.readOnly
      || !props.canWrite
      || uploadInFlight.current
      || uploadReconciliationRequired
    ) return;
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
    if (!canReadPrivate && privacyClass !== "share_safe") {
      setError("Choose an allowed privacy class before uploading.");
      setErrorSource("upload");
      return;
    }

    const caseId = props.caseId;
    const session = transferSession.current;
    const file = selectedFile;
    const artifactKind = kind;
    const privacy = privacyClass;
    const shouldFreeze = props.canLead && !freezeReconciliationRequired && freezeAfterUpload;
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
        setUploadReconciliationRequired(!refreshed);
        setError(refreshed ? UNKNOWN_UPLOAD_REFRESHED : UNKNOWN_UPLOAD_REFRESH_FAILED);
        setErrorSource("upload");
        restoreActionFocus();
        if (refreshed) announceEvidenceChanged();
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
        setUploadReconciliationRequired(!refreshed);
        setError(refreshed ? UNUSABLE_UPLOAD_RESPONSE : UNUSABLE_UPLOAD_REFRESH_FAILED);
        setErrorSource("upload");
        restoreActionFocus();
        if (refreshed) announceEvidenceChanged();
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
          signal: controller.signal,
        });
        if (!stillThisUpload()) return;
        if (!snapshotResponse.ok) {
          if (snapshotResponse.status === 401 || snapshotResponse.status === 403) {
            setError("Upload succeeded but the snapshot could not be frozen.");
            setErrorSource("upload");
            resetUploadForm();
            await load(null, { preserveError: true });
            if (!stillThisUpload()) return;
            restoreActionFocus();
            announceEvidenceChanged();
            return;
          }
          const freezeErrorCode = await readKnownErrorCode(snapshotResponse, controller.signal);
          if (!stillThisUpload()) return;
          if (snapshotResponse.status === 503 && freezeErrorCode === "commit_outcome_unknown") {
            resetUploadForm();
            const refreshed = await load(null, { preserveError: true });
            if (!stillThisUpload()) return;
            setFreezeReconciliationRequired(!refreshed);
            if (!refreshed) setFreezeAfterUpload(false);
            setError(refreshed ? UNKNOWN_UPLOAD_FREEZE_REFRESHED : UNKNOWN_UPLOAD_FREEZE_REFRESH_FAILED);
            setErrorSource("upload");
            restoreActionFocus();
            if (refreshed) announceEvidenceChanged();
            return;
          }
          setError("Upload succeeded but the snapshot could not be frozen.");
          setErrorSource("upload");
          resetUploadForm();
          await load(null, { preserveError: true });
          if (!stillThisUpload()) return;
          restoreActionFocus();
          announceEvidenceChanged();
          return;
        }
        const snapshot = (await snapshotResponse.json()) as SnapshotView;
        if (!stillThisUpload()) return;
        setSelectedEvidence([]);
        resetUploadForm();
        setUploadNotice("Evidence uploaded and a snapshot was frozen.");
        await load(snapshot.id);
        if (!stillThisUpload()) return;
        restoreActionFocus();
        window.dispatchEvent(
          new CustomEvent("contextdesk:snapshot-frozen", {
            detail: { caseId, snapshotId: snapshot.id },
          }),
        );
        announceEvidenceChanged();
        return;
      }
      resetUploadForm();
      setUploadNotice("Evidence uploaded.");
      await load(null);
      if (!stillThisUpload()) return;
      restoreActionFocus();
      announceEvidenceChanged();
    } catch (cause) {
      if (!stillThisUpload()) return;
      if (isAbortFailure(cause)) {
        const refreshed = await load(null, { preserveError: true });
        if (!stillThisUpload()) return;
        setUploadReconciliationRequired(!refreshed);
        setError(refreshed ? CANCELLED_UPLOAD_REFRESHED : CANCELLED_UPLOAD_REFRESH_FAILED);
        setErrorSource("upload");
        setUploadNotice(null);
        restoreActionFocus();
        if (refreshed) announceEvidenceChanged();
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
    (currentBoard?.findings ?? []).filter((finding) => finding.bucket === bucket);
  const normalizedEvidenceFilter = evidenceFilter.trim().toLocaleLowerCase();
  const visibleArtifacts = normalizedEvidenceFilter
    ? currentArtifacts.filter((artifact) =>
        [artifact.filename, artifact.relativePath, artifact.kind]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedEvidenceFilter)),
      )
    : currentArtifacts;
  const renderedArtifacts = visibleArtifacts.slice(0, evidenceLimit);
  const hiddenArtifactCount = Math.max(0, visibleArtifacts.length - renderedArtifacts.length);
  const progressPercent =
    uploadProgress && uploadProgress.total && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
      : null;
  const canRetryUpload = Boolean(
    selectedFile
    && !uploading
    && !uploadReconciliationRequired
    && errorSource === "upload",
  );
  const visibleSelectedIds = selectedEvidence.filter((id) =>
    visibleArtifacts.some((artifact) => artifact.id === id),
  );
  const statusLiveText = !dataMatchesCase
    ? ""
    : uploading
    ? progressPercent === null
      ? `Uploading${selectedFile ? ` ${selectedFile.name}` : ""}…`
      : `Uploading${selectedFile ? ` ${selectedFile.name}` : ""} — ${progressPercent}%`
    : freezing
      ? "Freezing selected evidence…"
    : uploadNotice ?? "";

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
        <span className="case-memory__badge">{currentArtifacts.length} evidence · {currentSnapshots.length} snapshots</span>
      </div>
      {visibleError ? (
        <p className="case-memory__error" role="alert">
          {visibleError}
        </p>
      ) : null}
      <p className="case-memory__upload-live" role="status" aria-live="polite" aria-atomic="true">
        {visibleError ? "" : statusLiveText}
      </p>
      {caseLoading ? <p className="case-memory__empty">Loading case memory…</p> : null}
      {!caseLoading ? (
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
              {currentArtifacts.length === 0 ? <p className="case-memory__empty">No evidence has been registered yet.</p> : null}
              {currentArtifacts.length > 0 ? (
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
                  const canReadArtifact = artifact.privacyClass !== "owner_only" || canReadPrivate;
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
                        {canReadArtifact ? (
                          <>
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
                                onClick={() => downloadArtifact(artifact)}
                              >
                                Download {label}
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <span className="case-memory__note">
                            Private evidence bytes require additional permission.
                          </span>
                        )}
                      </div>
                      {canReadArtifact && inspecting === artifact.id ? (
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
              {currentArtifacts.length > 0 && visibleArtifacts.length === 0 ? (
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
                      {privacyClasses.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!canReadPrivate ? (
                    <p className="case-memory__note">
                      Share-safe is required so you can read the evidence after upload.
                    </p>
                  ) : null}
                  {props.canLead ? (
                    <label className="case-memory__upload-field case-memory__freeze-toggle">
                      <span>
                        <input
                          name="freezeAfterUpload"
                          type="checkbox"
                          checked={freezeAfterUpload}
                          disabled={uploading || freezeReconciliationRequired}
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
                        disabled={uploading || uploadReconciliationRequired}
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
                  disabled={
                    visibleSelectedIds.length === 0
                    || freezing
                    || freezeReconciliationRequired
                  }
                  aria-busy={freezing}
                >
                  {freezing
                    ? "Freezing selected evidence…"
                    : `Freeze selected evidence (${visibleSelectedIds.length})`}
                </button>
              ) : null}
            </section>
            <section className="case-memory__card" aria-labelledby="case-snapshots-heading">
              <h4 id="case-snapshots-heading">Snapshot lineage</h4>
              {currentSnapshots.length === 0 ? <p className="case-memory__empty">No snapshot frozen yet. The current board is provisional.</p> : null}
              <div className="case-memory__snapshots">
                {currentSnapshots.map((snapshot, index) => (
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
              {currentBoard?.snapshotId ? <span className="case-memory__badge">bound to selected snapshot</span> : null}
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
