import { Readable } from "node:stream";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import {
  ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
  ARTIFACT_KINDS,
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  CASE_LIST_SCHEMA_ID,
  CASE_SEVERITIES,
  CASE_STATUSES,
  CONTRIBUTION_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  HYPOTHESIS_STATUSES,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  PRIVACY_CLASSES,
  PROVENANCE_SCHEMA_ID,
  SNAPSHOT_LIST_SCHEMA_ID,
  TIMELINE_SCHEMA_ID,
  isContributionIdempotencyKey,
  parseInvestigationLifecycleActionRequest,
  type ArtifactKind,
  type AuthErrorV1,
  type CaseSeverity,
  type CaseStatus,
  type HypothesisStatus,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import {
  resolutionDomainError,
  resolutionInputFrom,
} from "../resolutions/index.js";
import {
  CaseStoreCommitOutcomeUnknownError,
  ContributionConflictError,
  LifecycleActionRequiredError,
  LifecycleChangedError,
  LifecycleRefusedError,
  LegalHoldError,
  StatusChangedError,
  SituationConflictError,
  type Actor,
  type CaseService,
  type CaseSituationInput,
} from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function clientTimeInput(body: Record<string, unknown>):
  | { valid: true; value: string | undefined }
  | { valid: false } {
  if (!Object.prototype.hasOwnProperty.call(body, "clientTime")) {
    return { valid: true, value: undefined };
  }
  return typeof body.clientTime === "string"
    ? { valid: true, value: body.clientTime }
    : { valid: false };
}

/**
 * Occurrence fields as supplied. They are passed through verbatim; the
 * contract derives precision and zone from the text so the route cannot
 * become a second, laxer definition of a valid date.
 */
function occurrenceInput(body: Record<string, unknown>): {
  occurredAt?: unknown;
  occurredAtPrecision?: unknown;
  occurredAtZone?: unknown;
} {
  const input: { occurredAt?: unknown; occurredAtPrecision?: unknown; occurredAtZone?: unknown } =
    {};
  if (Object.prototype.hasOwnProperty.call(body, "occurredAt")) input.occurredAt = body.occurredAt;
  if (Object.prototype.hasOwnProperty.call(body, "occurredAtPrecision")) {
    input.occurredAtPrecision = body.occurredAtPrecision;
  }
  if (Object.prototype.hasOwnProperty.call(body, "occurredAtZone")) {
    input.occurredAtZone = body.occurredAtZone;
  }
  return input;
}

const SITUATION_KEYS = [
  "problemStatement",
  "affectedParties",
  "impact",
  "scope",
  "openQuestions",
  "investigationContext",
] as const;

function situationInput(body: Record<string, unknown>):
  | { valid: true; value: Partial<CaseSituationInput>; supplied: boolean }
  | { valid: false } {
  const value: Partial<CaseSituationInput> = {};
  let supplied = false;
  for (const key of SITUATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    supplied = true;
    const field = body[key];
    if (key === "openQuestions") {
      if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
        return { valid: false };
      }
      value.openQuestions = field;
    } else if (key === "investigationContext") {
      if (field !== null && (typeof field !== "object" || Array.isArray(field))) {
        return { valid: false };
      }
      value.investigationContext = field;
    } else {
      if (typeof field !== "string") return { valid: false };
      value[key] = field;
    }
  }
  return { valid: true, value, supplied };
}

