import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  ContractViolation,
  CORPUS_INTAKE_LIMITS,
  CORPUS_INTAKE_REPORT_SCHEMA_ID,
  CORPUS_STREAM_SESSION_SCHEMA_ID,
  corpusIntakeStagesFor,
  corpusIntakeUnknownsFor,
  parseCorpusIntakePreflightRequest,
  parseCorpusIntakeSessionCommitRequest,
  scanShareSafePrivacy,
  type CorpusAcceptedFileV1,
  type CorpusIntakeBatchV1,
  type CorpusIntakeLimitsV1,
  type CorpusIntakePreviewReportV1,
  type CorpusIntakeSessionV1,
  type CorpusIntakeStage,
  type CorpusRejectedFileV1,
} from "@cd-collab/contracts";
import type { Actor } from "../cases/index.js";
import { fileByteSource } from "./byte-source.js";
import { classifyStream } from "./classify-stream.js";
import {
  codeForRejection,
  intakeError,
  intakeErrorFromContractViolation,
  CorpusIntakeRequestError,
} from "./errors.js";
import { expandedBytesExceedLimit } from "./limits.js";
import { duplicateDigestFlags } from "./preview.js";
import { CorpusIntakeSpool } from "./spool.js";
import type { StagedCorpusEntry, StagedCorpusIntake } from "./staged.js";
import { ZipError } from "./zip-error.js";
import { CorpusIntakeCancelled, walkZip, type ZipBudget } from "./zip-walk.js";

/** How long an abandoned session keeps its spooled bytes before recovery reclaims them. */
export const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface CorpusIntakeSessionDeps {
  spool: CorpusIntakeSpool;
  limits?: CorpusIntakeLimitsV1;
  ttlMs?: number;
  now?: () => number;
  domain: {
    listCorpusDigests(caseId: string): Promise<Set<string>>;
    commitStagedCorpusIntake(
      caseId: string,
      actor: Actor,
      origin: string,
      input: StagedCorpusIntake,
    ): Promise<CorpusIntakeBatchV1>;
  };
}

/**
 * Cancellation intent for one session.
 *
 * Held separately from the running expansion because a cancel can land before
 * the expander has started, between two of its awaits, or after it finished.
 * A shared flag makes all three the same case; a flag owned by the expansion
 * would only cover the middle one.
 */
interface SessionControl {
  cancelled: boolean;
  expanding: boolean;
}

interface ExpansionState {
  control: SessionControl;
  session: CorpusIntakeSessionV1;
}

function emptyProgress(stage: CorpusIntakeStage, declaredBytes: number | null, at: string) {
  return {
    stage,
    determinate: declaredBytes !== null,
    uploadedBytes: 0,
    declaredBytes,
    expandedBytes: 0,
    expectedExpandedBytes: null,
    filesSeen: 0,
    filesAccepted: 0,
    filesRejected: 0,
    updatedAt: at,
  };
}

/**
 * Streamed intake sessions: preflight, bounded parts, expansion, commit.
 *
 * The service never holds a corpus. Parts stream to the spool as they arrive,
 * expansion reads them back one window at a time, and commit hands the
 * persistence path one staged member at a time. What it does hold — one
 * session record and one member's metadata — is bounded by the file-count
 * limit, not by the corpus size.
 */
export class CorpusIntakeSessionService {
  private readonly limits: CorpusIntakeLimitsV1;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly active = new Map<string, ExpansionState>();
  private readonly control = new Map<string, SessionControl>();

