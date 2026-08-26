import {
  CORPUS_INTAKE_LIMITS,
  corpusIntakeInlineDecodedBytes,
  type CorpusIntakeLimitsV1,
} from "@cd-collab/contracts/corpus-intake";
import {
  CORPUS_STREAM_COMMIT_SCHEMA_ID,
  CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
  corpusIntakeStagesFor,
  corpusIntakeUnknownsFor,
  type CorpusIntakeErrorV1,
  type CorpusIntakeSessionV1,
  type CorpusIntakeStage,
  type CorpusIntakeUnknown,
} from "@cd-collab/contracts/corpus-stream";
import { protectedApiFetch } from "./protected-api.js";

export type CorpusOrigin = "files" | "zip" | "directory";

export interface CorpusSelectionRow {
  relativePath: string;
  size: number;
}

/**
 * Which lane a selection belongs to.
 *
 * The inline lane carries base64 inside one JSON request, so it can only hold
 * what a request may carry. Everything larger goes through the streamed
 * session lane rather than being refused or, worse, accepted into a body no
 * runtime can parse.
 */
export type CorpusLane = "inline" | "streamed";

export interface CorpusPreflightSummary {
  origin: CorpusOrigin;
  lane: CorpusLane;
  fileCount: number;
  /** Bytes as they sit on the operator's disk. */
  selectedBytes: number;
  /** Compressed bytes for an archive; null for loose files. */
  compressedBytes: number | null;
  /** Expanded bytes when knowable before upload; null for an archive. */
  expandedBytes: number | null;
  stages: CorpusIntakeStage[];
  unknowns: CorpusIntakeUnknown[];
  limits: CorpusIntakeLimitsV1;
  /** Set when the selection cannot be accepted at all; already actionable. */
  blocking: string | null;
}

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = byteLength / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export const CORPUS_UNKNOWN_COPY: Record<CorpusIntakeUnknown, string> = {
  expanded_bytes: "how large the archive is once expanded",
  member_count: "how many files the archive holds",
  member_paths: "what the files inside the archive are called",
  member_encodings: "which text encoding each file uses",
  duplicate_digests: "which files this investigation already holds",
};

export const CORPUS_STAGE_COPY: Record<CorpusIntakeStage, string> = {
  preflight: "Check the selection against this investigation's limits",
  upload: "Send the bytes in resumable chunks",
  archive_index: "Read the archive index",
  expand: "Expand members one at a time",
  classify: "Decide what each file is and whether it is readable text",
  privacy_scan: "Apply the sharing-level privacy gate",
  stage_evidence: "Stage accepted files for review",
  commit: "Record accepted files as investigation evidence",
};

/**
 * Describe a selection before anything is sent.
 *
 * Everything here is either measured from the picked files or read from the
 * server's advertised limits. Nothing about an archive's contents is guessed:
 * what cannot be known yet is listed as unknown instead.
 */
export function summarizeCorpusSelection(
  origin: CorpusOrigin,
  selected: readonly CorpusSelectionRow[],
  limits: CorpusIntakeLimitsV1 = CORPUS_INTAKE_LIMITS,
): CorpusPreflightSummary {
  const selectedBytes = selected.reduce((total, row) => total + row.size, 0);
  const archive = origin === "zip";
  const inlineCap = corpusIntakeInlineDecodedBytes(limits);
  const lane: CorpusLane = selectedBytes <= inlineCap && selected.length <= 32
    ? "inline"
    : "streamed";
  const summary: CorpusPreflightSummary = {
    origin,
    lane,
    fileCount: selected.length,
    selectedBytes,
    compressedBytes: archive ? selectedBytes : null,
    expandedBytes: archive ? null : selectedBytes,
    stages: corpusIntakeStagesFor(origin),
    unknowns: corpusIntakeUnknownsFor(origin),
    limits,
    blocking: null,
  };
  return { ...summary, blocking: blockingSelectionError(summary, selected) };
}

function blockingSelectionError(
  summary: CorpusPreflightSummary,
  selected: readonly CorpusSelectionRow[],
): string | null {
  const { limits, origin } = summary;
  if (selected.length === 0) return null;
  if (origin === "zip") {
    const archive = selected[0];
    if (selected.length > 1) return "Choose a single ZIP archive.";
    if (archive && archive.size > limits.maxArchiveBytes) {
      return `ZIP archives must be ${formatBytes(limits.maxArchiveBytes)} or smaller.`;
    }
    return null;
  }
  if (selected.length > limits.maxFileCount) {
    return `A batch may include at most ${limits.maxFileCount.toLocaleString("en-US")} files.`;
  }
  for (const row of selected) {
    if (row.size > limits.maxFileBytes) {
      return `${row.relativePath} is larger than ${formatBytes(limits.maxFileBytes)}.`;
    }
  }
  if (summary.selectedBytes > limits.maxExpandedBytes) {
    return `The selected files total more than ${formatBytes(limits.maxExpandedBytes)}.`;
  }
  return null;
}