function domainError(
  reply: { code: (status: number) => unknown },
  err: unknown,
) {
  if (err instanceof LifecycleChangedError) {
    void reply.code(409);
    return err.conflict;
  }
  if (err instanceof LifecycleActionRequiredError) {
    void reply.code(400);
    return {
      error: "lifecycle_action_required",
      investigationId: err.investigationId,
      action: err.action,
      endpoint: err.endpoint,
    };
  }
  if (err instanceof StatusChangedError) {
    void reply.code(409);
    return { error: "status_changed", currentStatus: err.currentStatus };
  }
  // A refused archive or restore is a conflict with recorded state, not a
  // malformed request. The reason travels with it so the surface can point at
  // the legal-hold control instead of printing an unexplained 400.
  if (err instanceof LifecycleRefusedError) {
    void reply.code(409);
    return {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
      error: "lifecycle_refused",
      investigationId: err.investigationId,
      action: err.action,
      reason: err.reason,
      detail: err.detail,
    };
  }
  if (err instanceof LegalHoldError) {
    void reply.code(409);
    return { error: "legal_hold" };
  }
  if (err instanceof SituationConflictError) {
    void reply.code(409);
    return { error: "situation_conflict", currentVersion: err.currentVersion };
  }
  if (err instanceof ContributionConflictError) {
    void reply.code(409);
    return err.currentRevision === undefined
      ? { error: "contribution_conflict" }
      : { error: "contribution_conflict", currentRevision: err.currentRevision };
  }
  if (err instanceof CaseStoreCommitOutcomeUnknownError) {
    void reply.code(503);
    return { error: "commit_outcome_unknown" };
  }
  if (err instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${err.path}: ${err.detail}` };
  }
  const message = err instanceof Error ? err.message : "invalid";
  if (
    message === "case not found" ||
    message === "contribution not found" ||
    message === "evidence not found" ||
    message === "snapshot not found"
  ) {
    void reply.code(404);
    return { error: "not_found" };
  }
  void reply.code(400);
  return { error: message };
}

async function requireCaseAccess(
  domain: CaseService,
  ctx: AuthorizedSession,
  caseId: string,
  reply: { code: (status: number) => unknown },
): Promise<boolean> {
  if (!ctx.has("investigation:read")) {
    void reply.code(403);
    return false;
  }
  if (!(await domain.getCase(caseId, ctx.actor, ctx.isAdmin))) {
    void reply.code(404);
    return false;
  }
  return true;
}

/**
 * Narrow read-only view of the experiments module: enough to surface each
 * experiment's accepted decision on the case board without a module cycle.
 */
export interface AcceptedDecisionSource {
  list(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<
    {
      decisions: { id: string; status: string; text: string; evidenceRefs: string[] }[];
      snapshotFingerprint?: string | null;
    }[]
  >;
}

export interface CaseRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  domain: CaseService;
  experiments?: AcceptedDecisionSource;
  maxUploadBytes: number;
  transferTimeoutMs?: number;
}

const STREAM_TEXT_FIELDS = new Set([
  "kind",
  "summary",
  "filename",
  "mediaType",
  "privacyClass",
  "expectedHash",
  "clientTime",
  "sourceId",
]);
const STREAM_ARTIFACT_KINDS = new Set(["log", "email", "attachment"]);
const AUTHENTICATED_TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;

class MultipartEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartEvidenceError";
  }
}

/** @internal Exported only so parser truncation flags have a non-vacuous unit oracle. */
export function assertMultipartTextFieldIntact(part: {
  fieldnameTruncated: boolean;
  valueTruncated: boolean;
}): void {
  if (part.fieldnameTruncated || part.valueTruncated) {
    throw new MultipartEvidenceError("multipart text field was truncated");
  }
}

interface TransferGuard {
  readonly signal: AbortSignal;
  abort(message: string): void;
  dispose(): void;
}

interface TransferEndpoint {
  once?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  destroy?: () => void;
  destroyed?: boolean;
  readableEnded?: boolean;
  writableEnded?: boolean;
  socket?: { destroy?: () => void };
}

function armTransferGuard(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): TransferGuard {
  const controller = new AbortController();
  const requestRaw = request.raw as TransferEndpoint;
  const replyRaw = reply.raw as TransferEndpoint;
  let disposed = false;
  const abort = (message: string): void => {
    if (!controller.signal.aborted) controller.abort(new Error(message));
  };
  const onRequestAborted = (): void => abort("evidence transfer aborted");
  const onRequestClose = (): void => {
    if (requestRaw.destroyed && !requestRaw.readableEnded) onRequestAborted();
  };
  const onReplyClose = (): void => {
    if (!replyRaw.writableEnded) onRequestAborted();
  };
  const terminate = (): void => {
    abort("evidence transfer timed out");
    requestRaw.destroy?.();
    replyRaw.destroy?.();
  };
  requestRaw.once?.("aborted", onRequestAborted);
  requestRaw.once?.("close", onRequestClose);
  replyRaw.once?.("close", onReplyClose);
  const timer = setTimeout(terminate, Math.max(1, timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    abort,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      requestRaw.off?.("aborted", onRequestAborted);
      requestRaw.off?.("close", onRequestClose);
      replyRaw.off?.("close", onReplyClose);
    },
  };
}

function throwIfTransferAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("evidence stream aborted");
}

function copyBoundedChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return Uint8Array.from(Buffer.from(chunk));
  if (chunk instanceof Uint8Array) return Uint8Array.from(chunk);
  throw new MultipartEvidenceError("multipart file chunk must be binary");
}

function rawMultipartChunkByteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  throw new MultipartEvidenceError("multipart file chunk must be binary");
}

function asAsyncByteSource(file: MultipartFile["file"] | undefined): AsyncIterable<unknown> {
  if (file && typeof (file as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    return file as AsyncIterable<unknown>;
  }
  throw new MultipartEvidenceError("multipart file stream is missing");
}

async function discardMultipartFile(part: MultipartFile, signal?: AbortSignal): Promise<void> {
  const file = part.file as Readable | undefined;
  if (!file || file.readableEnded || file.destroyed) return;
  try {
    if (typeof (file as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of file) {
        void chunk;
        if (signal?.aborted) break;
      }
    } else if (typeof file.resume === "function") {
      file.resume();
    }
  } catch {
    // File already ended or the parser rejected it.
  } finally {
    if (signal?.aborted && !file.destroyed && typeof file.destroy === "function") {
      file.destroy();
    }
  }
}

async function drainRemainingParts(
  parts: AsyncIterator<Multipart> | undefined,
  current?: MultipartFile | null,
  signal?: AbortSignal,
): Promise<void> {
  if (current) await discardMultipartFile(current, signal);
  if (!parts) return;
  try {
    for (;;) {
      const next = await parts.next();
      if (next.done) return;
      const part = next.value as Multipart;
      if (part.type === "file") await discardMultipartFile(part, signal);
    }
  } catch {
    // Best-effort drain of a rejected multipart body.
  }
}

function contentDispositionAttachment(filename: string | null): string {
  if (!filename) return "attachment";
  let fallback = "";
  let unicode = "";
  for (const char of filename) {
    const codePoint = char.codePointAt(0) ?? 0xfffd;
    unicode += codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : char;
    if (
      codePoint < 32
      || codePoint > 126
      || char === '"'
      || char === "\\"
    ) {
      fallback += "_";
    } else {
      fallback += char;
    }
  }
  const encoded = encodeURIComponent(unicode).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encoded}`;
}

function ifNoneMatchHits(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const weakValue = (value: string): string => value.replace(/^W\/[ \t]*/iu, "");
  const expected = weakValue(etag);
  const values = (Array.isArray(header) ? header : [header])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  return values.some((value) => value === "*" || weakValue(value) === expected);
}

function nextTransferChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  throwIfTransferAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error("evidence transfer aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(iterator.next()).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Evidence providers may expose a lazy async iterable directly or return one
 * from an async adapter. Normalize both shapes before sending the response so
 * provider wrappers cannot turn a valid catalog entry into a 500 at the
 * transport boundary. A synchronous iterable/iterator is accepted as a
 * compatibility seam for test and future provider adapters, but all emitted
 * chunks are still validated and copied by the transfer loop.
 */
async function openTransferIterator(
  handle: { bytes: () => unknown },
): Promise<AsyncIterator<Uint8Array>> {
  const source: unknown = await Promise.resolve(handle.bytes());
  if (source === null || (typeof source !== "object" && typeof source !== "function")) {
    throw new Error("evidence read handle did not return an iterable");
  }
  const record = source as {
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
    [Symbol.iterator]?: () => Iterator<Uint8Array>;
    next?: AsyncIterator<Uint8Array>["next"];
  };
  if (typeof record[Symbol.asyncIterator] === "function") {
    return record[Symbol.asyncIterator]!.call(record);
  }
  if (typeof record[Symbol.iterator] === "function") {
    const iterator = record[Symbol.iterator]!.call(record);
    return {
      next: async () => iterator.next(),
      return: async () => {
        if (typeof iterator.return === "function") iterator.return();
        return { done: true, value: undefined };
      },
    };
  }
  if (typeof record.next === "function") return record as AsyncIterator<Uint8Array>;
  throw new Error("evidence read handle did not return an iterator");
}

function releaseTransferIterator(iterator: AsyncIterator<Uint8Array>): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // A hostile iterator cannot postpone HTTP transfer cleanup.
  }
}

