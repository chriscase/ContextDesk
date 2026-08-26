/**
 * Investigation-scoped Log workbench.
 *
 * Timestamp resolution stays in the log-time host. This service authorizes,
 * bounds search over committed intake bytes, persists views/bookmarks, and
 * re-resolves locators without leaking private filenames to unauthorized
 * callers.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  HOST_TIMESTAMP_OVERLAY_LIMITS,
  HostTimestampOverlayCancelledError,
  WORKBENCH_BOOKMARK_SCHEMA_ID,
  WORKBENCH_LIMITS,
  WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
  WORKBENCH_VIEW_SCHEMA_ID,
  applyHostTimestampsChunked,
  chronologyAnchorKey,
  extractShapeCandidates,
  groupReviewQueue,
  mergeChronology,
  pageLogLines,
  parseWorkbenchBookmark,
  parseWorkbenchReviewRule,
  parseWorkbenchSearchRequest,
  parseWorkbenchShareSafeLocator,
  parseWorkbenchView,
  previewReviewRule,
  privacySafeNotFound,
  resolveLocatorAgainstEvidence,
  rotationFamilyOf,
  searchLogLines,
  splitLogText,
  workbenchShareSafeToken,
  type ChronologyAnchorStatus,
  type HostEventStampV1,
  type OverlayAbortLike,
  type PrivacyClass,
  type WorkbenchBookmarkV1,
  type WorkbenchChronologyV1,
  type WorkbenchLine,
  type WorkbenchLocatorResolveV1,
  type WorkbenchPageV1,
  type WorkbenchReviewPreviewV1,
  type WorkbenchSearchResultV1,
  type WorkbenchViewV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor } from "../cases/index.js";
import type { WorkbenchStore } from "./store.js";

export class WorkbenchNotFoundError extends Error {
  constructor(message = "not_found") {
    super(message);
    this.name = "WorkbenchNotFoundError";
  }
}

export class WorkbenchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchConflictError";
  }
}

/** The caller went away before the read finished; nothing was produced. */
export class WorkbenchCancelledError extends Error {
  constructor(message = "read cancelled") {
    super(message);
    this.name = "WorkbenchCancelledError";
  }
}

/**
 * Host stamps together with the corpus revision they were read at.
 *
 * The revision travels with the stamps rather than being read separately,
 * because the overlay describes exactly one revision of the host corpus. A
 * revision sampled at some other moment could describe a different one, and a
 * reader that reported it would be claiming a timeline the rows do not have.
 */
export interface WorkbenchHostStamps {
  corpusRevision: number;
  stamps: HostEventStampV1[];
}

/** Per-request controls for a bounded corpus read. */
export interface WorkbenchReadOptions {
  /** Abandons the read, whole, once the caller has stopped waiting. */
  signal?: OverlayAbortLike;
}

export interface WorkbenchEvidenceFile {
  evidenceId: string;
  relativePath: string;
  digest: string;
  intakeBatchId: string | null;
  privacyClass: PrivacyClass;
  text: string;
}