export interface CorpusTransferProgress {
  stage: CorpusIntakeStage;
  determinate: boolean;
  uploadedBytes: number;
  totalBytes: number | null;
  expandedBytes: number;
  expectedExpandedBytes: number | null;
  filesAccepted: number;
  filesRejected: number;
}

export class CorpusIntakeTransferError extends Error {
  constructor(readonly payload: CorpusIntakeErrorV1) {
    super(payload.message);
    this.name = "CorpusIntakeTransferError";
  }
}

async function readIntakeError(response: Response): Promise<CorpusIntakeTransferError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (body ?? {}) as Partial<CorpusIntakeErrorV1> & { error?: unknown };
  const message = typeof record.message === "string" && record.message.trim()
    ? record.message
    : typeof record.error === "string"
      ? record.error
      : "This upload could not be accepted.";
  return new CorpusIntakeTransferError({
    schemaId: "cd-collab.corpus_intake_error.v1",
    code: (record.code ?? "storage_unavailable") as CorpusIntakeErrorV1["code"],
    message,
    detail: typeof record.detail === "string" ? record.detail : message,
    limit: typeof record.limit === "number" ? record.limit : null,
    observed: typeof record.observed === "number" ? record.observed : null,
    path: typeof record.path === "string" ? record.path : null,
    retryable: record.retryable === true,
  });
}

export interface StreamedIntakeInput {
  caseId: string;
  origin: CorpusOrigin;
  sourceLabel: string;
  privacyClass: "owner_only" | "share_safe";
  idempotencyKey: string;
  files: Array<{ relativePath: string; file: Blob & { type?: string } }>;
  /** Resume into an existing session instead of opening a new one. */
  resumeSession?: CorpusIntakeSessionV1 | null;
  signal?: AbortSignal;
  onSession?: (session: CorpusIntakeSessionV1) => void;
  onProgress?: (progress: CorpusTransferProgress) => void;
}

export interface StreamedIntakeResult {
  sessionId: string;
  report: {
    previewToken: string;
    accepted: Array<Record<string, unknown>>;
    rejected: Array<{ relativePath: string; reason: string; detail: string }>;
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Intake cancelled", "AbortError");
}

/**
 * Drive one streamed intake from the browser.
 *
 * Each chunk is a `Blob` slice handed straight to `fetch`, so the browser
 * streams it from disk. Nothing here reads a file into a string or an
 * ArrayBuffer, which is what keeps a multi-hundred-megabyte selection from
 * having to fit in the tab's memory.
 */
export async function runStreamedIntake(
  input: StreamedIntakeInput,
): Promise<StreamedIntakeResult> {
  const base = `/api/cases/${input.caseId}/corpus-intake/sessions`;
  let session = input.resumeSession ?? null;
  if (!session) {
    const opened = await protectedApiFetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaId: CORPUS_STREAM_PREFLIGHT_SCHEMA_ID,
        origin: input.origin,
        sourceLabel: input.sourceLabel,
        privacyClass: input.privacyClass,
        idempotencyKey: input.idempotencyKey,
        parts: input.files.map((row, index) => ({
          index,
          relativePath: row.relativePath,
          declaredBytes: row.file.size,
          declaredMediaType: row.file.type || "application/octet-stream",
        })),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!opened.ok) throw await readIntakeError(opened);
    session = (await opened.json()) as CorpusIntakeSessionV1;
  }
  input.onSession?.(session);

  const totalBytes = session.selection.declaredBytes;
  const chunkBytes = session.limits.maxRequestBytes;
  let uploadedBytes = session.parts.reduce((total, part) => total + part.receivedBytes, 0);
  const report = (stage: CorpusIntakeStage, extra: Partial<CorpusTransferProgress> = {}) =>
    input.onProgress?.({
      stage,
      determinate: true,
      uploadedBytes,
      totalBytes,
      expandedBytes: 0,
      expectedExpandedBytes: null,
      filesAccepted: 0,
      filesRejected: 0,
      ...extra,
    });
  report("upload");

