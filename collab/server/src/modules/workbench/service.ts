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
  WORKBENCH_BOOKMARK_SCHEMA_ID,
  WORKBENCH_LIMITS,
  WORKBENCH_PAGE_CURSOR_VERSION,
  WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
  WORKBENCH_VIEW_SCHEMA_ID,
  chronologyAnchorKey,
  countLogTextLines,
  createHostTimestampOverlay,
  createLogSearchScan,
  decodeWorkbenchPageCursor,
  encodeWorkbenchPageCursor,
  extractShapeCandidates,
  fileInScope,
  groupReviewQueue,
  iterateLogLineWindows,
  mergeChronology,
  pageLogLines,
  parseWorkbenchBookmark,
  parseWorkbenchReviewRule,
  parseWorkbenchSearchRequest,
  parseWorkbenchSearchResult,
  parseWorkbenchShareSafeLocator,
  parseWorkbenchView,
  previewReviewRule,
  privacySafeNotFound,
  resolveLocatorAgainstEvidence,
  rotationFamilyOf,
  scopeFromSearchFilters,
  workbenchCorpusScopeDigest,
  workbenchShareSafeToken,
  type ChronologyAnchorStatus,
  type HostEventStampV1,
  type HostTimestampOverlay,
  type PrivacyClass,
  type WorkbenchBookmarkV1,
  type WorkbenchChronologyV1,
  type WorkbenchCorpusScope,
  type WorkbenchLine,
  type WorkbenchLocatorResolveV1,
  type WorkbenchPageV1,
  type WorkbenchReviewPreviewV1,
  type WorkbenchSearchRequestV1,
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

/** One intake file's identity, without its bytes. */
export interface WorkbenchEvidenceDescriptor {
  evidenceId: string;
  relativePath: string;
  digest: string;
  intakeBatchId: string | null;
  privacyClass: PrivacyClass;
}

export interface WorkbenchEvidenceFile extends WorkbenchEvidenceDescriptor {
  text: string;
}

/** What the workbench asks the timestamp authority for. */
export interface WorkbenchHostSearchInput {
  query: string;
  mode: "literal" | "case_insensitive" | "regex";
  /** Relative paths already narrowed to the caller's selection. */
  sources: string[];
  timeFrom: number | null;
  timeTo: number | null;
  k: number;
}

export interface WorkbenchHostSearchOutcome {
  corpusRevision: number;
  stamps: HostEventStampV1[];
  /** True when the host answered from a bounded slice of its corpus. */
  bounded: boolean;
  atLeast: number;
  cancelled: boolean;
  diagnostic: string | null;
}

export interface WorkbenchCasePort {
  getCase(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string } | null>;
  /**
   * Whole-corpus read including bytes.
   *
   * Kept for callers written against the first port and for small fixtures.
   * Anything corpus-sized must go through `listEvidenceDescriptors` plus
   * `readEvidenceText`, because this method materializes every file at once.
   */
  listEvidenceFiles(caseId: string): Promise<WorkbenchEvidenceFile[]>;
  /** Metadata only, so a selection can be applied before any byte is read. */
  listEvidenceDescriptors?(caseId: string): Promise<WorkbenchEvidenceDescriptor[]>;
  /** One file's bytes, fetched only once that file is known to be in scope. */
  readEvidenceText?(caseId: string, evidenceId: string): Promise<string | null>;
  /**
   * Host stamps for the normalization overlay, narrowed to the paths in scope.
   * Older implementations ignore the extra arguments and answer for the case.
   */
  listHostEventStamps?(
    caseId: string,
    sources?: string[],
    k?: number,
  ): Promise<HostEventStampV1[] | null>;
  /**
   * The shipped log-time host's own search. Returns null when this case has no
   * built corpus; throws when the host cannot be reached at all.
   */
  hostSearch?(
    caseId: string,
    input: WorkbenchHostSearchInput,
  ): Promise<WorkbenchHostSearchOutcome | null>;
  currentNormalizationRevision(caseId: string): Promise<number | null>;
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
}

/**
 * One operation's view of the investigation's files: which are in scope, in
 * what order, and how to fetch one file's bytes when its turn comes.
 */