export interface WorkbenchCasePort {
  getCase(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string } | null>;
  listEvidenceFiles(caseId: string): Promise<WorkbenchEvidenceFile[]>;
  currentNormalizationRevision(caseId: string): Promise<number | null>;
  listHostEventStamps?(caseId: string): Promise<WorkbenchHostStamps | null>;
  casePrivacyClass(caseId: string): Promise<PrivacyClass>;
  appendTimeline(
    caseId: string,
    event: {
      kind: string;
      actor: Actor;
      targetId: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<unknown>;
}

/** Bounded read of an investigation's intake bytes, with what it left unread. */
export interface WorkbenchCorpus {
  lines: WorkbenchLine[];
  /** True when the read limit stopped before the corpus ended. */
  truncated: boolean;
  /** Evidence ids whose every line was read. */
  fullyRead: Set<string>;
  /** Paths that were cut short or never reached, in intake order. */
  partiallyRead: string[];
  /**
   * The normalization revision these rows actually reflect. When the host
   * supplied stamps this is the revision the host reported alongside them, so
   * a caller reporting it is describing the timeline it really returned.
   */
  normalizationRevision: number | null;
}

export interface WorkbenchServiceDeps {
  store: WorkbenchStore;
  cases: WorkbenchCasePort;
  audit: AuditStore;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function decodeText(text: string): string {
  return text.split("\0").join("");
}

export class WorkbenchService {
  constructor(private readonly deps: WorkbenchServiceDeps) {}

  async assertReadable(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<void> {
    const found = await this.deps.cases.getCase(caseId, actor, isAdmin);
    if (!found) throw new WorkbenchNotFoundError();
  }

  /**
   * Read the investigation's intake bytes up to the bounded work limit.
   *
   * The limit is real, so the result says where it stopped. Callers must carry
   * `truncated` into whatever they return: a search that silently dropped the
   * tail of a corpus and then reports "no matches" is worse than one that
   * admits it did not read to the end.
   *
   * The host timestamp overlay runs cooperatively. It is the one unbounded-ish
   * piece of work on this path, so it yields the event loop on a fixed cadence
   * and stops outright if the caller has gone away — an abandoned read must not
   * keep spending the box's only thread on nobody's behalf.
   */
  async loadCorpus(
    caseId: string,
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchCorpus> {
    const files = await this.deps.cases.listEvidenceFiles(caseId);
    const lines: WorkbenchLine[] = [];
    const fullyRead = new Set<string>();
    const partiallyRead: string[] = [];
    let work = 0;
    let truncated = false;
    for (const file of files) {
      if (truncated) {
        partiallyRead.push(file.relativePath);
        continue;
      }
      const rows = splitLogText(
        file.evidenceId,
        file.relativePath,
        file.digest,
        decodeText(file.text),
        file.intakeBatchId,
      );
      let taken = 0;
      for (const row of rows) {
        if (work >= WORKBENCH_LIMITS.maxSearchWorkLines) {
          truncated = true;
          break;
        }
        work += 1;
        taken += 1;
        lines.push(row);
      }
      if (taken < rows.length) {
        truncated = true;
        partiallyRead.push(file.relativePath);
      } else {
        fullyRead.add(file.evidenceId);
      }
    }
    const host = (await this.deps.cases.listHostEventStamps?.(caseId)) ?? null;
    let stamped = lines;
    if (host !== null && host.stamps.length > 0) {
      try {
        stamped = await applyHostTimestampsChunked(lines, host.stamps, {
          chunkLines: HOST_TIMESTAMP_OVERLAY_LIMITS.defaultChunkLines,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (error instanceof HostTimestampOverlayCancelledError) {
          throw new WorkbenchCancelledError();
        }
        throw error;
      }
    }
    // With no host corpus there is no overlay and no host revision to bind to,
    // so the durable record is the only honest answer.
    const normalizationRevision =
      host !== null
        ? host.corpusRevision
        : await this.deps.cases.currentNormalizationRevision(caseId);
    return { lines: stamped, truncated, fullyRead, partiallyRead, normalizationRevision };
  }

  async loadLines(
    caseId: string,
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchLine[]> {
    return (await this.loadCorpus(caseId, options)).lines;
  }

  /**
   * Refuse a read whose rows do not describe the revision the caller asked for.
   *
   * The cheap pre-check that guards the request happens before the corpus is
   * read; this is the check after it, against the revision the returned rows
   * actually reflect. Without it a zone applied mid-read could hand back rows
   * from one revision under the banner of another.
   */
  private assertRevisionUnmoved(
    expected: number | null,
    observed: number | null,
  ): void {
    if (expected === null) return;
    if ((observed ?? 0) === expected) return;
    throw new WorkbenchConflictError(
      `stale normalization revision: expected ${expected}, current ${observed ?? "none"}`,
    );
  }

  async inventory(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    options: WorkbenchReadOptions = {},
  ): Promise<{
    items: {
      evidenceId: string;
      relativePath: string;
      rotationFamily: string;
      displayLabel: string;
      digest: string;
      intakeBatchId: string | null;
      privacyClass: PrivacyClass;
      lineCount: number;
      /** False when the read limit stopped before this file's last line. */
      fullyRead: boolean;
    }[];
    normalizationRevision: number | null;
    /** True when this investigation has more lines than one read can cover. */
    corpusTruncated: boolean;
    /** Files the read limit cut short or never reached, by display name. */
    unreadFiles: string[];
  }> {
    await this.assertReadable(caseId, actor, isAdmin);
    const files = await this.deps.cases.listEvidenceFiles(caseId);
    const corpus = await this.loadCorpus(caseId, options);
    const counts = new Map<string, number>();
    for (const line of corpus.lines) {
      counts.set(line.evidenceId, (counts.get(line.evidenceId) ?? 0) + 1);
    }
    return {
      items: files.map((file) => ({
        evidenceId: file.evidenceId,
        relativePath: file.relativePath,
        rotationFamily: rotationFamilyOf(file.relativePath),
        displayLabel: file.relativePath.split("/").pop() || file.relativePath,
        digest: file.digest,
        intakeBatchId: file.intakeBatchId,
        privacyClass: file.privacyClass,
        lineCount: counts.get(file.evidenceId) ?? 0,
        fullyRead: corpus.fullyRead.has(file.evidenceId),
      })),
      normalizationRevision: corpus.normalizationRevision,
      corpusTruncated: corpus.truncated,
      unreadFiles: corpus.partiallyRead.map((path) => path.split("/").pop() || path),
    };
  }

  async search(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchSearchResultV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const request = parseWorkbenchSearchRequest(
      body && typeof body === "object" && "schemaId" in (body as object)
        ? body
        : { schemaId: WORKBENCH_SEARCH_REQUEST_SCHEMA_ID, ...(body as object) },
    );
    const current = await this.deps.cases.currentNormalizationRevision(caseId);
    this.assertRevisionUnmoved(request.expectedNormalizationRevision, current);
    const corpus = await this.loadCorpus(caseId, options);
    this.assertRevisionUnmoved(
      request.expectedNormalizationRevision,
      corpus.normalizationRevision,
    );
    return searchLogLines(
      corpus.lines,
      { ...request, expectedNormalizationRevision: corpus.normalizationRevision },
      { corpusTruncated: corpus.truncated },
    );
  }

  async page(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    evidenceId: string,
    startLine: number,
    limit: number,
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchPageV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const corpus = await this.loadCorpus(caseId, options);
    const owned = corpus.lines.filter((line) => line.evidenceId === evidenceId);
    if (owned.length === 0) {
      if (corpus.truncated) {
        throw new WorkbenchConflictError(
          "This investigation holds more log lines than one read can cover, so this file was not reached. Narrow the selected files and try again.",
        );
      }
      throw new WorkbenchNotFoundError();
    }
    return pageLogLines(owned, evidenceId, startLine, limit);
  }

  async chronology(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    grouping: WorkbenchChronologyV1["grouping"],
    evidenceIds: string[],
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchChronologyV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const corpus = await this.loadCorpus(caseId, options);
    const current = corpus.normalizationRevision;
    let lines = corpus.lines;
    if (evidenceIds.length > 0) {
      lines = lines.filter((line) => evidenceIds.includes(line.evidenceId));
    }
    const anchors = new Map(
      (await this.deps.store.listAnchors(caseId)).map((row) => [
        chronologyAnchorKey(row.evidenceId, row.lineNumber),
        row.status,
      ]),
    );
    return mergeChronology(lines, grouping, current, anchors, {
      corpusTruncated: corpus.truncated,
    });
  }

  async pinChronologyAnchor(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    input: {
      evidenceId: string;
      lineNumber: number;
      status: ChronologyAnchorStatus;
      note: string;
      idempotencyKey: string;
    },
  ) {
    await this.assertReadable(caseId, actor, isAdmin);
    if (input.status === "human_ground_truth" && !input.note.trim()) {
      throw new WorkbenchConflictError(
        "human ground truth requires a recorded note from a person",
      );
    }
    return this.deps.store.withCaseLock(caseId, async () => {
      const existing = await this.deps.store.getAnchorByIdempotency(
        caseId,
        input.idempotencyKey,
      );
      if (existing) return existing;
      const row = {
        id: randomUUID(),
        caseId,
        evidenceId: input.evidenceId,
        lineNumber: input.lineNumber,
        status: input.status,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
      };
      await this.deps.store.insertAnchor(row);
      await this.deps.cases.appendTimeline(caseId, {
        kind: "log_workbench_anchor_pinned",
        actor,
        targetId: row.id,
        payload: { status: input.status, lineNumber: input.lineNumber },
      });
      return row;
    });
  }

  async reviewQueue(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    options: WorkbenchReadOptions = {},
  ) {
    await this.assertReadable(caseId, actor, isAdmin);
    const corpus = await this.loadCorpus(caseId, options);
    const candidates = extractShapeCandidates(corpus.lines).filter(
      (item) => item.parseClass === "local_ambiguous" || item.parseClass === "date_only",
    );
    return {
      groups: groupReviewQueue(candidates),
      candidateCount: candidates.length,
      normalizationRevision: corpus.normalizationRevision,
    };
  }

  async previewRule(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
    options: WorkbenchReadOptions = {},
  ): Promise<WorkbenchReviewPreviewV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const rule = parseWorkbenchReviewRule(body);
    const current = await this.deps.cases.currentNormalizationRevision(caseId);
    this.assertRevisionUnmoved(rule.expectedRevision, current);
    const files = await this.deps.cases.listEvidenceFiles(caseId);
    const corpus = await this.loadCorpus(caseId, options);
    this.assertRevisionUnmoved(rule.expectedRevision, corpus.normalizationRevision);
    const byId = new Map(corpus.lines.map((line) => [line.evidenceId, line]));
    return previewReviewRule(
      rule,
      files.map((file) => ({
        evidenceId: file.evidenceId,
        relativePath: file.relativePath,
        rotationFamily: rotationFamilyOf(file.relativePath),
        parseClass: byId.get(file.evidenceId)?.parseClass ?? "missing",
      })),
    );
  }

  async saveView(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
  ): Promise<WorkbenchViewV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const draft = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const createdAt = new Date().toISOString();
    const id = typeof draft.id === "string" && draft.id ? draft.id : randomUUID();
    const privacyClass = await this.deps.cases.casePrivacyClass(caseId);
    const document = parseWorkbenchView({
      schemaId: WORKBENCH_VIEW_SCHEMA_ID,
      id,
      investigationId: caseId,
      name: draft.name,
      filters: draft.filters,
      query: draft.query ?? "",
      mode: draft.mode ?? "case_insensitive",
      selectedPanes: draft.selectedPanes,
      timeFrom: draft.timeFrom ?? null,
      timeTo: draft.timeTo ?? null,
      sort: draft.sort ?? "ingest_order",
      grouping: draft.grouping ?? "none",
      display: draft.display ?? {
        syncScroll: true,
        wrap: false,
        lineNumbers: true,
        displayTimezone: "UTC",
      },
      contextBefore: draft.contextBefore ?? 1,
      contextAfter: draft.contextAfter ?? 1,
      privacyClass,
      idempotencyKey: draft.idempotencyKey,
      createdAt,
      createdBy: actor.id,
      replayed: false,
    });
    const requestDigest = digestOf({
      name: document.name,
      filters: document.filters,
      query: document.query,
      mode: document.mode,
      selectedPanes: document.selectedPanes,
      timeFrom: document.timeFrom,
      timeTo: document.timeTo,
      sort: document.sort,
      grouping: document.grouping,
      display: document.display,
    });
    return this.deps.store.withCaseLock(caseId, async () => {
      const existing = await this.deps.store.getViewByIdempotency(
        caseId,
        document.idempotencyKey,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new WorkbenchConflictError("idempotency key reused with a different view");
        }
        return parseWorkbenchView({
          ...JSON.parse(existing.payloadJson),
          replayed: true,
        });
      }
      const row = {
        id: document.id,
        caseId,
        name: document.name,
        payloadJson: JSON.stringify({ ...document, replayed: false }),
        idempotencyKey: document.idempotencyKey,
        requestDigest,
        privacyClass,
        createdAt: document.createdAt,
        createdBy: actor.id,
      };
      await this.deps.store.insertView(row);
      await this.deps.cases.appendTimeline(caseId, {
        kind: "log_workbench_view_saved",
        actor,
        targetId: document.id,
        payload: { name: document.name },
      });
      return document;
    });
  }

  async listViews(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<WorkbenchViewV1[]> {
    await this.assertReadable(caseId, actor, isAdmin);
    const rows = await this.deps.store.listViews(caseId);
    return rows.map((row) => parseWorkbenchView(JSON.parse(row.payloadJson)));
  }

  async saveBookmark(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
  ): Promise<WorkbenchBookmarkV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const draft = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const locator = draft.locator as WorkbenchBookmarkV1["locator"];
    const createdAt = new Date().toISOString();
    const id = typeof draft.id === "string" && draft.id ? draft.id : randomUUID();
    const privacyClass = await this.deps.cases.casePrivacyClass(caseId);
    const shareSafeToken = workbenchShareSafeToken(caseId, locator);
    const lines = await this.loadLines(caseId);
    const fileLines = lines.filter((line) => line.evidenceId === locator.evidenceId);
    const currentLine = fileLines.find((line) => line.lineNumber === locator.lineNumber);
    const status = resolveLocatorAgainstEvidence(locator, currentLine
      ? {
          digest: currentLine.digest,
          lineNumber: currentLine.lineNumber,
          byteOffset: currentLine.byteOffset,
          lineCount: fileLines.length,
        }
      : null);
    const document = parseWorkbenchBookmark({
      schemaId: WORKBENCH_BOOKMARK_SCHEMA_ID,
      id,
      investigationId: caseId,
      locator,
      shareSafeToken,
      note: typeof draft.note === "string" ? draft.note : "",
      status: status.status,
      staleReason: status.staleReason,
      privacyClass,
      idempotencyKey: draft.idempotencyKey,
      createdAt,
      createdBy: actor.id,
      replayed: false,
    });
    const requestDigest = digestOf({
      locator: document.locator,
      note: document.note,
    });
    return this.deps.store.withCaseLock(caseId, async () => {
      const existing = await this.deps.store.getBookmarkByIdempotency(
        caseId,
        document.idempotencyKey,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new WorkbenchConflictError("idempotency key reused with a different bookmark");
        }
        return parseWorkbenchBookmark({
          ...JSON.parse(existing.payloadJson),
          replayed: true,
        });
      }
      await this.deps.store.insertBookmark({
        id: document.id,
        caseId,
        evidenceId: document.locator.evidenceId,
        payloadJson: JSON.stringify({ ...document, replayed: false }),
        shareSafeToken: document.shareSafeToken,
        idempotencyKey: document.idempotencyKey,
        requestDigest,
        privacyClass,
        createdAt: document.createdAt,
        createdBy: actor.id,
      });
      await this.deps.cases.appendTimeline(caseId, {
        kind: "log_workbench_bookmark_added",
        actor,
        targetId: document.id,
        payload: { evidenceId: document.locator.evidenceId },
      });
      return document;
    });
  }

  async listBookmarks(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<WorkbenchBookmarkV1[]> {
    await this.assertReadable(caseId, actor, isAdmin);
    const rows = await this.deps.store.listBookmarks(caseId);
    const lines = await this.loadLines(caseId);
    return rows.map((row) => {
      const stored = parseWorkbenchBookmark(JSON.parse(row.payloadJson));
      const fileLines = lines.filter((line) => line.evidenceId === stored.locator.evidenceId);
      const currentLine = fileLines.find((line) => line.lineNumber === stored.locator.lineNumber);
      const status = resolveLocatorAgainstEvidence(stored.locator, currentLine
        ? {
            digest: currentLine.digest,
            lineNumber: currentLine.lineNumber,
            byteOffset: currentLine.byteOffset,
            lineCount: fileLines.length,
          }
        : null);
      return parseWorkbenchBookmark({
        ...stored,
        status: status.status,
        staleReason: status.staleReason,
      });
    });
  }

  async resolveLocator(
    tokenBody: unknown,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<WorkbenchLocatorResolveV1> {
    let token: string;
    try {
      token = parseWorkbenchShareSafeLocator(tokenBody).token;
    } catch {
      return privacySafeNotFound();
    }
    const row = await this.deps.store.getBookmarkByToken(token);
    if (!row) return privacySafeNotFound();
    const readable = await this.deps.cases.getCase(row.caseId, actor, isAdmin);
    if (!readable) return privacySafeNotFound();
    const stored = parseWorkbenchBookmark(JSON.parse(row.payloadJson));
    const lines = await this.loadLines(row.caseId);
    const fileLines = lines.filter((line) => line.evidenceId === stored.locator.evidenceId);
    const currentLine = fileLines.find((line) => line.lineNumber === stored.locator.lineNumber);
    const status = resolveLocatorAgainstEvidence(stored.locator, currentLine
      ? {
          digest: currentLine.digest,
          lineNumber: currentLine.lineNumber,
          byteOffset: currentLine.byteOffset,
          lineCount: fileLines.length,
        }
      : null);
    if (status.status !== "resolved") {
      return {
        schemaId: "cd-collab.log_workbench_locator_resolve.v1",
        found: true,
        status: status.status,
        staleReason: status.staleReason,
        relativePath: currentLine?.relativePath ?? null,
        lineNumber: stored.locator.lineNumber,
        investigationId: row.caseId,
      };
    }
    return {
      schemaId: "cd-collab.log_workbench_locator_resolve.v1",
      found: true,
      status: "resolved",
      staleReason: null,
      relativePath: currentLine?.relativePath ?? null,
      lineNumber: stored.locator.lineNumber,
      investigationId: row.caseId,
    };
  }
}