type ParsedBytesRange =
  | { kind: "absent" }
  | { kind: "unsatisfiable" }
  | { kind: "satisfiable"; start: number; end: number };

function parseInclusiveBytesRange(
  header: string | string[] | undefined,
  size: number,
): ParsedBytesRange {
  if (header === undefined) return { kind: "absent" };
  if (Array.isArray(header) || typeof header !== "string") {
    return { kind: "unsatisfiable" };
  }
  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return { kind: "unsatisfiable" };
  const spec = value.slice("bytes=".length);
  if (!spec || spec.includes(",") || spec.startsWith("-")) {
    return { kind: "unsatisfiable" };
  }
  const match = /^(\d+)-(\d+)?$/u.exec(spec);
  if (!match) return { kind: "unsatisfiable" };
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return { kind: "unsatisfiable" };
  const end = match[2] === undefined ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(end)) return { kind: "unsatisfiable" };
  if (size <= 0 || start > end || start >= size) return { kind: "unsatisfiable" };
  return { kind: "satisfiable", start, end: Math.min(end, size - 1) };
}

function applyContentHeaders(
  reply: FastifyReply,
  options: {
    status: number;
    etag: string;
    length: number;
    contentType: string;
    filename: string | null;
    contentRange?: string;
  },
): void {
  void reply.code(options.status);
  void reply.header("ETag", options.etag);
  void reply.header("Accept-Ranges", "bytes");
  void reply.header("Content-Length", String(options.length));
  void reply.header("Content-Type", options.contentType);
  void reply.header("Content-Disposition", contentDispositionAttachment(options.filename));
  void reply.header("Cache-Control", "no-store");
  void reply.header("X-Content-Type-Options", "nosniff");
  if (options.contentRange) {
    void reply.header("Content-Range", options.contentRange);
  }
}

function storageUnavailable(reply: FastifyReply): { error: "storage_unavailable" } {
  void reply.code(503);
  return { error: "storage_unavailable" };
}

function sizePolicyViolationMessage(err: unknown): string | undefined {
  if (err instanceof MultipartEvidenceError) return undefined;
  const message = err instanceof Error ? err.message : "invalid";
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  if (
    message === "evidence stream exceeded maxBytes"
    || message === "upload exceeds size cap"
    || /file too large|FST_REQ_FILE_TOO_LARGE|FST_ERR_CTP_BODY_TOO_LARGE/i.test(`${message} ${code}`)
  ) {
    return "upload exceeds size cap";
  }
  return undefined;
}

function isSizePolicyViolation(err: unknown): boolean {
  return sizePolicyViolationMessage(err) !== undefined;
}

function streamUploadError(
  reply: FastifyReply,
  err: unknown,
): ReturnType<typeof domainError> | { error: string } {
  if (err instanceof MultipartEvidenceError) {
    void reply.code(400);
    return { error: err.message };
  }
  const message = err instanceof Error ? err.message : "invalid";
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  if (/FST_FILES_LIMIT|FST_PARTS_LIMIT|FST_FIELDS_LIMIT/i.test(`${message} ${code}`)) {
    void reply.code(400);
    return { error: "exactly one file field named file is required" };
  }
  const sizePolicy = sizePolicyViolationMessage(err);
  if (sizePolicy) {
    void reply.code(413);
    return { error: sizePolicy };
  }
  if (/aborted/i.test(message)) {
    void reply.code(400);
    return { error: "upload_aborted" };
  }
  if (
    /evidence (blob|metadata)|failed verification|s3 evidence|hash verification failed after storage/i
      .test(message)
  ) {
    return storageUnavailable(reply);
  }
  return domainError(reply, err);
}

function destroyMultipartFileStream(part: MultipartFile | null | undefined): void {
  const file = part?.file as Readable | undefined;
  if (!file || file.destroyed || typeof file.destroy !== "function") return;
  file.destroy();
}