interface ScopedCorpus {
  files: WorkbenchEvidenceDescriptor[];
  /** Every file in the case, in scope or not. */
  allFiles: WorkbenchEvidenceDescriptor[];
  scopeDigest: string;
  read(evidenceId: string): Promise<string | null>;
}

/**
 * Total order over intake files.
 *
 * Locale collation is not a total order — it can call two distinct paths equal
 * and reorder them between machines — and a resume cursor that names position
 * N is only meaningful if N is the same file on every request.
 */
function compareDescriptors(
  left: WorkbenchEvidenceDescriptor,
  right: WorkbenchEvidenceDescriptor,
): number {
  if (left.relativePath !== right.relativePath) {
    return left.relativePath < right.relativePath ? -1 : 1;
  }
  if (left.evidenceId === right.evidenceId) return 0;
  return left.evidenceId < right.evidenceId ? -1 : 1;
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

/** Every file in the investigation; the default for surfaces with no selection. */
const EMPTY_SCOPE: WorkbenchCorpusScope = {
  evidenceIds: [],
  file: null,
  rotationFamily: null,
};

/** Bound on how many host events one overlay fetch may pull back. */
const HOST_STAMP_LIMIT = 2_000;

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

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Resolve which files an operation may read, before reading any of them.
   *
   * Scope first is the whole point. Applying a selection *after* a read budget
   * was already spent is what let a selected file sit unread behind files the
   * responder never asked for, and then told them to select fewer files.
   */
  private async openCorpus(
    caseId: string,
    scope: WorkbenchCorpusScope,
  ): Promise<ScopedCorpus> {
    const port = this.deps.cases;
    if (port.listEvidenceDescriptors && port.readEvidenceText) {
      const all = (await port.listEvidenceDescriptors(caseId)).slice().sort(compareDescriptors);
      const files = all.filter((file) => fileInScope(scope, file));
      return {
        allFiles: all,
        files,
        scopeDigest: workbenchCorpusScopeDigest(files),
        read: async (evidenceId) => {
          const text = await port.readEvidenceText!(caseId, evidenceId);
          return text === null ? null : decodeText(text);
        },
      };
    }
    // Compatibility path for ports written against the first contract. It
    // materializes every file, so it is only sound for small corpora; the
    // shipped port implements the streaming methods above.
    const loaded = (await port.listEvidenceFiles(caseId)).slice().sort(compareDescriptors);
    const byId = new Map(loaded.map((file) => [file.evidenceId, file.text]));
    const all = loaded.map(({ text: _text, ...rest }) => rest);
    const files = all.filter((file) => fileInScope(scope, file));
    return {
      allFiles: all,
      files,
      scopeDigest: workbenchCorpusScopeDigest(files),
      read: async (evidenceId) => {
        const text = byId.get(evidenceId);
        return text === undefined ? null : decodeText(text);
      },
    };
  }

  /** Host stamps for exactly the paths in scope, or an empty overlay. */
  private async overlayFor(
    caseId: string,
    files: readonly WorkbenchEvidenceDescriptor[],
  ): Promise<HostTimestampOverlay> {
    const stamps = await this.deps.cases.listHostEventStamps?.(
      caseId,
      files.map((file) => file.relativePath),
      HOST_STAMP_LIMIT,
    );
    return createHostTimestampOverlay(stamps ?? []);
  }

  /**
   * Read the investigation's intake bytes up to the bounded work limit.
   *
   * This materializes rows, so it stays bounded and says where it stopped.
   * Search and paging no longer use it: they stream. Surfaces that genuinely
   * need a whole-corpus projection (chronology, the review queue) still do,
   * and still carry `truncated` into what they return, because a projection
   * that silently dropped a tail and then reported nothing is worse than one
   * that admits it did not read to the end.
   */
  async loadCorpus(
    caseId: string,
    scope: WorkbenchCorpusScope = EMPTY_SCOPE,
  ): Promise<WorkbenchCorpus> {
    const corpus = await this.openCorpus(caseId, scope);
    const overlay = await this.overlayFor(caseId, corpus.files);
    const lines: WorkbenchLine[] = [];
    const fullyRead = new Set<string>();
    const partiallyRead: string[] = [];
    let work = 0;
    let truncated = false;
    for (const file of corpus.files) {
      if (truncated) {
        partiallyRead.push(file.relativePath);
        continue;
      }
      const text = await corpus.read(file.evidenceId);
      if (text === null) {
        truncated = true;
        partiallyRead.push(file.relativePath);
        continue;
      }
      let complete = true;
      for (const window of iterateLogLineWindows(file, text)) {
        const room = WORKBENCH_LIMITS.maxSearchWorkLines - work;
        if (room <= 0) {
          complete = false;
          break;
        }
        const taken = window.length <= room ? window : window.slice(0, room);
        for (const row of overlay.apply(taken)) lines.push(row);
        work += taken.length;
        if (taken.length < window.length) {
          complete = false;
          break;
        }
      }
      if (complete) fullyRead.add(file.evidenceId);
      else {
        truncated = true;
        partiallyRead.push(file.relativePath);
      }
    }
    return { lines, truncated, fullyRead, partiallyRead };
  }

  async loadLines(
    caseId: string,
    scope: WorkbenchCorpusScope = EMPTY_SCOPE,
  ): Promise<WorkbenchLine[]> {
    return (await this.loadCorpus(caseId, scope)).lines;
  }

  /**
   * Read one file's rows around a window, without touching any other file.
   *
   * Locator resolution and paging both want one line out of one file. Reading
   * the whole investigation to find it is what made a bookmark past the old
   * read boundary unresolvable.
   */
  private async readFileWindow(
    caseId: string,
    evidenceId: string,
    startLine: number,
    maxRows: number,
  ): Promise<{ rows: WorkbenchLine[]; lineCount: number; found: boolean }> {
    const corpus = await this.openCorpus(caseId, EMPTY_SCOPE);
    const file = corpus.allFiles.find((item) => item.evidenceId === evidenceId);
    if (!file) return { rows: [], lineCount: 0, found: false };
    const text = await corpus.read(evidenceId);
    if (text === null) return { rows: [], lineCount: 0, found: false };
    const overlay = await this.overlayFor(caseId, [file]);
    const rows: WorkbenchLine[] = [];
    for (const window of iterateLogLineWindows(file, text, { startLine })) {
      for (const row of overlay.apply(window)) {
        if (rows.length >= maxRows) break;
        rows.push(row);
      }
      if (rows.length >= maxRows) break;
    }
    return { rows, lineCount: countLogTextLines(text), found: true };
  }

  async inventory(caseId: string, actor: Actor, isAdmin: boolean): Promise<{
    items: {
      evidenceId: string;
      relativePath: string;
      rotationFamily: string;
      displayLabel: string;
      digest: string;
      intakeBatchId: string | null;
      privacyClass: PrivacyClass;
      lineCount: number;
      /** False when this file's bytes could not be read at all. */
      fullyRead: boolean;
    }[];
    normalizationRevision: number | null;
    /** True only when some file's bytes could not be read. */
    corpusTruncated: boolean;
    /** Files whose bytes are missing, by display name. */
    unreadFiles: string[];
  }> {
    await this.assertReadable(caseId, actor, isAdmin);
    const corpus = await this.openCorpus(caseId, EMPTY_SCOPE);
    const items: {
      evidenceId: string;
      relativePath: string;
      rotationFamily: string;
      displayLabel: string;
      digest: string;
      intakeBatchId: string | null;
      privacyClass: PrivacyClass;
      lineCount: number;
      fullyRead: boolean;
    }[] = [];
    const unreadFiles: string[] = [];
    for (const file of corpus.allFiles) {
      // One file's bytes at a time, counted and released. Nothing here builds
      // a row, so an inventory over a large corpus costs its bytes, not its
      // rows.
      const text = await corpus.read(file.evidenceId);
      const readable = text !== null;
      if (!readable) unreadFiles.push(file.relativePath.split("/").pop() || file.relativePath);
      items.push({
        evidenceId: file.evidenceId,
        relativePath: file.relativePath,
        rotationFamily: rotationFamilyOf(file.relativePath),
        displayLabel: file.relativePath.split("/").pop() || file.relativePath,
        digest: file.digest,
        intakeBatchId: file.intakeBatchId,
        privacyClass: file.privacyClass,
        lineCount: readable ? countLogTextLines(text) : 0,
        fullyRead: readable,
      });
    }
    return {
      items,
      normalizationRevision: await this.deps.cases.currentNormalizationRevision(caseId),
      corpusTruncated: unreadFiles.length > 0,
      unreadFiles,
    };
  }

  /**
   * Search the selected files, from the start or from where a page stopped.
   *
   * Reading is scoped, then streamed in bounded windows, then searched. Nothing
   * truncates the corpus before the filters are applied, and a page that spends
   * its work budget hands back the position it stopped at rather than a match
   * count that cannot express "stopped at line 50,000 having found nothing".
   */
  async search(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
    options: { cancelled?: () => boolean } = {},
  ): Promise<WorkbenchSearchResultV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const request: WorkbenchSearchRequestV1 = parseWorkbenchSearchRequest(
      body && typeof body === "object" && "schemaId" in (body as object)
        ? body
        : { schemaId: WORKBENCH_SEARCH_REQUEST_SCHEMA_ID, ...(body as object) },
    );
    const current = await this.deps.cases.currentNormalizationRevision(caseId);
    if (
      request.expectedNormalizationRevision !== null
      && (current ?? 0) !== request.expectedNormalizationRevision
    ) {
      throw new WorkbenchConflictError(
        `stale normalization revision: expected ${request.expectedNormalizationRevision}, current ${current ?? "none"}`,
      );
    }

    const scope = scopeFromSearchFilters(request.filters);
    const corpus = await this.openCorpus(caseId, scope);

    let resume: {
      matchOrdinal: number;
      scannedLines: number;
      evidenceId: string;
      lineNumber: number;
    } | null = null;
    if (request.pageCursor) {
      const cursor = decodeWorkbenchPageCursor(request.pageCursor);
      // A cursor names a position in one exact set of files at one exact
      // revision. Resuming it against a corpus that has since moved would read
      // a different line than the one the reader was promised, so it is
      // refused rather than approximated.
      if (cursor.scopeDigest !== corpus.scopeDigest) {
        throw new WorkbenchConflictError(
          "The selected files changed since this page was read, so continuing from here would skip lines. Run the search again from the start.",
        );
      }
      if ((cursor.normalizationRevision ?? 0) !== (current ?? 0)) {
        throw new WorkbenchConflictError(
          `stale normalization revision: expected ${cursor.normalizationRevision ?? "none"}, current ${current ?? "none"}`,
        );
      }
      if (!corpus.files.some((file) => file.evidenceId === cursor.evidenceId)) {
        throw new WorkbenchConflictError(
          "The file this page stopped in is no longer selected. Run the search again from the start.",
        );
      }
      resume = {
        matchOrdinal: cursor.matchOrdinal,
        scannedLines: cursor.scannedLines,
        evidenceId: cursor.evidenceId,
        lineNumber: cursor.lineNumber,
      };
    }

    const timeFilterApplied = Boolean(request.filters.timeFrom || request.filters.timeTo);
    let overlay: HostTimestampOverlay;
    let timeAuthorityUnavailableReason: string | null = null;
    let hostBounded = false;
    if (timeFilterApplied && this.deps.cases.hostSearch) {
      // The host owns timestamp resolution. A time range answered from intake
      // bytes alone would silently drop every line whose clock carries no
      // offset, so the authority is consulted or the range is refused.
      let outcome: WorkbenchHostSearchOutcome | null;
      try {
        outcome = await this.deps.cases.hostSearch(caseId, {
          query: request.query,
          mode: request.mode,
          sources: corpus.files.map((file) => file.relativePath),
          timeFrom: request.filters.timeFrom
            ? Math.floor(Date.parse(request.filters.timeFrom) / 1000)
            : null,
          timeTo: request.filters.timeTo
            ? Math.floor(Date.parse(request.filters.timeTo) / 1000)
            : null,
          k: HOST_STAMP_LIMIT,
        });
      } catch {
        throw new WorkbenchConflictError(
          "The timestamp authority could not be reached, so a time-filtered search cannot be answered. Remove the time range to search text, or try again once the log-time host is back.",
        );
      }
      if (outcome === null) {
        overlay = await this.overlayFor(caseId, corpus.files);
        timeAuthorityUnavailableReason =
          "This investigation has no built log corpus yet, so the time range was applied only to lines whose own timestamp already carries a UTC offset.";
      } else {
        overlay = createHostTimestampOverlay(outcome.stamps);
        hostBounded = outcome.bounded || outcome.cancelled;
      }
    } else {
      overlay = await this.overlayFor(caseId, corpus.files);
    }

    const scan = createLogSearchScan(request, {
      ...(options.cancelled ? { cancelled: options.cancelled } : {}),
      ...(resume ? { resume } : {}),
    });

    let unreadable = false;
    let stopped = false;
    const startIndex = resume
      ? corpus.files.findIndex((file) => file.evidenceId === resume!.evidenceId)
      : 0;
    for (let index = Math.max(0, startIndex); index < corpus.files.length; index += 1) {
      const file = corpus.files[index]!;
      const text = await corpus.read(file.evidenceId);
      if (text === null) {
        unreadable = true;
        break;
      }
      // A resumed file is opened a few lines early so the first match on this
      // page still shows the lines above it; the scan treats the lead-in as
      // context and never re-counts it.
      const startLine =
        resume && file.evidenceId === resume.evidenceId
          ? Math.max(1, resume.lineNumber - request.contextBefore)
          : 1;
      for (const window of iterateLogLineWindows(file, text, { startLine })) {
        if (!scan.feed(overlay.apply(window))) {
          stopped = true;
          break;
        }
      }
      scan.endFile();
      if (stopped) break;
    }
    if (!stopped && !unreadable) scan.markComplete();

    const result = scan.finish({
      scopeFileCount: corpus.files.length,
      corpusUnreadable: unreadable,
      timeAuthorityUnavailableReason,
      expectedNormalizationRevision: current,
      mintCursor: (point) =>
        encodeWorkbenchPageCursor({
          version: WORKBENCH_PAGE_CURSOR_VERSION,
          scopeDigest: corpus.scopeDigest,
          normalizationRevision: current,
          evidenceId: point.evidenceId,
          lineNumber: point.lineNumber,
          matchOrdinal: point.matchOrdinal,
          scannedLines: point.scannedLines,
        }),
    });
    // The host answering from a bounded slice makes this answer partial too,
    // whatever the local scan managed to cover.
    return hostBounded && !result.bounded
      ? parseWorkbenchSearchResult({ ...result, bounded: true })
      : result;
  }

  async page(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    evidenceId: string,
    startLine: number,
    limit: number,
  ): Promise<WorkbenchPageV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const windowLimit = Math.min(Math.max(limit, 1), WORKBENCH_LIMITS.maxPageRows);
    const start = Math.max(1, startLine);
    // One row past the window, so "are there more lines" is answered from the
    // file itself rather than from how much of the corpus a budget reached.
    const read = await this.readFileWindow(caseId, evidenceId, start, windowLimit + 1);
    if (!read.found) throw new WorkbenchNotFoundError();
    if (read.rows.length === 0 && start > read.lineCount) {
      throw new WorkbenchConflictError(
        `This file ends at line ${read.lineCount.toLocaleString()}, so there is nothing to show from line ${start.toLocaleString()}.`,
      );
    }
    return pageLogLines(read.rows, evidenceId, start, windowLimit);
  }

  async chronology(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    grouping: WorkbenchChronologyV1["grouping"],
    evidenceIds: string[],
  ): Promise<WorkbenchChronologyV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const current = await this.deps.cases.currentNormalizationRevision(caseId);
    // Narrowing the read to the selected files first means the work budget is
    // spent on what was asked for, not on files that get filtered out after.
    const corpus = await this.loadCorpus(caseId, {
      evidenceIds,
      file: null,
      rotationFamily: null,
    });
    const lines = corpus.lines;
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

  async reviewQueue(caseId: string, actor: Actor, isAdmin: boolean) {
    await this.assertReadable(caseId, actor, isAdmin);
    const lines = await this.loadLines(caseId);
    const candidates = extractShapeCandidates(lines).filter(
      (item) => item.parseClass === "local_ambiguous" || item.parseClass === "date_only",
    );
    return {
      groups: groupReviewQueue(candidates),
      candidateCount: candidates.length,
      normalizationRevision: await this.deps.cases.currentNormalizationRevision(caseId),
    };
  }

  async previewRule(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    body: unknown,
  ): Promise<WorkbenchReviewPreviewV1> {
    await this.assertReadable(caseId, actor, isAdmin);
    const rule = parseWorkbenchReviewRule(body);
    const current = await this.deps.cases.currentNormalizationRevision(caseId);
    if ((current ?? 0) !== rule.expectedRevision) {
      throw new WorkbenchConflictError(
        `stale normalization revision: expected ${rule.expectedRevision}, current ${current ?? "none"}`,
      );
    }
    const files = await this.deps.cases.listEvidenceFiles(caseId);
    const lines = await this.loadLines(caseId);
    const byId = new Map(lines.map((line) => [line.evidenceId, line]));
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
    const resolved = await this.resolveLocatorLine(caseId, locator);
    const status = resolveLocatorAgainstEvidence(locator, resolved.evidence);
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
    const stored = rows.map((row) => parseWorkbenchBookmark(JSON.parse(row.payloadJson)));
    // Bookmarks cluster on a handful of files. Reading each of those files
    // once, rather than once per bookmark, keeps a long list cheap without
    // ever holding more than one file.
    const corpus = await this.openCorpus(caseId, EMPTY_SCOPE);
    const byFile = new Map<string, { lineCount: number; lines: Map<number, WorkbenchLine> }>();
    for (const bookmark of stored) {
      const evidenceId = bookmark.locator.evidenceId;
      let entry = byFile.get(evidenceId);
      if (!entry) {
        const file = corpus.allFiles.find((item) => item.evidenceId === evidenceId);
        const text = file ? await corpus.read(evidenceId) : null;
        entry = { lineCount: text === null ? 0 : countLogTextLines(text), lines: new Map() };
        if (file && text !== null) {
          const wanted = new Set(
            stored
              .filter((item) => item.locator.evidenceId === evidenceId)
              .map((item) => item.locator.lineNumber),
          );
          const overlay = await this.overlayFor(caseId, [file]);
          for (const window of iterateLogLineWindows(file, text)) {
            for (const line of overlay.apply(window)) {
              if (wanted.has(line.lineNumber)) entry.lines.set(line.lineNumber, line);
            }
          }
        }
        byFile.set(evidenceId, entry);
      }
    }
    return stored.map((bookmark) => {
      const entry = byFile.get(bookmark.locator.evidenceId);
      const line = entry?.lines.get(bookmark.locator.lineNumber) ?? null;
      const status = resolveLocatorAgainstEvidence(bookmark.locator, line
        ? {
            digest: line.digest,
            lineNumber: line.lineNumber,
            byteOffset: line.byteOffset,
            lineCount: entry?.lineCount ?? 0,
          }
        : null);
      return parseWorkbenchBookmark({
        ...bookmark,
        status: status.status,
        staleReason: status.staleReason,
      });
    });
  }

  /**
   * Re-read exactly the line a locator names.
   *
   * A bookmark is resolved by reading its own file at its own line, so a
   * locator deep in a large investigation resolves as readily as one on the
   * first page. Resolving it out of a corpus-wide read is what made a
   * bookmark past the old read boundary look unresolvable.
   */
  private async resolveLocatorLine(
    caseId: string,
    locator: WorkbenchBookmarkV1["locator"],
  ): Promise<{
    line: WorkbenchLine | null;
    evidence: {
      digest: string;
      lineNumber: number;
      byteOffset: number;
      lineCount: number;
    } | null;
  }> {
    const read = await this.readFileWindow(
      caseId,
      locator.evidenceId,
      Math.max(1, locator.lineNumber),
      1,
    );
    const line = read.rows.find((row) => row.lineNumber === locator.lineNumber) ?? null;
    return {
      line,
      evidence: line
        ? {
            digest: line.digest,
            lineNumber: line.lineNumber,
            byteOffset: line.byteOffset,
            lineCount: read.lineCount,
          }
        : null,
    };
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
    const resolved = await this.resolveLocatorLine(row.caseId, stored.locator);
    const currentLine = resolved.line;
    const status = resolveLocatorAgainstEvidence(stored.locator, resolved.evidence);
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