  for (const [index, row] of input.files.entries()) {
    const part = session.parts[index];
    if (!part) continue;
    let offset = part.receivedBytes;
    while (offset < row.file.size) {
      assertNotAborted(input.signal);
      const end = Math.min(offset + chunkBytes, row.file.size);
      const response = await protectedApiFetch(
        `${base}/${session.sessionId}/parts/${index}?offset=${offset}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: row.file.slice(offset, end),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (!response.ok) throw await readIntakeError(response);
      const next = (await response.json()) as CorpusIntakeSessionV1;
      session = next;
      uploadedBytes = next.parts.reduce((total, entry) => total + entry.receivedBytes, 0);
      offset = next.parts[index]?.receivedBytes ?? end;
      report("upload");
    }
  }

  assertNotAborted(input.signal);
  // Expansion runs server-side. Its total is unknown for an archive until the
  // index is read, so progress stays honestly indeterminate until then.
  const expanding = pollExpansion(base, session.sessionId, input, () => uploadedBytes, totalBytes);
  const preview = await protectedApiFetch(`${base}/${session.sessionId}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  expanding.stop();
  if (!preview.ok) throw await readIntakeError(preview);
  return {
    sessionId: session.sessionId,
    report: (await preview.json()) as StreamedIntakeResult["report"],
  };
}

function pollExpansion(
  base: string,
  sessionId: string,
  input: StreamedIntakeInput,
  uploadedBytes: () => number,
  totalBytes: number,
): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || input.signal?.aborted) return;
    try {
      const response = await protectedApiFetch(`${base}/${sessionId}`);
      if (response.ok) {
        const live = (await response.json()) as CorpusIntakeSessionV1;
        input.onProgress?.({
          stage: live.progress.stage,
          determinate: live.progress.expectedExpandedBytes !== null,
          uploadedBytes: uploadedBytes(),
          totalBytes,
          expandedBytes: live.progress.expandedBytes,
          expectedExpandedBytes: live.progress.expectedExpandedBytes,
          filesAccepted: live.progress.filesAccepted,
          filesRejected: live.progress.filesRejected,
        });
      }
    } catch {
      // A failed status poll is cosmetic; the preview request carries the truth.
    }
    if (!stopped) timer = setTimeout(() => void tick(), 750);
  };
  let timer = setTimeout(() => void tick(), 250);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export async function commitStreamedIntake(
  caseId: string,
  sessionId: string,
  previewToken: string,
  idempotencyKey: string,
): Promise<unknown> {
  const response = await protectedApiFetch(
    `/api/cases/${caseId}/corpus-intake/sessions/${sessionId}/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaId: CORPUS_STREAM_COMMIT_SCHEMA_ID,
        previewToken,
        idempotencyKey,
      }),
    },
  );
  if (!response.ok) throw await readIntakeError(response);
  return response.json();
}

export async function cancelStreamedIntake(caseId: string, sessionId: string): Promise<void> {
  await protectedApiFetch(`/api/cases/${caseId}/corpus-intake/sessions/${sessionId}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

export async function loadStreamedIntake(
  caseId: string,
  sessionId: string,
): Promise<CorpusIntakeSessionV1 | null> {
  try {
    const response = await protectedApiFetch(
      `/api/cases/${caseId}/corpus-intake/sessions/${sessionId}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as CorpusIntakeSessionV1;
  } catch {
    return null;
  }
}

const RESUME_KEY = "contextdesk:corpus-intake-session";

/**
 * Remember an in-flight session across a reload.
 *
 * The browser cannot keep the picked files, so a resumed session asks for the
 * same selection again and continues from the bytes the server already holds.
 * That is a smaller ask than starting a large upload over.
 */
export function rememberIntakeSession(caseId: string, sessionId: string): void {
  try {
    globalThis.sessionStorage?.setItem(RESUME_KEY, JSON.stringify({ caseId, sessionId }));
  } catch {
    // Private windows and blocked storage are ordinary; resume is a convenience.
  }
}

export function forgetIntakeSession(): void {
  try {
    globalThis.sessionStorage?.removeItem(RESUME_KEY);
  } catch {
    // See rememberIntakeSession.
  }
}

export function recallIntakeSession(caseId: string): string | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(RESUME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { caseId?: unknown; sessionId?: unknown };
    if (parsed.caseId !== caseId || typeof parsed.sessionId !== "string") return null;
    return parsed.sessionId;
  } catch {
    return null;
  }
}