function closeRequestAfterSizePolicyReply(request: FastifyRequest, reply: FastifyReply): void {
  void reply.header("Connection", "close");
  const requestRaw = request.raw as TransferEndpoint;
  const replyRaw = reply.raw as TransferEndpoint;
  const terminate = (): void => {
    if (!requestRaw.destroyed) requestRaw.destroy?.();
    requestRaw.socket?.destroy?.();
  };
  if (replyRaw.writableEnded) {
    terminate();
    return;
  }
  replyRaw.once?.("finish", terminate);
}

/** @internal Exported only for abort/non-settling iterator regression coverage. */
export async function* multipartFileBytes(
  file: AsyncIterable<unknown>,
  signal: AbortSignal,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("upload exceeds size cap");
  }
  throwIfTransferAborted(signal);
  const iterator = file[Symbol.asyncIterator]();
  const readable = file as Readable & { truncated?: boolean };
  let rejectLimit: ((err: Error) => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    rejectLimit = reject;
  });
  void limit.catch(() => undefined);
  const onLimit = (): void => {
    rejectLimit?.(new Error("upload exceeds size cap"));
  };
  let rejectAbort: ((err: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = (): void => {
    const reason = signal.reason;
    rejectAbort?.(reason instanceof Error ? reason : new Error("evidence stream aborted"));
  };
  readable.once?.("limit", onLimit);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let received = 0;
  let iteratorDone = false;
  try {
    if (readable.truncated) throw new Error("upload exceeds size cap");
    for (;;) {
      throwIfTransferAborted(signal);
      if (readable.truncated) throw new Error("upload exceeds size cap");
      const next = await Promise.race([iterator.next(), limit, aborted]);
      if (next.done) {
        iteratorDone = true;
        if (readable.truncated) throw new Error("upload exceeds size cap");
        break;
      }
      throwIfTransferAborted(signal);
      const chunk = next.value;
      const chunkLength = rawMultipartChunkByteLength(chunk);
      const remaining = maxBytes - received;
      if (
        !Number.isSafeInteger(chunkLength)
        || chunkLength < 0
        || chunkLength > remaining
      ) {
        throw new Error("evidence stream exceeded maxBytes");
      }
      const bytes = copyBoundedChunk(chunk);
      if (bytes.byteLength > 0) {
        received += chunkLength;
        yield bytes;
      }
      if (readable.truncated) throw new Error("upload exceeds size cap");
    }
  } finally {
    readable.off?.("limit", onLimit);
    signal.removeEventListener("abort", onAbort);
    if (!iteratorDone && typeof iterator.return === "function") {
      try {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      } catch {
        // A hostile iterator cannot postpone HTTP rejection or transfer cleanup.
      }
    }
  }
}

export async function registerCaseRoutes(
  app: FastifyInstance,
  deps: CaseRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/activity", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const rawLimit = (request.query as { limit?: unknown }).limit;
    const parsedLimit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : 30;
    return {
      schemaId: "cd-collab.activity_feed.v1",
      activities: await deps.domain.listRecentActivity(ctx.actor, ctx.isAdmin, parsedLimit),
    };
  });

  app.get("/api/cases", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    return {
      schemaId: CASE_LIST_SCHEMA_ID,
      cases: await deps.domain.listCases(ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "case_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const title = str(body.title);
    if (!title) {
      void reply.code(400);
      return authError("forbidden");
    }
    const situation = situationInput(body);
    const suppliedClientTime = clientTimeInput(body);
    if (!situation.valid || !suppliedClientTime.valid) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: {
      title: string;
      severity?: CaseSeverity;
      clientTime?: string;
      problemStatement?: string;
      affectedParties?: string;
      impact?: string;
      scope?: string;
      openQuestions?: string[];
      investigationContext?: unknown;
      occurredAt?: unknown;
      occurredAtPrecision?: unknown;
      occurredAtZone?: unknown;
    } = { title, ...situation.value, ...occurrenceInput(body) };
    const severity = str(body.severity);
    if (severity && (CASE_SEVERITIES as readonly string[]).includes(severity)) {
      input.severity = severity as CaseSeverity;
    }
    if (suppliedClientTime.value !== undefined) input.clientTime = suppliedClientTime.value;
    try {
      return await deps.domain.createCase(ctx.actor, input, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    const found = await deps.domain.getCase(id, ctx.actor, ctx.isAdmin);
    if (!found) return { error: "not_found" };
    return found;
  });

  app.post("/api/cases/:id/status", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const status = str(body.status);
    const suppliedClientTime = clientTimeInput(body);
    if (!status || !(CASE_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    let resolution: unknown;
    try {
      resolution = resolutionInputFrom(body.resolution);
    } catch (err) {
      void reply.code(400);
      return { error: "invalid", detail: err instanceof Error ? err.message : "invalid" };
    }
    const options: {
      clientTime?: string;
      resolution?: unknown;
      expectedResolutionRevision?: number;
    } = {};
    if (suppliedClientTime.value !== undefined) options.clientTime = suppliedClientTime.value;
    if (resolution !== undefined) options.resolution = resolution;
    if (typeof body.expectedResolutionRevision === "number") {
      options.expectedResolutionRevision = body.expectedResolutionRevision;
    }
    try {
      return await deps.domain.setStatus(id, ctx.actor, status as CaseStatus, request.ip, options);
    } catch (err) {
      // A refused conclusive transition is not a generic 400: the caller needs
      // to know a resolution record is what is missing, so the UI can open the
      // right form instead of showing an unexplained failure.
      const mapped = resolutionDomainError(reply, err);
      if (mapped) return mapped;
      return domainError(reply, err);
    }
  });

  /**
   * What archiving or restoring this investigation would do, before anyone
   * commits to it.
   *
   * A surface that offers "Archive" without knowing a legal hold will refuse
   * it can only report the refusal after the click. A surface that offers
   * "Restore" without knowing where it lands has to describe the outcome
   * vaguely, or wrongly. Both answers are already derivable from recorded
   * state, so they are served rather than guessed.
   */
  app.get("/api/cases/:id/lifecycle", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    try {
      return await deps.domain.lifecycleFor(id);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/lifecycle", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    try {
      const body = parseInvestigationLifecycleActionRequest(request.body);
      if (body.investigationId !== id) {
        void reply.code(400);
        return {
          error: "invalid",
          detail: "$.investigationId: must match the path investigation id",
        };
      }
      return await deps.domain.applyLifecycleAction(body, ctx.actor, request.ip);
    } catch (err) {
      const mapped = resolutionDomainError(reply, err);
      if (mapped) return mapped;
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/occurred-at", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    try {
      return await deps.domain.setOccurredAt(
        id,
        ctx.actor,
        occurrenceInput(body),
        request.ip,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.patch("/api/cases/:id/situation", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const situation = situationInput(body);
    const suppliedClientTime = clientTimeInput(body);
    const expectedVersion = body.expectedVersion;
    if (
      !situation.valid
      || !situation.supplied
      || !suppliedClientTime.valid
      || !Number.isSafeInteger(expectedVersion)
      || (expectedVersion as number) < 0
    ) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.updateSituation(
        id,
        ctx.actor,
        situation.value,
        expectedVersion as number,
        request.ip,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/participants", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const identityId = str(body.identityId);
    const username = str(body.username);
    if (!identityId || !username) {
      void reply.code(400);
      return authError("forbidden");
    }
    try {
      return await deps.domain.addParticipant(
        id,
        ctx.actor,
        { identityId, username },
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/legal-hold", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("admin:system_config")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const legalHold = asRecord(request.body).legalHold === true;
    try {
      return await deps.domain.setLegalHold(id, ctx.actor, legalHold, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/timeline", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: TIMELINE_SCHEMA_ID,
      caseId: id,
      events: await deps.domain.listTimeline(id),
    };
  });

  app.get("/api/cases/:id/snapshots", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: SNAPSHOT_LIST_SCHEMA_ID,
      caseId: id,
      snapshots: await deps.domain.listSnapshots(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/snapshots", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    if (!Array.isArray(body.evidenceIds) || !body.evidenceIds.every((value) => typeof value === "string")) {
      void reply.code(400);
      return { error: "evidenceIds must be an array of strings" };
    }
    const visibility = str(body.visibility);
    const protocolVersion = str(body.protocolVersion);
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    try {
      return await deps.domain.createSnapshot(
        id,
        ctx.actor,
        {
          evidenceIds: body.evidenceIds,
          ...(visibility && (PRIVACY_CLASSES as readonly string[]).includes(visibility)
            ? { visibility: visibility as PrivacyClass }
            : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(suppliedClientTime.value === undefined
            ? {}
            : { clientTime: suppliedClientTime.value }),
        },
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/board", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    const query = request.query as { snapshotId?: string };
    try {
      let acceptedDecisions;
      if (deps.experiments) {
        const experiments = await deps.experiments.list(id, ctx.actor, ctx.isAdmin);
        acceptedDecisions = experiments.flatMap((experiment) => {
          const accepted = [...experiment.decisions]
            .reverse()
            .find((decision) => decision.status === "accepted");
          return accepted
            ? [{
              id: accepted.id,
              statement: accepted.text,
              evidenceRefs: accepted.evidenceRefs,
              ...(typeof experiment.snapshotFingerprint === "string"
                ? { snapshotFingerprint: experiment.snapshotFingerprint }
                : {}),
            }]
            : [];
        });
      }
      const board = await deps.domain.getCaseBoard(
        id,
        ctx.actor,
        ctx.isAdmin,
        query.snapshotId,
        acceptedDecisions,
      );
      return board ?? { error: "not_found" };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "contribution_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const kind = str(body.kind);
    const text = str(body.body);
    if (!kind || text === undefined) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: {
      kind: string;
      body: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      hypothesisStatus?: HypothesisStatus;
      hypothesisLinks?: unknown;
      sourceId?: string;
      idempotencyKey?: string;
    } = { kind, body: text };
    const privacy = str(body.privacyClass);
    if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
      input.privacyClass = privacy as PrivacyClass;
    }
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    if (suppliedClientTime.value !== undefined) input.clientTime = suppliedClientTime.value;
    const hypothesisStatus = str(body.hypothesisStatus);
    if (
      hypothesisStatus &&
      (HYPOTHESIS_STATUSES as readonly string[]).includes(hypothesisStatus)
    ) {
      input.hypothesisStatus = hypothesisStatus as HypothesisStatus;
    }
    if (Object.prototype.hasOwnProperty.call(body, "hypothesisLinks")) {
      input.hypothesisLinks = body.hypothesisLinks;
    }
    const sourceId = str(body.sourceId);
    if (sourceId) input.sourceId = sourceId;
    if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
      const idempotencyKey = str(body.idempotencyKey);
      if (idempotencyKey === undefined || !isContributionIdempotencyKey(idempotencyKey)) {
        void reply.code(400);
        return { error: "invalid contribution idempotency key" };
      }
      input.idempotencyKey = idempotencyKey;
    }
    try {
      return await deps.domain.addContribution(id, ctx.actor, input, request.ip);
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/contributions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: CONTRIBUTION_LIST_SCHEMA_ID,
      caseId: id,
      contributions: await deps.domain.listContributions(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/contributions/:cid/revisions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const text = str(body.body);
    const suppliedClientTime = clientTimeInput(body);
    if (text === undefined) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      void reply.code(400);
      return { error: "expectedRevision is required" };
    }
    try {
      return await deps.domain.reviseContribution(
        params.id,
        params.cid,
        ctx.actor,
        text,
        request.ip,
        expectedRevision,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/contributions/:cid/tombstone", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    try {
      return await deps.domain.tombstoneContribution(
        params.id,
        params.cid,
        ctx.actor,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/contributions/:cid/provenance", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    try {
      return {
        schemaId: PROVENANCE_SCHEMA_ID,
        contributionId: params.cid,
        revisions: await deps.domain.provenance(params.id, params.cid),
      };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/hypotheses/:cid/status", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; cid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const status = str(body.status);
    const suppliedClientTime = clientTimeInput(body);
    if (!status || !(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    const links = Object.prototype.hasOwnProperty.call(body, "links")
      ? body.links
      : [];
    try {
      return await deps.domain.setHypothesisStatus(
        params.id,
        params.cid,
        ctx.actor,
        status as HypothesisStatus,
        links,
        request.ip,
        suppliedClientTime.value,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post("/api/cases/:id/evidence", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const kind = str(body.kind);
    const summary = str(body.summary);
    if (!kind || !summary) {
      void reply.code(400);
      return authError("forbidden");
    }
    if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
      void reply.code(400);
      return authError("forbidden");
    }
    const raw = str(body.contentBase64);
    const evidence: {
      kind: ArtifactKind;
      summary: string;
      filename?: string;
      mediaType?: string;
      bytes?: Uint8Array;
      uri?: string;
      expectedHash?: string | null;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      sourceId?: string;
    } = { kind: kind as ArtifactKind, summary };
    const filename = str(body.filename);
    if (filename) evidence.filename = filename;
    const mediaType = str(body.mediaType);
    if (mediaType) evidence.mediaType = mediaType;
    if (raw) evidence.bytes = Uint8Array.from(Buffer.from(raw, "base64"));
    const uri = str(body.uri);
    if (uri) evidence.uri = uri;
    if (body.expectedHash === null) evidence.expectedHash = null;
    else {
      const expectedHash = str(body.expectedHash);
      if (expectedHash) evidence.expectedHash = expectedHash;
    }
    const privacy = str(body.privacyClass);
    if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
      evidence.privacyClass = privacy as PrivacyClass;
    }
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    if (suppliedClientTime.value !== undefined) evidence.clientTime = suppliedClientTime.value;
    const evidenceSource = str(body.sourceId);
    if (evidenceSource) evidence.sourceId = evidenceSource;
    try {
      const uploaded = await deps.domain.addEvidence(id, ctx.actor, evidence, request.ip);
      return {
        schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
        caseId: id,
        ...uploaded,
      };
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.post(
    "/api/cases/:id/evidence/stream",
    async (request, reply) => {
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return loaded.denied;
      const ctx = loaded.ctx;
      if (!ctx.has("investigation:write")) {
        void reply.code(403);
        return authError("forbidden");
      }
      const id = (request.params as { id: string }).id;
      if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
        return { error: "not_found" };
      }
      let parts: AsyncIterator<Multipart> | undefined;
      let filePart: MultipartFile | null = null;
      const transfer = armTransferGuard(
        request,
        reply,
        deps.transferTimeoutMs ?? AUTHENTICATED_TRANSFER_TIMEOUT_MS,
      );
      const signal = transfer.signal;
      try {
        parts = (
          request as FastifyRequest & { parts: () => AsyncIterator<Multipart> }
        ).parts();
        const fields: Record<string, string> = {};
        for (;;) {
          const next = await parts.next();
          if (next.done) break;
          const part = next.value as Multipart;
          if (part.type === "file") {
            if (Object.keys(fields).length === 0) {
              await discardMultipartFile(part, signal);
              throw new MultipartEvidenceError("multipart file must not appear first");
            }
            if (filePart) {
              await discardMultipartFile(part, signal);
              throw new MultipartEvidenceError("exactly one file field named file is required");
            }
            if (part.fieldname !== "file") {
              await discardMultipartFile(part, signal);
              throw new MultipartEvidenceError("file field must be named file");
            }
            filePart = part;
            break;
          }
          if (part.type !== "field") {
            throw new MultipartEvidenceError("malformed multipart part");
          }
          assertMultipartTextFieldIntact(part);
          if (!STREAM_TEXT_FIELDS.has(part.fieldname)) {
            throw new MultipartEvidenceError("unknown multipart field");
          }
          if (Object.prototype.hasOwnProperty.call(fields, part.fieldname)) {
            throw new MultipartEvidenceError("duplicate multipart field");
          }
          if (typeof part.value !== "string") {
            throw new MultipartEvidenceError("multipart text field must be a string");
          }
          fields[part.fieldname] = part.value;
        }
        if (!filePart) {
          throw new MultipartEvidenceError("exactly one file field named file is required");
        }
        const kind = fields.kind;
        const summary = fields.summary;
        if (!kind || !summary) {
          await discardMultipartFile(filePart, signal);
          throw new MultipartEvidenceError("kind and summary are required");
        }
        if (!STREAM_ARTIFACT_KINDS.has(kind)) {
          await discardMultipartFile(filePart, signal);
          throw new MultipartEvidenceError(
            kind === "file_server_ref"
              ? "streaming evidence does not accept file-server references"
              : "invalid",
          );
        }
        const evidence: {
          kind: ArtifactKind;
          summary: string;
          filename?: string;
          mediaType?: string;
          expectedHash?: string | null;
          privacyClass?: PrivacyClass;
          clientTime?: string;
          sourceId?: string;
        } = { kind: kind as ArtifactKind, summary };
        const nativeFilename = filePart.filename || undefined;
        const nativeMediaType = filePart.mimetype || undefined;
        if (fields.filename && nativeFilename && fields.filename !== nativeFilename) {
          throw new MultipartEvidenceError("multipart filename conflicts with file metadata");
        }
        if (fields.mediaType && nativeMediaType && fields.mediaType !== nativeMediaType) {
          throw new MultipartEvidenceError("multipart mediaType conflicts with file metadata");
        }
        const filename = fields.filename || nativeFilename;
        const mediaType = fields.mediaType || nativeMediaType;
        if (filename) evidence.filename = filename;
        if (mediaType) evidence.mediaType = mediaType;
        if (Object.prototype.hasOwnProperty.call(fields, "expectedHash") && fields.expectedHash) {
          evidence.expectedHash = fields.expectedHash;
        }
        const privacy = fields.privacyClass;
        if (privacy && (PRIVACY_CLASSES as readonly string[]).includes(privacy)) {
          evidence.privacyClass = privacy as PrivacyClass;
        }
        if (fields.clientTime !== undefined) evidence.clientTime = fields.clientTime;
        if (fields.sourceId) evidence.sourceId = fields.sourceId;

        async function* fileSource(): AsyncIterable<Uint8Array> {
          yield* multipartFileBytes(
            asAsyncByteSource(filePart!.file),
            signal,
            deps.maxUploadBytes,
          );
          if ((filePart!.file as { truncated?: boolean }).truncated) {
            throw new Error("upload exceeds size cap");
          }
          const trailing = await parts!.next();
          if (!trailing.done) {
            const extra = trailing.value as Multipart;
            if (extra.type === "file") await discardMultipartFile(extra, signal);
            throw new MultipartEvidenceError(
              extra.type === "file"
                ? "exactly one file field named file is required"
                : "unexpected trailing multipart field",
            );
          }
        }

        const uploaded = await deps.domain.addStreamedEvidence(
          id,
          ctx.actor,
          {
            ...evidence,
            source: fileSource(),
            maxBytes: deps.maxUploadBytes,
            signal,
          },
          request.ip,
        );
        return {
          schemaId: EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
          caseId: id,
          ...uploaded,
        };
      } catch (err) {
        if (isSizePolicyViolation(err)) {
          transfer.abort("upload exceeds size cap");
          destroyMultipartFileStream(filePart);
          closeRequestAfterSizePolicyReply(request, reply);
          return streamUploadError(reply, err);
        }
        await drainRemainingParts(parts, filePart, signal);
        if (typeof request.raw.resume === "function") request.raw.resume();
        return streamUploadError(reply, err);
      } finally {
        transfer.dispose();
      }
    },
  );

  app.get("/api/cases/:id/evidence", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: EVIDENCE_LIST_SCHEMA_ID,
      caseId: id,
      artifacts: await deps.domain.listArtifacts(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.get("/api/cases/:id/evidence/annotations", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    if (!(await requireCaseAccess(deps.domain, ctx, id, reply))) {
      return { error: "not_found" };
    }
    return {
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: id,
      annotations: await deps.domain.listArtifactAnnotations(
        id,
        ctx.actor,
        ctx.isAdmin,
        undefined,
        ctx.has("evidence:private:read"),
      ),
    };
  });

  app.get("/api/cases/:id/evidence/:eid/annotations", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    if (!(await deps.domain.getArtifact(params.id, params.eid))) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return {
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: params.id,
      annotations: await deps.domain.listArtifactAnnotations(
        params.id,
        ctx.actor,
        ctx.isAdmin,
        params.eid,
        ctx.has("evidence:private:read"),
      ),
    };
  });

  app.post("/api/cases/:id/evidence/:eid/annotations", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "artifact_annotation_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const text = str(body.body);
    if (text === undefined) {
      void reply.code(400);
      return { error: "body is required" };
    }
    const suppliedClientTime = clientTimeInput(body);
    if (!suppliedClientTime.valid) {
      void reply.code(400);
      return { error: "clientTime must be a string" };
    }
    const privacy = body.privacyClass;
    if (privacy !== undefined && (typeof privacy !== "string" || !(PRIVACY_CLASSES as readonly string[]).includes(privacy))) {
      void reply.code(400);
      return { error: "invalid privacyClass" };
    }
    const sourceId = body.sourceId;
    if (sourceId !== undefined && typeof sourceId !== "string") {
      void reply.code(400);
      return { error: "sourceId must be a string" };
    }
    try {
      return await deps.domain.addArtifactAnnotation(
        params.id,
        params.eid,
        ctx.actor,
        {
          body: text,
          ...(privacy === undefined ? {} : { privacyClass: privacy as PrivacyClass }),
          ...(suppliedClientTime.value === undefined ? {} : { clientTime: suppliedClientTime.value }),
          ...(sourceId === undefined ? {} : { sourceId }),
        },
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });

  app.get("/api/cases/:id/evidence/:eid", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    const found = await deps.domain.getArtifact(params.id, params.eid);
    if (!found) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return found;
  });

  app.get("/api/cases/:id/evidence/:eid/bytes", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return { error: "not_found" };
    }
    let result: Awaited<ReturnType<CaseService["getArtifactJsonBytes"]>>;
    try {
      result = await deps.domain.getArtifactJsonBytes(
        params.id,
        params.eid,
        ctx.actor,
        ctx.isAdmin,
        ctx.has("evidence:private:read"),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "case not found") {
        void reply.code(404);
        return { error: "not_found" };
      }
      return storageUnavailable(reply);
    }
    if (result.outcome === "not_found") {
      void reply.code(404);
      return { error: "not_found" };
    }
    if (result.outcome === "too_large") {
      void reply.code(400);
      return { error: "too_large_for_json_bytes" };
    }
    return { contentBase64: Buffer.from(result.bytes).toString("base64") };
  });

  const contentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
      const loaded = await sessionOf(request, reply);
      if ("denied" in loaded) return loaded.denied;
      const ctx = loaded.ctx;
      const params = request.params as { id: string; eid: string };
      if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
        return { error: "not_found" };
      }
      const artifact = await deps.domain.getReadableHeldArtifact(
        params.id,
        params.eid,
        ctx.actor,
        ctx.isAdmin,
        ctx.has("evidence:private:read"),
      );
      if (!artifact?.contentHash || artifact.byteLength === null) {
        void reply.code(404);
        return { error: "not_found" };
      }
      const transfer = armTransferGuard(
        request,
        reply,
        deps.transferTimeoutMs ?? AUTHENTICATED_TRANSFER_TIMEOUT_MS,
      );
      let meta;
      try {
        meta = await deps.domain.headEvidence(artifact.contentHash, transfer.signal);
      } catch {
        const aborted = transfer.signal.aborted;
        transfer.dispose();
        if (aborted) return;
        return storageUnavailable(reply);
      }
      if (transfer.signal.aborted) {
        transfer.dispose();
        return;
      }
      if (!meta || meta.byteLength !== artifact.byteLength || meta.hash !== artifact.contentHash) {
        transfer.dispose();
        return storageUnavailable(reply);
      }
      const etag = `"${artifact.contentHash}"`;
      if (ifNoneMatchHits(request.headers["if-none-match"], etag)) {
        transfer.dispose();
        void reply.code(304);
        void reply.header("ETag", etag);
        void reply.header("Accept-Ranges", "bytes");
        void reply.header("Cache-Control", "no-store");
        void reply.header("X-Content-Type-Options", "nosniff");
        return reply.send();
      }
      const size = artifact.byteLength;
      const range = parseInclusiveBytesRange(request.headers.range, size);
      if (range.kind === "unsatisfiable") {
        transfer.dispose();
        void reply.code(416);
        void reply.header("Accept-Ranges", "bytes");
        void reply.header("Content-Range", `bytes */${size}`);
        void reply.header("Cache-Control", "no-store");
        void reply.header("X-Content-Type-Options", "nosniff");
        return reply.send();
      }
      const start = range.kind === "satisfiable" ? range.start : 0;
      const end = range.kind === "satisfiable" ? range.end : Math.max(size - 1, 0);
      const length = size === 0 ? 0 : end - start + 1;
      const contentType = artifact.mediaType || "application/octet-stream";
      const representation = {
        status: range.kind === "satisfiable" ? 206 : 200,
        etag,
        length,
        contentType,
        filename: artifact.filename,
        ...(range.kind === "satisfiable"
          ? { contentRange: `bytes ${start}-${end}/${size}` }
          : {}),
      };
      if (request.method === "HEAD") {
        transfer.dispose();
        applyContentHeaders(reply, representation);
        return reply.send();
      }
      let handle: Awaited<ReturnType<CaseService["openEvidenceRead"]>>;
      try {
        handle = await deps.domain.openEvidenceRead(
          artifact.contentHash,
          range.kind === "satisfiable" ? { start, end } : undefined,
          transfer.signal,
        );
        throwIfTransferAborted(transfer.signal);
      } catch {
        const aborted = transfer.signal.aborted;
        transfer.dispose();
        if (aborted) return;
        return storageUnavailable(reply);
      }
      let iterator: AsyncIterator<Uint8Array>;
      try {
        iterator = await openTransferIterator(handle);
        throwIfTransferAborted(transfer.signal);
      } catch {
        const aborted = transfer.signal.aborted;
        transfer.dispose();
        if (aborted) return;
        return storageUnavailable(reply);
      }
      applyContentHeaders(reply, representation);
      const cancel = transfer.signal;
      async function* evidenceBytes(): AsyncIterable<Uint8Array> {
        let iteratorDone = false;
        try {
          for (;;) {
            if (cancel.aborted) break;
            const next = await nextTransferChunk(iterator, cancel);
            if (next.done) {
              iteratorDone = true;
              break;
            }
            const chunk = next.value;
            if (chunk && chunk.byteLength > 0) yield copyBoundedChunk(chunk);
          }
        } finally {
          transfer.dispose();
          if (!iteratorDone) releaseTransferIterator(iterator);
        }
      }
      const stream = Readable.from(evidenceBytes(), { objectMode: false });
      try {
        return reply.send(stream);
      } catch (error) {
        transfer.dispose();
        throw error;
      }
  };
  app.get(
    "/api/cases/:id/evidence/:eid/content",
    { exposeHeadRoute: false },
    contentHandler,
  );
  app.head("/api/cases/:id/evidence/:eid/content", contentHandler);

  app.post("/api/cases/:id/evidence/:eid/recheck", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    if (!(await requireCaseAccess(deps.domain, ctx, params.id, reply))) {
      return authError("forbidden");
    }
    try {
      return await deps.domain.recheckReference(
        params.id,
        params.eid,
        ctx.actor,
        request.ip,
      );
    } catch (err) {
      return domainError(reply, err);
    }
  });
}