  constructor(private readonly deps: CorpusIntakeSessionDeps) {
    this.limits = deps.limits ?? CORPUS_INTAKE_LIMITS;
    this.ttlMs = deps.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  get configuredLimits(): CorpusIntakeLimitsV1 {
    return this.limits;
  }

  private controlFor(key: string): SessionControl {
    const existing = this.control.get(key);
    if (existing) return existing;
    const created: SessionControl = { cancelled: false, expanding: false };
    this.control.set(key, created);
    return created;
  }

  /**
   * Validate a declared selection and open a session for it.
   *
   * Nothing here trusts the client's numbers beyond refusing early on them; the
   * same ceilings are re-checked as bytes arrive and again as they expand. What
   * preflight buys the operator is knowing before a long upload that the
   * selection is admissible at all, and what will be checked when it lands.
   */
  async preflight(caseId: string, actor: Actor, raw: unknown): Promise<CorpusIntakeSessionV1> {
    let request;
    try {
      request = parseCorpusIntakePreflightRequest(raw, this.limits);
    } catch (error) {
      throw this.toRequestError(error);
    }
    if (
      request.privacyClass === "share_safe"
      && scanShareSafePrivacy({ sourceLabel: request.sourceLabel }).length > 0
    ) {
      throw intakeError(
        "privacy_gate_rejected",
        "The label for this upload is not safe to share. Rename it or keep the upload private.",
        { detail: "share-safe privacy gate rejected intake metadata" },
      );
    }
    const declaredBytes = request.parts.reduce((total, part) => total + part.declaredBytes, 0);
    const createdAt = new Date(this.now()).toISOString();
    const session: CorpusIntakeSessionV1 = {
      schemaId: CORPUS_STREAM_SESSION_SCHEMA_ID,
      sessionId: randomUUID(),
      caseId,
      origin: request.origin,
      sourceLabel: request.sourceLabel,
      privacyClass: request.privacyClass,
      idempotencyKey: request.idempotencyKey,
      state: "awaiting_bytes",
      createdAt,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      limits: this.limits,
      selection: {
        partCount: request.parts.length,
        declaredBytes,
        compressedBytes: request.origin === "zip" ? declaredBytes : null,
        expandedBytes: request.origin === "zip" ? null : declaredBytes,
      },
      stages: corpusIntakeStagesFor(request.origin),
      unknowns: corpusIntakeUnknownsFor(request.origin),
      parts: request.parts.map((part) => ({
        ...part,
        receivedBytes: 0,
        complete: false,
        digest: null,
      })),
      progress: emptyProgress("preflight", declaredBytes, createdAt),
      previewToken: null,
      batchId: null,
      failure: null,
    };
    await this.deps.spool.create(session);
    // Report actor identity in the audit trail the route writes, not here.
    void actor;
    return session;
  }

  private async load(caseId: string, sessionId: string): Promise<CorpusIntakeSessionV1> {
    const record = await this.deps.spool.read(caseId, sessionId);
    if (!record) {
      throw intakeError("session_not_found", "That intake session no longer exists.", {
        detail: "no spooled session for this investigation",
        status: 404,
      });
    }
    if (Date.parse(record.expiresAt) <= this.now()) {
      throw intakeError("session_expired", "This intake session expired. Start a new upload.", {
        detail: "session passed its expiry",
        status: 410,
      });
    }
    if (record.state === "cancelled" || await this.deps.spool.isCancelled(caseId, sessionId)) {
      throw intakeError("session_cancelled", "This intake session was cancelled.", {
        detail: "session was cancelled",
        status: 409,
      });
    }
    return record;
  }

  async status(caseId: string, sessionId: string): Promise<CorpusIntakeSessionV1> {
    const record = await this.deps.spool.read(caseId, sessionId);
    if (!record) {
      throw intakeError("session_not_found", "That intake session no longer exists.", {
        detail: "no spooled session for this investigation",
        status: 404,
      });
    }
    const live = this.active.get(`${caseId}/${sessionId}`);
    if (live) return { ...live.session, parts: record.parts };
    return record;
  }

  /**
   * Receive one bounded chunk of one part.
   *
   * Re-sending a range already held is not an error: an interrupted upload
   * resumes by rewriting from the offset the session reports, and a duplicate
   * request for a completed part settles to the same digest.
   */
  async receivePart(
    caseId: string,
    sessionId: string,
    index: number,
    offset: number,
    stream: AsyncIterable<Uint8Array>,
  ): Promise<CorpusIntakeSessionV1> {
    const session = await this.load(caseId, sessionId);
    if (session.state !== "awaiting_bytes") {
      throw intakeError(
        "session_state_invalid",
        "This session has already moved past uploading.",
        { detail: `session state is ${session.state}`, status: 409 },
      );
    }
    const part = session.parts.find((row) => row.index === index);
    if (!part) {
      throw intakeError("session_not_found", "That upload part is not part of this session.", {
        detail: `no declared part at index ${index}`,
        status: 404,
      });
    }
    const { receivedBytes } = await this.deps.spool.writePart(
      caseId,
      sessionId,
      index,
      offset,
      stream,
      { maxRequestBytes: this.limits.maxRequestBytes, declaredBytes: part.declaredBytes },
    );
    const complete = receivedBytes === part.declaredBytes;
    const digest = complete ? await this.deps.spool.partDigest(caseId, sessionId, index) : null;
    const parts = session.parts.map((row) =>
      row.index === index ? { ...row, receivedBytes, complete, digest } : row);
    const uploadedBytes = parts.reduce((total, row) => total + row.receivedBytes, 0);
    const next: CorpusIntakeSessionV1 = {
      ...session,
      parts,
      progress: {
        ...session.progress,
        stage: "upload",
        determinate: true,
        uploadedBytes,
        updatedAt: new Date(this.now()).toISOString(),
      },
    };
    await this.deps.spool.write(next);
    return next;
  }

  async cancel(caseId: string, sessionId: string): Promise<CorpusIntakeSessionV1> {
    const key = `${caseId}/${sessionId}`;
    const control = this.controlFor(key);
    control.cancelled = true;
    const record = await this.deps.spool.read(caseId, sessionId);
    if (!record) {
      this.control.delete(key);
      throw intakeError("session_not_found", "That intake session no longer exists.", {
        detail: "no spooled session for this investigation",
        status: 404,
      });
    }
    await this.deps.spool.markCancelled(caseId, sessionId);
    const cancelled: CorpusIntakeSessionV1 = {
      ...record,
      state: "cancelled",
      progress: { ...record.progress, updatedAt: new Date(this.now()).toISOString() },
    };
    // Keep the manifest so a status poll still explains what happened; the bytes
    // themselves go now, because a cancelled upload has no claim on the spool.
    await this.deps.spool.write(cancelled);
    // A running expansion owns the spool's bytes until it unwinds. Deleting
    // them underneath it would surface as an I/O failure rather than as the
    // cancellation the operator asked for, so let the expander clean up.
    if (!control.expanding) {
      await this.deps.spool.purgeBytes(caseId, sessionId);
      this.control.delete(key);
    }
    return cancelled;
  }

  /**
   * Expand, classify, and stage everything the session received.
   *
   * This is the long step, so it publishes progress as it goes and polls for
   * cancellation between members and between windows. A cancelled or failed
   * expansion leaves nothing addressable behind.
   */
  async expand(caseId: string, actor: Actor, sessionId: string): Promise<CorpusIntakePreviewReportV1> {
    const session = await this.load(caseId, sessionId);
    if (session.state === "previewed" && session.previewToken) {
      const stored = await this.readPreview(caseId, sessionId);
      if (stored) return stored;
    }
    if (session.state !== "awaiting_bytes" && session.state !== "previewed") {
      throw intakeError("session_state_invalid", "This session cannot be expanded now.", {
        detail: `session state is ${session.state}`,
        status: 409,
      });
    }
    const incomplete = session.parts.find((part) => !part.complete);
    if (incomplete) {
      throw intakeError(
        "part_incomplete",
        "Some selected files have not finished uploading yet.",
        {
          detail: `part ${incomplete.index} holds ${incomplete.receivedBytes} of ${incomplete.declaredBytes} bytes`,
          path: incomplete.relativePath,
          observed: incomplete.receivedBytes,
          limit: incomplete.declaredBytes,
          status: 409,
        },
      );
    }

    const key = `${caseId}/${sessionId}`;
    const control = this.controlFor(key);
    if (control.cancelled) {
      throw intakeError("session_cancelled", "This intake session was cancelled.", {
        detail: "session was cancelled",
        status: 409,
      });
    }
    control.expanding = true;
    const startedAt = this.now();
    const state: ExpansionState = {
      control,
      session: {
        ...session,
        state: "expanding",
        progress: {
          ...session.progress,
          stage: session.origin === "zip" ? "archive_index" : "classify",
          determinate: session.origin !== "zip",
          expectedExpandedBytes: session.selection.expandedBytes,
          updatedAt: new Date(startedAt).toISOString(),
        },
      },
    };
    this.active.set(key, state);
    const accepted: CorpusAcceptedFileV1[] = [];
    const rejected: CorpusRejectedFileV1[] = [];
    const entries: StagedCorpusEntry[] = [];
    const seenPaths = new Set<string>();
    const budget: ZipBudget = { expandedBytes: 0, fileCount: 0 };
    const poll = (): void => {
      if (control.cancelled) throw new CorpusIntakeCancelled();
      if (this.now() - startedAt > this.limits.maxExpansionMs) {
        throw new ZipError("processing_timeout", "expansion exceeded the configured time cap");
      }
    };
    const publish = (patch: Partial<CorpusIntakeSessionV1["progress"]>): void => {
      state.session = {
        ...state.session,
        progress: {
          ...state.session.progress,
          ...patch,
          updatedAt: new Date(this.now()).toISOString(),
        },
      };
    };

    const takeMember = async (
      relativePath: string,
      claimedMedia: string | undefined,
      bytes: AsyncIterable<Uint8Array>,
    ): Promise<void> => {
      poll();
      publish({ filesSeen: state.session.progress.filesSeen + 1 });
      const fold = relativePath.replace(/\\/g, "/").toLocaleLowerCase("en-US");
      if (seenPaths.has(fold)) {
        rejected.push({
          relativePath,
          reason: "duplicate_normalized_path",
          detail: "duplicate path in this batch",
        });
        publish({ filesRejected: state.session.progress.filesRejected + 1 });
        return;
      }
      const staged = await this.deps.spool.beginStagedMember(caseId, sessionId);
      let result;
      try {
        result = await classifyStream({
          relativePath,
          claimedMedia,
          privacyClass: session.privacyClass,
          limits: this.limits,
          bytes,
          poll,
          sink: async (chunk) => {
            // A ZIP member is charged against the expanded budget by the walker
            // as it inflates, so charging again here would halve the allowance.
            // A loose file has no walker, so this is where its bytes are counted.
            if (session.origin !== "zip") {
              if (expandedBytesExceedLimit(budget.expandedBytes, chunk.byteLength, this.limits)) {
                throw new ZipError("oversized_expanded", "expanded size exceeds cap");
              }
              budget.expandedBytes += chunk.byteLength;
            }
            await staged.write(chunk);
            publish({ expandedBytes: state.session.progress.expandedBytes + chunk.byteLength });
          },
        });
      } catch (error) {
        await staged.discard();
        throw error;
      }
      if (!result.ok) {
        await staged.discard();
        rejected.push({
          relativePath: result.relativePath,
          reason: result.reason,
          detail: result.detail,
        });
        publish({ filesRejected: state.session.progress.filesRejected + 1 });
        return;
      }
      seenPaths.add(fold);
      seenPaths.add(result.relativePath.toLocaleLowerCase("en-US"));
      await staged.keep(result.digest);
      entries.push({
        relativePath: result.relativePath,
        mediaType: result.mediaType,
        artifactKind: result.artifactKind,
        digest: result.digest,
        byteLength: result.byteLength,
        encodingStatus: result.encodingStatus,
      });
      accepted.push({
        relativePath: result.relativePath,
        mediaType: result.mediaType,
        artifactKind: result.artifactKind,
        byteLength: result.byteLength,
        digest: result.digest,
        duplicateDigest: false,
        encodingStatus: result.encodingStatus,
      });
      publish({ filesAccepted: state.session.progress.filesAccepted + 1 });
    };

    try {
      if (session.origin === "zip") {
        const part = session.parts[0]!;
        const handle = await this.deps.spool.openPart(caseId, sessionId, part.index);
        try {
          await walkZip(fileByteSource(handle, part.declaredBytes), {
            limits: this.limits,
            budget,
            checkDeadline: poll,
            isCancelled: () => control.cancelled,
            onArchiveIndexed: (info) => {
              if (info.depth !== 0) return;
              publish({
                stage: "expand",
                determinate: true,
                expectedExpandedBytes: info.declaredExpandedBytes,
              });
            },
            onRejected: (rejection) => {
              rejected.push(rejection);
              publish({ filesRejected: state.session.progress.filesRejected + 1 });
            },
            onMember: async (member, bytes) => {
              await takeMember(member.relativePath, undefined, bytes);
            },
            // A nested archive has to exist somewhere before it can be walked.
            // It spills to the session's own scratch space, is walked from
            // there, and is removed as the walk unwinds — its bytes are charged
            // to the expanded budget on the way in and its members again on the
            // way out, which is deliberately conservative.
            spill: (bytes, byteLength) =>
              this.deps.spool.spillNestedArchive(caseId, sessionId, bytes, byteLength),
          });
        } finally {
          await handle.close();
        }
      } else {
        publish({ stage: "classify", determinate: true });
        for (const part of session.parts) {
          poll();
          budget.fileCount += 1;
          if (budget.fileCount > this.limits.maxFileCount) {
            throw new ZipError("too_many_files", "file count exceeds cap");
          }
          const stream = this.deps.spool.partStream(caseId, sessionId, part.index);
          const chunks = (async function* () {
            for await (const chunk of stream) yield new Uint8Array(chunk as Buffer);
          })();
          await takeMember(
            part.relativePath,
            part.declaredMediaType || undefined,
            chunks,
          );
        }
      }
    } catch (error) {
      this.active.delete(key);
      control.expanding = false;
      // Once cancellation is requested, everything that follows is a symptom of
      // it — including an I/O error from bytes being torn down mid-write.
      const cause = control.cancelled ? new CorpusIntakeCancelled() : error;
      if (control.cancelled) this.control.delete(key);
      await this.failSession(caseId, sessionId, session, cause);
      throw this.toRequestError(cause);
    }

    publish({ stage: "stage_evidence" });
    const known = await this.deps.domain.listCorpusDigests(caseId);
    const flags = duplicateDigestFlags(entries.map((entry) => entry.digest), known);
    for (const [index, row] of accepted.entries()) row.duplicateDigest = flags[index] ?? false;

    const previewToken = this.sessionRequestDigest(session, actor);
    const report: CorpusIntakePreviewReportV1 = {
      schemaId: CORPUS_INTAKE_REPORT_SCHEMA_ID,
      caseId,
      origin: session.origin,
      previewToken,
      accepted,
      rejected,
      limits: this.limits,
    };
    const previewed: CorpusIntakeSessionV1 = {
      ...state.session,
      state: "previewed",
      selection: {
        ...session.selection,
        expandedBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
      },
      // Expansion resolved every fact preflight had to leave open.
      unknowns: [],
      previewToken,
      progress: {
        ...state.session.progress,
        stage: "commit",
        determinate: true,
        updatedAt: new Date(this.now()).toISOString(),
      },
    };
    this.active.delete(key);
    control.expanding = false;
    if (control.cancelled) {
      this.control.delete(key);
      await this.deps.spool.purgeBytes(caseId, sessionId);
      throw intakeError("session_cancelled", "This intake session was cancelled.", {
        detail: "cancelled during expansion",
        status: 409,
      });
    }
    await this.deps.spool.write(previewed);
    await this.writePreview(caseId, sessionId, report, entries);
    return report;
  }

  /**
   * Persist an accepted session.
   *
   * Bytes move from the spool into content-addressed evidence one member at a
   * time. Replaying the same idempotency key returns the original batch instead
   * of writing a second copy, which is what makes a retried commit safe.
   */
  async commit(
    caseId: string,
    actor: Actor,
    sessionId: string,
    raw: unknown,
    origin: string,
  ): Promise<CorpusIntakeBatchV1> {
    const session = await this.load(caseId, sessionId);
    const request = parseCorpusIntakeSessionCommitRequest(raw);
    if (session.state !== "previewed" || !session.previewToken) {
      throw intakeError("session_state_invalid", "Preview this intake before committing it.", {
        detail: `session state is ${session.state}`,
        status: 409,
      });
    }
    if (request.idempotencyKey !== session.idempotencyKey) {
      throw intakeError(
        "idempotency_conflict",
        "This commit used a different idempotency key than the session it names.",
        { detail: "idempotency key does not match the session", status: 409 },
      );
    }
    const expected = this.sessionRequestDigest(session, actor);
    if (request.previewToken !== expected || session.previewToken !== expected) {
      throw intakeError(
        "preflight_mismatch",
        "The selection changed after it was previewed. Preview it again before committing.",
        { detail: "preview token does not match the session content", status: 409 },
      );
    }
    const stored = await this.readPreviewEntries(caseId, sessionId);
    if (!stored) {
      throw intakeError("session_state_invalid", "This session's preview is no longer available.", {
        detail: "preview record is missing from the spool",
        status: 409,
      });
    }
    const batch = await this.deps.domain.commitStagedCorpusIntake(caseId, actor, origin, {
      origin: session.origin,
      sourceLabel: session.sourceLabel,
      privacyClass: session.privacyClass,
      idempotencyKey: session.idempotencyKey,
      requestDigest: expected,
      entries: stored.entries,
      rejected: stored.report.rejected,
      loadBytes: (digest) => this.deps.spool.readStaged(caseId, sessionId, digest),
    });
    await this.deps.spool.remove(caseId, sessionId);
    this.control.delete(`${caseId}/${sessionId}`);
    return batch;
  }

  /**
   * Stable identity for a session's content.
   *
   * Framed over the declared paths and the digests of the bytes actually
   * received, so it is computed without re-reading a single spooled byte and
   * changes the moment the selection does.
   */
  private sessionRequestDigest(session: CorpusIntakeSessionV1, actor: Actor): string {
    const hash = createHash("sha256");
    const framed = (value: string): void => {
      const bytes = Buffer.from(value, "utf8");
      hash.update(String(bytes.byteLength));
      hash.update(":");
      hash.update(bytes);
      hash.update(";");
    };
    for (const value of [
      session.caseId,
      actor.id,
      session.origin,
      session.sourceLabel,
      session.privacyClass,
      session.idempotencyKey,
    ]) framed(value);
    for (const part of session.parts) {
      framed(part.relativePath);
      framed(String(part.declaredBytes));
      framed(part.digest ?? "");
    }
    return hash.digest("hex");
  }

  private previewPath(caseId: string, sessionId: string): string {
    return `${this.deps.spool.paths(caseId, sessionId).session}/preview.json`;
  }

  private async writePreview(
    caseId: string,
    sessionId: string,
    report: CorpusIntakePreviewReportV1,
    entries: StagedCorpusEntry[],
  ): Promise<void> {
    await writeFile(this.previewPath(caseId, sessionId), JSON.stringify({ report, entries }), "utf8");
  }

  private async readPreviewEntries(
    caseId: string,
    sessionId: string,
  ): Promise<{ report: CorpusIntakePreviewReportV1; entries: StagedCorpusEntry[] } | null> {
    try {
      const raw = await readFile(this.previewPath(caseId, sessionId), "utf8");
      return JSON.parse(raw) as { report: CorpusIntakePreviewReportV1; entries: StagedCorpusEntry[] };
    } catch {
      return null;
    }
  }

  private async readPreview(
    caseId: string,
    sessionId: string,
  ): Promise<CorpusIntakePreviewReportV1 | null> {
    return (await this.readPreviewEntries(caseId, sessionId))?.report ?? null;
  }

  private async failSession(
    caseId: string,
    sessionId: string,
    session: CorpusIntakeSessionV1,
    error: unknown,
  ): Promise<void> {
    const failure = this.toRequestError(error).payload;
    if (failure.code === "session_cancelled") {
      await this.deps.spool.purgeBytes(caseId, sessionId);
      return;
    }
    // A failed session cannot be expanded or committed again, so its spooled
    // bytes have no further claim. The manifest stays so a status poll can say
    // what went wrong rather than answering not-found.
    await this.deps.spool.write({
      ...session,
      state: "failed",
      failure,
      progress: { ...session.progress, updatedAt: new Date(this.now()).toISOString() },
    });
    await this.deps.spool.purgeBytes(caseId, sessionId);
  }

  private toRequestError(error: unknown): CorpusIntakeRequestError {
    if (error instanceof CorpusIntakeRequestError) return error;
    if (error instanceof ContractViolation) return intakeErrorFromContractViolation(error);
    if (error instanceof CorpusIntakeCancelled) {
      return intakeError("session_cancelled", "This intake session was cancelled.", {
        detail: "cancelled during expansion",
        status: 409,
      });
    }
    if (error instanceof ZipError) {
      return intakeError(codeForRejection(error.reason), zipMessage(error), {
        detail: error.message,
        limit: zipLimit(error, this.limits),
      });
    }
    return intakeError("storage_unavailable", "The intake could not be completed.", {
      detail: error instanceof Error ? error.name : "unknown intake failure",
      retryable: true,
      status: 500,
    });
  }
}

function zipMessage(error: ZipError): string {
  switch (error.reason) {
    case "oversized_expanded":
      return "The expanded corpus is larger than this investigation accepts. Split it into smaller batches.";
    case "too_many_files":
      return "This selection holds more files than one intake accepts. Split it into smaller batches.";
    case "oversized_archive":
      return "This archive is larger than this investigation accepts.";
    case "processing_timeout":
      return "Expanding this corpus took longer than the configured limit. Split it into smaller batches.";
    case "file_too_large":
      return "A file in this corpus is larger than this investigation accepts.";
    default:
      return "This archive could not be read safely.";
  }
}

function zipLimit(error: ZipError, limits: CorpusIntakeLimitsV1): number | null {
  switch (error.reason) {
    case "oversized_expanded":
      return limits.maxExpandedBytes;
    case "too_many_files":
      return limits.maxFileCount;
    case "oversized_archive":
      return limits.maxArchiveBytes;
    case "processing_timeout":
      return limits.maxExpansionMs;
    case "file_too_large":
      return limits.maxFileBytes;
    default:
      return null;
  }
}
