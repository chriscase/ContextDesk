/**
 * War Room log-time review.
 *
 * The service owns the durable case-bound record and the honest accounting of
 * what a time change did to work already produced. It owns no timestamp logic:
 * every resolution decision comes from the host pipeline through
 * {@link LogTimeBridge}.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  LOG_CHRONOLOGY_LIMITS,
  LOG_CHRONOLOGY_PAGE_SCHEMA_ID,
  LOG_CORPUS_STATE_SCHEMA_ID,
  LOG_TIME_LIMITS,
  LOG_TIME_OUTCOME_SCHEMA_ID,
  LOG_TIME_PREVIEW_SCHEMA_ID,
  parseLogCorpusState,
  parseLogChronologyPage,
  parseLogChronologyQuery,
  parseLogTimeApplyRequest,
  parseLogTimeClearRequest,
  parseLogTimeOutcome,
  parseLogTimePreview,
  parseLogTimePreviewRequest,
  parseLogTimeUndoRequest,
  type LogCorpusStateV1,
  type LogChronologyPageV1,
  type LogTimeDeclarationV1,
  type LogTimeDependentDisposition,
  type LogTimeDependentV1,
  type LogTimeOperation,
  type LogTimeOutcomeV1,
  type LogTimePreviewV1,
  type LogTimeSampleV1,
  type PrivacyClass,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor } from "../cases/index.js";
import {
  LogTimeConflictError,
  LogTimeNotFoundError,
  LogTimeRequestError,
  type HostChronologyRow,
  type HostResult,
  type HostSearch,
  type LogTimeBridge,
} from "./bridge.js";
import type {
  LogCorpusRow,
  LogTimeDeclarationRow,
  LogTimeDependentRow,
  LogTimeStore,
} from "./store.js";

export { LogTimeConflictError, LogTimeNotFoundError, LogTimeRequestError };

/** Minimal view of a case the review surface needs. */
export interface LogTimeCasePort {
  getCase(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<{ id: string } | null>;
  listSnapshotsForCase(
    caseId: string,
  ): Promise<{ id: string; createdAt: string }[]>;
  listTriageRunsForCase(
    caseId: string,
  ): Promise<{ id: string; snapshotId: string | null; createdAt: string }[]>;
  listCorpusFilesForCase(
    caseId: string,
  ): Promise<{ relativePath: string; contentBase64: string }[]>;
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

export interface LogTimeServiceDeps {
  store: LogTimeStore;
  bridge: LogTimeBridge;
  cases: LogTimeCasePort;
  audit: AuditStore;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

const PLAIN_LANGUAGE = {
  snapshotRevised:
    "This frozen evidence set was captured while the corpus read time " +
    "differently. The files themselves have not changed; any timing you read " +
    "from it needs a fresh look.",
  snapshotUnknown:
    "This evidence set was frozen before the case had a log corpus, so there " +
    "is no record of which time basis it was read under. Treat its timings as " +
    "unverified rather than current.",
  snapshotUnaffected:
    "This evidence set was frozen under the time basis now in force.",
  runInvalidated:
    "This run answered against an evidence set whose time basis has since " +
    "moved, so its conclusions are no longer current.",
  runUnknown:
    "This run predates the case log corpus, so there is no record of the time " +
    "basis it answered under.",
  runUnaffected: "This run answered under the time basis now in force.",
} as const;

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertBounded(name: string, value: string, max: number): void {
  if (!value || value.length > max) {
    throw new LogTimeRequestError(`${name} is not a bounded value`);
  }
}

export class LogTimeService {
  private readonly now: () => Date;

  constructor(private readonly deps: LogTimeServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Current review state for one case.
   *
   * Counts come from the host so they always describe the corpus as it is now;
   * declaration provenance comes from the durable record, because the host
   * corpus does not know who declared a zone or which preview they saw.
   */
  /**
   * Bounded corpus events for the Log workbench overlay. Returns null when
   * this case has no host corpus yet — callers must keep intake-byte UTC
   * empty for local-ambiguous lines rather than inventing a zone.
   */
  async listWorkbenchEvents(
    caseId: string,
    sources: string[] = [],
    k = 2_000,
  ): Promise<{ corpusRevision: number; search: HostSearch } | null> {
    const corpus = await this.deps.store.getCorpus(caseId);
    if (!corpus) return null;
    const host = await this.deps.bridge.run(caseId, {
      kind: "events",
      corpusId: corpus.corpusId,
      expectedRevision: corpus.corpusRevision,
      sources,
      k,
    });
    if (!host.search) return { corpusRevision: host.corpusRevision, search: {
      bounded: false,
      atLeast: 0,
      returned: 0,
      partial: false,
      cancelled: false,
      diagnostic: null,
      hits: [],
    } };
    return { corpusRevision: host.corpusRevision, search: host.search };
  }

  /**
   * The host's own bounded search over the built corpus.
   *
   * The workbench searches intake bytes for text, but it is not the authority
   * on *when* a line happened: local clocks only become instants after a zone
   * is declared here. So a time-filtered workbench search asks the host, which
   * owns that resolution, instead of guessing from whichever lines happened to
   * carry an offset. Returns null when this case has no built corpus; a host
   * that cannot be reached throws, and the caller refuses the time range
   * rather than answering it from an unresolved overlay.
   */
  async searchWorkbench(
    caseId: string,
    input: {
      query: string;
      mode: "literal" | "case_insensitive" | "regex";
      sources?: string[];
      timeFrom?: number | null;
      timeTo?: number | null;
      k?: number;
    },
  ): Promise<{ corpusRevision: number; search: HostSearch } | null> {
    const corpus = await this.deps.store.getCorpus(caseId);
    if (!corpus) return null;
    const host = await this.deps.bridge.run(caseId, {
      kind: "search",
      corpusId: corpus.corpusId,
      expectedRevision: corpus.corpusRevision,
      query: input.query,
      mode: input.mode,
      caseSensitive: input.mode === "literal",
      k: Math.max(1, Math.min(input.k ?? 2_000, 2_000)),
      sources: input.sources ?? [],
      timeFrom: input.timeFrom ?? null,
      timeTo: input.timeTo ?? null,
    });
    return {
      corpusRevision: host.corpusRevision,
      search: host.search ?? {
        bounded: false,
        atLeast: 0,
        returned: 0,
        partial: false,
        cancelled: false,
        diagnostic: null,
        hits: [],
      },
    };
  }

  async getState(caseId: string): Promise<LogCorpusStateV1> {
    const corpus = await this.deps.store.getCorpus(caseId);
    if (!corpus) {
      return parseLogCorpusState({
        schemaId: LOG_CORPUS_STATE_SCHEMA_ID,
        caseId,
        corpusId: null,
        corpusRevision: 0,
        builtAt: null,
        privacyClass: await this.deps.cases.casePrivacyClass(caseId),
        sources: [],
        reviewOutstanding: false,
        undoableRevision: null,
      });
    }
    const host = await this.deps.bridge.run(caseId, {
      kind: "status",
      corpusId: corpus.corpusId,
    });
    return this.projectState(corpus, host);
  }

  /**
   * Read one cursor-paged chronology projection. The host owns timestamp
   * provenance and DST decisions; this layer only applies the wire contract
   * and keeps the returned message/source fields bounded.
   */
  async chronology(caseId: string, raw: unknown): Promise<LogChronologyPageV1> {
    const request = parseLogChronologyQuery(raw);
    const corpus = await this.requireCorpus(caseId);
    const host = await this.deps.bridge.run(caseId, {
      kind: "chronology",
      corpusId: corpus.corpusId,
      search: request.search,
      sources: request.sources,
      limit: request.limit,
      cursor: request.cursor,
    });
    const chronology = host.chronology;
    if (!chronology) throw new Error("log-time host returned no chronology page");

    const rows = chronology.rows
      .slice(0, LOG_CHRONOLOGY_LIMITS.maxPageRows)
      .map(toChronologyRow);
    return parseLogChronologyPage({
      schemaId: LOG_CHRONOLOGY_PAGE_SCHEMA_ID,
      caseId,
      corpusId: corpus.corpusId,
      corpusRevision: chronology.corpusRevision,
      search: request.search,
      sources: request.sources,
      rows,
      nextCursor: chronology.nextCursor,
      totalMatched: chronology.totalMatched,
      orderOnlyCount: chronology.orderOnlyCount,
      timeQuality: chronology.timeQuality,
    });
  }

  private async projectState(
    corpus: LogCorpusRow,
    host: HostResult,
  ): Promise<LogCorpusStateV1> {
    const declarations = await this.deps.store.listDeclarations(corpus.caseId);
    const bySource = new Map(declarations.map((row) => [row.source, row]));
    const sources = (host.sources ?? [])
      .slice(0, LOG_TIME_LIMITS.maxSources)
      .map((status) => {
        const stored = bySource.get(status.source);
        const live = host.declarations[status.source];
        // A declaration is only reported when the host still holds it. If the
        // durable record and the corpus disagree, the corpus wins: it is what
        // the timestamps actually reflect.
        const declaration: LogTimeDeclarationV1 | null =
          live && stored
            ? {
                source: status.source,
                ianaTimezone: live.ianaTimezone,
                basis: live.basis,
                declaredAt: live.declaredAt,
                appliedRevision: live.appliedRevision,
                declarationFingerprint: stored.declarationFingerprint,
                declaredBy: stored.declaredBy,
              }
            : null;
        return {
          source: status.source,
          unresolvedLocalRecords: status.unresolvedLocalRecords,
          resolvedLocalRecords: status.resolvedLocalRecords,
          explicitWallClockRecords: status.explicitWallClockRecords,
          otherOrderOnlyRecords: status.otherOrderOnlyRecords,
          declaration,
        };
      });

    const undoable =
      corpus.undoableRevision !== null &&
      corpus.undoableRevision < host.corpusRevision
        ? corpus.undoableRevision
        : null;

    return parseLogCorpusState({
      schemaId: LOG_CORPUS_STATE_SCHEMA_ID,
      caseId: corpus.caseId,
      corpusId: corpus.corpusId,
      corpusRevision: host.corpusRevision,
      builtAt: corpus.builtAt,
      privacyClass: corpus.privacyClass,
      sources,
      reviewOutstanding: sources.some((s) => s.unresolvedLocalRecords > 0),
      undoableRevision: undoable,
    });
  }

  /** Latest recorded disposition per dependent, for the review surface. */
  async listDependents(caseId: string): Promise<LogTimeDependentV1[]> {
    const rows = await this.deps.store.listLatestDependents(caseId);
    return rows.map(toDependent);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Build the durable case-bound corpus from evidence already committed to the
   * case. One corpus per case: rebuilding would silently discard the
   * declarations reviewers made against the old one.
   */
  async buildCorpus(caseId: string, actor: Actor): Promise<LogCorpusStateV1> {
    return this.deps.store.withCaseLock(caseId, async () => {
      const existing = await this.deps.store.getCorpus(caseId);
      if (existing) {
        throw new LogTimeConflictError("this case already has a log corpus");
      }
      const files = await this.deps.cases.listCorpusFilesForCase(caseId);
      if (files.length === 0) {
        throw new LogTimeRequestError(
          "this case has no committed log files to build a corpus from",
        );
      }
      const privacyClass = await this.deps.cases.casePrivacyClass(caseId);
      const corpusName = `case ${caseId} log corpus`;
      const host = await this.deps.bridge.run(caseId, {
        kind: "build",
        corpusName,
        files,
      });
      const builtAt = this.now().toISOString();
      await this.deps.store.insertCorpus({
        caseId,
        corpusId: host.corpusId,
        corpusName,
        privacyClass,
        corpusRevision: host.corpusRevision,
        undoableRevision: null,
        builtAt,
        builtBy: actor.id,
      });
      await this.deps.audit.append({
        identity: actor.id,
        action: "log_corpus_build",
        target: caseId,
        origin: null,
        outcome: "success",
      });
      await this.deps.cases.appendTimeline(caseId, {
        kind: "log_corpus_built",
        actor,
        targetId: host.corpusId,
        payload: {
          sourcesSelected: host.build?.sourcesSelected ?? 0,
          eventsImported: host.build?.eventsImported ?? 0,
          awaitingTimezoneReview: host.build?.timezoneAmbiguousSources ?? [],
        },
      });
      const corpus = await this.deps.store.getCorpus(caseId);
      if (!corpus) throw new Error("log corpus disappeared after build");
      return this.projectState(corpus, host);
    });
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /** Recompute a preview. Never mutates the corpus. */
  async preview(caseId: string, raw: unknown): Promise<LogTimePreviewV1> {
    const request = parseLogTimePreviewRequest(raw);
    const corpus = await this.requireCorpus(caseId);
    const host = await this.deps.bridge.run(caseId, {
      kind: "preview",
      corpusId: corpus.corpusId,
      expectedRevision: request.expectedRevision,
      source: request.source,
      ianaTimezone: request.ianaTimezone,
    });
    const preview = host.preview;
    if (!preview) throw new Error("log-time host returned no preview");

    const samples: LogTimeSampleV1[] = preview.samples
      .slice(0, LOG_TIME_LIMITS.maxPreviewSamples)
      .map((sample) => ({
        ordinal: sample.ordinal,
        outcome: sample.outcome,
        rawTimestamp: sample.rawTimestamp,
        normalizedInstant: sample.normalizedInstant,
        utcOffsetSeconds: sample.utcOffsetSeconds,
        unresolvedReason:
          sample.unresolvedReason as LogTimeSampleV1["unresolvedReason"],
        excerpt: sample.excerpt.slice(0, LOG_TIME_LIMITS.maxExcerptChars),
      }));

    return parseLogTimePreview({
      schemaId: LOG_TIME_PREVIEW_SCHEMA_ID,
      caseId,
      corpusId: corpus.corpusId,
      corpusRevision: host.corpusRevision,
      declarationFingerprint: preview.declarationFingerprint,
      source: preview.source,
      ianaTimezone: preview.ianaTimezone,
      affectedRecords: preview.affectedRecords,
      existingWallClockRecords: preview.existingWallClockRecords,
      unchangedOrderOnlyRecords: preview.unchangedOrderOnlyRecords,
      firstResolvedInstant: preview.firstResolvedInstant,
      lastResolvedInstant: preview.lastResolvedInstant,
      dstGapCount: preview.dstGapCount,
      dstFoldCount: preview.dstFoldCount,
      unsupportedTimestampCount: preview.unsupportedTimestampCount,
      zoneAbbreviationMismatchCount: preview.zoneAbbreviationMismatchCount,
      outOfRangeCount: preview.outOfRangeCount,
      samples,
    });
  }

  // -------------------------------------------------------------------------
  // Durable changes
  // -------------------------------------------------------------------------

  async apply(
    caseId: string,
    actor: Actor,
    raw: unknown,
  ): Promise<LogTimeOutcomeV1> {
    const request = parseLogTimeApplyRequest(raw);
    assertBounded("source", request.source, LOG_TIME_LIMITS.maxSourceChars);
    return this.mutate(caseId, actor, "apply", request.source, request.idempotencyKey, request, async (corpus) => {
      const declaredAt = Math.floor(this.now().getTime() / 1000);
      const host = await this.deps.bridge.run(caseId, {
        kind: "apply",
        corpusId: corpus.corpusId,
        expectedRevision: request.expectedRevision,
        source: request.source,
        ianaTimezone: request.ianaTimezone,
        declarationFingerprint: request.declarationFingerprint,
        declaredAt,
      });
      await this.deps.store.putDeclaration({
        caseId,
        source: request.source,
        ianaTimezone: request.ianaTimezone,
        basis: "user_declared",
        declaredAt,
        appliedRevision: host.revision?.appliedRevision ?? host.corpusRevision,
        declarationFingerprint: request.declarationFingerprint,
        declaredBy: actor.id,
      });
      return host;
    });
  }

  async clear(
    caseId: string,
    actor: Actor,
    raw: unknown,
  ): Promise<LogTimeOutcomeV1> {
    const request = parseLogTimeClearRequest(raw);
    assertBounded("source", request.source, LOG_TIME_LIMITS.maxSourceChars);
    return this.mutate(caseId, actor, "clear", request.source, request.idempotencyKey, request, async (corpus) => {
      const host = await this.deps.bridge.run(caseId, {
        kind: "clear",
        corpusId: corpus.corpusId,
        expectedRevision: request.expectedRevision,
        source: request.source,
      });
      await this.deps.store.deleteDeclaration(caseId, request.source);
      return host;
    });
  }

  async undo(
    caseId: string,
    actor: Actor,
    raw: unknown,
  ): Promise<LogTimeOutcomeV1> {
    const request = parseLogTimeUndoRequest(raw);
    return this.mutate(caseId, actor, "undo", null, request.idempotencyKey, request, async (corpus) => {
      const host = await this.deps.bridge.run(caseId, {
        kind: "undo",
        corpusId: corpus.corpusId,
        expectedRevision: request.expectedRevision,
      });
      // Undo restores the host's declaration set wholesale. Re-derive the
      // durable record from what the corpus now actually holds, keeping the
      // stored provenance for any declaration that came back.
      const previous = await this.deps.store.listDeclarations(caseId);
      const stored = new Map(previous.map((row) => [row.source, row]));
      const restored: LogTimeDeclarationRow[] = Object.values(host.declarations).map(
        (live) => {
          const prior = stored.get(live.source);
          return {
            caseId,
            source: live.source,
            ianaTimezone: live.ianaTimezone,
            basis: live.basis,
            declaredAt: live.declaredAt,
            appliedRevision: live.appliedRevision,
            // A restored declaration keeps the fingerprint of the preview it
            // was originally decided against when we still hold it. When we do
            // not, the zero digest marks it as provenance we cannot vouch for
            // rather than inventing one.
            declarationFingerprint: prior?.declarationFingerprint ?? "0".repeat(64),
            declaredBy: prior?.declaredBy ?? actor.id,
          };
        },
      );
      await this.deps.store.replaceDeclarations(caseId, restored);
      return host;
    });
  }

  /**
   * Shared durable-change path: case lock, idempotent replay, host call,
   * revision bookkeeping, dependent accounting, audit, timeline.
   */
  private async mutate(
    caseId: string,
    actor: Actor,
    operation: Exclude<LogTimeOperation, "preview">,
    source: string | null,
    idempotencyKey: string,
    request: unknown,
    call: (corpus: LogCorpusRow) => Promise<HostResult>,
  ): Promise<LogTimeOutcomeV1> {
    const requestDigest = digestOf({ caseId, actor: actor.id, operation, request });
    return this.deps.store.withCaseLock(caseId, async () => {
      const corpus = await this.requireCorpus(caseId);
      const replay = await this.deps.store.getOperationByIdempotency(
        caseId,
        idempotencyKey,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest) {
          throw new LogTimeConflictError(
            "idempotency key already belongs to another request",
          );
        }
        return this.outcomeFor(caseId, corpus.corpusId, replay, true);
      }

      const host = await call(corpus);
      const revision = host.revision;
      if (!revision) throw new Error("log-time host returned no revision report");

      await this.deps.store.updateCorpusRevision(
        caseId,
        revision.appliedRevision,
        revision.previousRevision,
      );

      const operationId = randomUUID();
      const createdAt = this.now().toISOString();
      await this.deps.store.insertOperation({
        id: operationId,
        caseId,
        operation,
        source,
        previousRevision: revision.previousRevision,
        appliedRevision: revision.appliedRevision,
        restoredRevision: revision.restoredRevision,
        changedRecords: revision.changedRecords,
        idempotencyKey,
        requestDigest,
        createdAt,
        createdBy: actor.id,
      });

      const dependents = await this.assessDependents(
        caseId,
        operationId,
        corpus,
        revision.changedRecords,
      );
      if (dependents.length > 0) {
        await this.deps.store.insertDependents(dependents);
      }

      await this.deps.audit.append({
        identity: actor.id,
        action: `log_time_${operation}`,
        target: caseId,
        origin: null,
        outcome: "success",
      });
      await this.deps.cases.appendTimeline(caseId, {
        kind: `log_time_${operation}`,
        actor,
        targetId: operationId,
        payload: {
          source,
          previousRevision: revision.previousRevision,
          appliedRevision: revision.appliedRevision,
          restoredRevision: revision.restoredRevision,
          changedRecords: revision.changedRecords,
          revisedSnapshots: dependents.filter((d) => d.disposition === "revised").length,
          invalidatedRuns: dependents.filter((d) => d.disposition === "invalidated")
            .length,
        },
      });

      const stored = await this.deps.store.getOperationByIdempotency(
        caseId,
        idempotencyKey,
      );
      return this.outcomeFor(caseId, corpus.corpusId, stored ?? {
        id: operationId,
        caseId,
        operation,
        source,
        previousRevision: revision.previousRevision,
        appliedRevision: revision.appliedRevision,
        restoredRevision: revision.restoredRevision,
        changedRecords: revision.changedRecords,
        idempotencyKey,
        requestDigest,
        createdAt,
        createdBy: actor.id,
      }, false);
    });
  }

  /**
   * Decide, honestly, what this change did to snapshots and runs.
   *
   * A snapshot's bytes never change here, so it is never called invalid — only
   * `revised`, meaning the same evidence now reads under a different clock. A
   * run is different: it already produced conclusions under the superseded
   * basis, so it is `invalidated`. Anything frozen before the corpus existed
   * has no recorded basis and is reported as `unknown_basis` rather than
   * assumed current.
   *
   * When a change rewrote no timestamps at all, nothing downstream moved, so
   * nothing is marked.
   */
  private async assessDependents(
    caseId: string,
    operationId: string,
    corpus: LogCorpusRow,
    changedRecords: number,
  ): Promise<LogTimeDependentRow[]> {
    if (changedRecords === 0) return [];

    const builtAt = Date.parse(corpus.builtAt);
    const snapshots = await this.deps.cases.listSnapshotsForCase(caseId);
    const runs = await this.deps.cases.listTriageRunsForCase(caseId);
    const rows: LogTimeDependentRow[] = [];
    const snapshotDisposition = new Map<string, LogTimeDependentDisposition>();

    for (const snapshot of snapshots) {
      const createdAt = Date.parse(snapshot.createdAt);
      const known = Number.isFinite(createdAt) && Number.isFinite(builtAt);
      const disposition: LogTimeDependentDisposition = !known
        ? "unknown_basis"
        : createdAt < builtAt
          ? "unknown_basis"
          : "revised";
      snapshotDisposition.set(snapshot.id, disposition);
      rows.push({
        caseId,
        operationId,
        kind: "snapshot",
        dependentId: snapshot.id,
        disposition,
        reason:
          disposition === "revised"
            ? PLAIN_LANGUAGE.snapshotRevised
            : PLAIN_LANGUAGE.snapshotUnknown,
        observedRevision:
          disposition === "revised" ? corpus.corpusRevision : null,
      });
    }

    for (const run of runs) {
      const inherited = run.snapshotId
        ? snapshotDisposition.get(run.snapshotId)
        : undefined;
      const disposition: LogTimeDependentDisposition =
        inherited === "revised"
          ? "invalidated"
          : inherited === "unknown_basis" || inherited === undefined
            ? "unknown_basis"
            : "unaffected";
      rows.push({
        caseId,
        operationId,
        kind: "triage_run",
        dependentId: run.id,
        disposition,
        reason:
          disposition === "invalidated"
            ? PLAIN_LANGUAGE.runInvalidated
            : disposition === "unknown_basis"
              ? PLAIN_LANGUAGE.runUnknown
              : PLAIN_LANGUAGE.runUnaffected,
        observedRevision:
          disposition === "invalidated" ? corpus.corpusRevision : null,
      });
    }

    return rows;
  }

  private async outcomeFor(
    caseId: string,
    corpusId: string,
    row: {
      id: string;
      operation: LogTimeOperation;
      source: string | null;
      previousRevision: number;
      appliedRevision: number;
      restoredRevision: number | null;
      changedRecords: number;
      createdAt: string;
      createdBy: string;
    },
    replayed: boolean,
  ): Promise<LogTimeOutcomeV1> {
    const declarations = await this.deps.store.listDeclarations(caseId);
    const dependents = await this.deps.store.listDependents(caseId, row.id);
    return parseLogTimeOutcome({
      schemaId: LOG_TIME_OUTCOME_SCHEMA_ID,
      caseId,
      corpusId,
      operation: row.operation,
      source: row.source,
      previousRevision: row.previousRevision,
      appliedRevision: row.appliedRevision,
      restoredRevision: row.restoredRevision,
      changedRecords: row.changedRecords,
      replayed,
      declarations: declarations.map((declaration) => ({
        source: declaration.source,
        ianaTimezone: declaration.ianaTimezone,
        basis: declaration.basis,
        declaredAt: declaration.declaredAt,
        appliedRevision: declaration.appliedRevision,
        declarationFingerprint: declaration.declarationFingerprint,
        declaredBy: declaration.declaredBy,
      })),
      dependents: dependents.map(toDependent),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    });
  }

  private async requireCorpus(caseId: string): Promise<LogCorpusRow> {
    const corpus = await this.deps.store.getCorpus(caseId);
    if (!corpus) {
      throw new LogTimeNotFoundError("this case has no log corpus yet");
    }
    return corpus;
  }
}

function toDependent(row: LogTimeDependentRow): LogTimeDependentV1 {
  return {
    kind: row.kind,
    id: row.dependentId,
    disposition: row.disposition,
    reason: row.reason,
    observedRevision: row.observedRevision,
  };
}

function toChronologyRow(row: HostChronologyRow) {
  return {
    seq: row.seq,
    source: row.source,
    rawTimestamp: row.rawTimestamp,
    normalizedInstant: row.normalizedInstant,
    timeState: row.timeState,
    timestampProvenance: row.timestampProvenance,
    orderOnlyReason: row.orderOnlyReason,
    level: row.level,
    message: row.message.slice(0, LOG_CHRONOLOGY_LIMITS.maxMessageChars),
  };
}
