import { createHash, randomUUID } from "node:crypto";
import {
  ARTIFACT_SCHEMA_ID,
  CASE_SCHEMA_ID,
  ContractViolation,
  CONTRIBUTION_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  OVERVIEW_ACTIVITY_CAP,
  OVERVIEW_OPEN_CASE_CAP,
  describeDeleteRequest,
  isRfc4122Uuid,
  isContributionIdempotencyKey,
  normalizeInvestigationContext,
  snapshotFairness,
  snapshotFingerprint,
  type ArtifactKind,
  type ArtifactV1,
  type BlobMetaV1,
  type ContentHash,
  normalizeOccurredAt,
  statusRequiresResolution,
  type CaseSeverity,
  type OccurredAtPrecision,
  type OccurredAtZone,
  type CaseStatus,
  type CaseV1,
  type ContributionV1,
  type HypothesisStatus,
  type InvestigationContextV1,
  type InvestigationLifecycleActionRequestV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleChangedV1,
  type InvestigationLifecycleV1,
  type LifecycleAction,
  type PrivacyClass,
  type SnapshotV1,
} from "@cd-collab/contracts";
import {
  isContentHash,
  sha256Hex,
  type EvidenceReadHandle,
  type EvidenceReadRange,
  type EvidenceStage,
  type EvidenceStore,
  type EvidenceStreamStage,
  type EvidenceWriteBatch,
} from "../../evidence/store.js";
import { ResolutionRequiredError } from "../resolutions/index.js";
import type { AuditStore } from "../audit/index.js";
import { CatalogService, withCatalogCaseMutation } from "../catalog/index.js";
import {
  assertSupportedLinks,
  defaultPrivacy,
  hashContributionContent,
  isContributionKind,
  parseHypothesisLinks,
  type ContributionKind,
  type HypothesisLinkInput,
} from "../contributions/index.js";
import { assertFilenameAllowed, assertUploadAllowed, MAX_UPLOAD_BYTES } from "../evidence/index.js";
import {
  decodeBase64,
  corpusIntakeRequestDigest,
  duplicateDigestFlags,
  previewCorpusBytes,
} from "../corpus-intake/index.js";
import {
  ARCHIVED_STATUS,
  CORPUS_INTAKE_BATCH_SCHEMA_ID,
  evaluateArchive,
  evaluateRestore,
  isLifecycleTransition,
  parseCorpusIntakeBatch,
  parseCorpusIntakeCommitRequest,
  parseCorpusIntakePreviewRequest,
  restoreTarget,
  type CorpusIntakeBatchV1,
  type CorpusIntakePreviewReportV1,
  type LifecycleRefusal,
  type StatusHistoryEntry,
} from "@cd-collab/contracts";
import { LegalHoldError, assertCanTombstone, visibleBody } from "../provenance/index.js";
import { deriveCaseBoard, type AcceptedDecisionBoardInput } from "./board.js";
import {
  CaseStoreCommitOutcomeUnknownError,
  MemoryCaseStore,
  type Actor,
  type ArtifactRow,
  type CaseStore,
  type CaseTimelineRow,
  type OverviewActivityRow,
  type OverviewCounts,
  type OverviewOpenCaseRow,
  type OverviewScope,
  type OverviewVisibilityBoundary,
  type RevisionRow,
  type SnapshotRow,
  type TimelineInsert,
  type TimelineRow,
  type ActivityPageCursor,
  type ActivityPageQuery,
} from "./store.js";

export { CaseStoreCommitOutcomeUnknownError };
export type { Actor, ArtifactRow, CaseTimelineRow, OverviewActivityRow, OverviewCounts, OverviewOpenCaseRow, OverviewScope, OverviewVisibilityBoundary, RevisionRow, TimelineRow } from "./store.js";

const ACTIVITY_DETAIL_KEYS = new Set([
  "kind",
  "status",
  "revision",
  "candidateCount",
  "evidenceCount",
  "mode",
  "dimension",
  "verificationStatus",
  "legalHold",
]);

function activityDetails(payload: string): Record<string, string | number | boolean | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      ACTIVITY_DETAIL_KEYS.has(key)
      && (typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
        || value === null)
    ) {
      details[key] = value;
    }
  }
  return details;
}

export interface CaseActivityItem {
  caseId: string;
  caseTitle: string;
  caseStatus: CaseStatus;
  caseSeverity: CaseSeverity;
  seq: number;
  kind: string;
  actorUsername: string;
  targetId: string | null;
  occurredAt: string;
  details: Record<string, string | number | boolean | null>;
}

export interface CaseSituationInput {
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  openQuestions: string[];
  investigationContext?: unknown;
}

export class SituationConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("situation conflict");
  }
}

export class CorpusIntakeConflictError extends Error {}

/**
 * An archive or restore the lifecycle contract refused.
 *
 * Carries the machine-readable reason so the surface can open the control
 * that would clear it — a legal-hold refusal should point at the hold, not at
 * a generic failure the operator has to guess about.
 */
export class LifecycleRefusedError extends Error {
  constructor(
    readonly investigationId: string,
    readonly action: LifecycleAction,
    readonly reason: LifecycleRefusal,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "LifecycleRefusedError";
  }
}

/** Archive and restore are commands, never caller-selected generic statuses. */
export class LifecycleActionRequiredError extends Error {
  readonly endpoint: string;

  constructor(
    readonly investigationId: string,
    readonly action: LifecycleAction,
  ) {
    super("lifecycle_action_required");
    this.name = "LifecycleActionRequiredError";
    this.endpoint = `/api/cases/${investigationId}/lifecycle`;
  }
}

/** The preview supplied with a lifecycle action no longer matches locked state. */
export class LifecycleChangedError extends Error {
  constructor(readonly conflict: InvestigationLifecycleChangedV1) {
    super("lifecycle_changed");
    this.name = "LifecycleChangedError";
  }
}

/** Status changed after resolution authorization but before the locked write. */
export class StatusChangedError extends Error {
  constructor(readonly currentStatus: CaseStatus) {
    super("status_changed");
    this.name = "StatusChangedError";
  }
}

export class ContributionConflictError extends Error {
  constructor(readonly currentRevision?: number) {
    super("contribution conflict");
    this.name = "ContributionConflictError";
  }
}

async function settleEvidenceAfterCaseTransactionFailure(
  error: unknown,
  evidenceBatch: EvidenceWriteBatch | null,
  stages: EvidenceStage[],
  evidenceCommitted: boolean,
): Promise<void> {
  if (error instanceof CaseStoreCommitOutcomeUnknownError && evidenceCommitted) {
    if (evidenceBatch) {
      try {
        await evidenceBatch.finalize({ retainPendingJournal: true });
      } catch {
        // Staging cleanup is best-effort; the COMMIT outcome remains unknown.
      }
    }
    return;
  }
  if (evidenceBatch) {
    await evidenceBatch.rollback();
  } else {
    await Promise.allSettled(stages.map((stage) => stage.rollback()));
  }
}

async function settleStreamedEvidenceAfterCaseTransactionFailure(
  error: unknown,
  stage: EvidenceStreamStage | null,
  evidenceCommitted: boolean,
): Promise<void> {
  if (!stage) return;
  if (error instanceof CaseStoreCommitOutcomeUnknownError && evidenceCommitted) {
    try {
      await stage.finalize({ retainPendingJournal: true });
    } catch {
      // Staging cleanup is best-effort; the COMMIT outcome remains unknown.
    }
    return;
  }
  try {
    await stage.rollback();
  } catch {
    // Rollback of a definite failure must not replace the original error.
  }
}

function throwIfStreamAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error("evidence stream aborted");
  }
}

async function* nonEmptyStreamChunks(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    throwIfStreamAborted(signal);
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("evidence stream chunk must be a Uint8Array");
    }
    if (chunk.byteLength === 0) continue;
    yield chunk;
  }
}

interface ContributionWriteInput {
  kind: string;
  body: string;
  privacyClass?: PrivacyClass;
  clientTime?: string;
  hypothesisStatus?: HypothesisStatus;
  /** Untrusted until parsed and resolved inside the case transaction. */
  hypothesisLinks?: unknown;
  sourceId?: string;
  idempotencyKey?: string;
}

function contributionWriteDigest(input: {
  kind: string;
  body: string;
  privacyClass: PrivacyClass;
  hypothesisStatus: HypothesisStatus | null;
  hypothesisLinks: { kind: "artifact" | "contribution"; id: string }[];
  sourceId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        body: input.body,
        privacyClass: input.privacyClass,
        hypothesisStatus: input.hypothesisStatus,
        hypothesisLinks: input.hypothesisLinks,
        sourceId: input.sourceId,
      }),
    )
    .digest("hex");
}

function sameHypothesisLinks(
  left: { kind: string; id: string }[],
  right: { kind: string; id: string }[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.kind === right[index]?.kind && item.id === right[index]?.id);
}

function isUniqueViolation(error: unknown): boolean {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === "23505"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key|contribution revision conflict|contribution idempotency key already exists/i.test(
    message,
  );
}

const SITUATION_TEXT_LIMIT = 12_000;
const SITUATION_QUESTION_LIMIT = 2_000;
const SITUATION_QUESTION_COUNT_LIMIT = 50;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function canonicalClientTime(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) {
    throw new Error("clientTime must be an RFC3339 timestamp");
  }
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, offsetHourRaw,
    offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const validComponents = month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && Number(hourRaw) <= 23
    && Number(minuteRaw) <= 59
    && Number(secondRaw) <= 59
    && (offsetHourRaw === undefined || Number(offsetHourRaw) <= 23)
    && (offsetMinuteRaw === undefined || Number(offsetMinuteRaw) <= 59);
  if (!validComponents) {
    throw new Error("clientTime must be an RFC3339 timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("clientTime must be an RFC3339 timestamp");
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new Error("clientTime must be an RFC3339 timestamp");
  }
}

function cleanSituationText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length > SITUATION_TEXT_LIMIT) {
    throw new Error(`${field} is too long`);
  }
  return cleaned;
}

function cleanSituation(input: CaseSituationInput): CaseSituationInput {
  if (input.openQuestions.length > SITUATION_QUESTION_COUNT_LIMIT) {
    throw new Error("too many open questions");
  }
  const openQuestions = input.openQuestions.map((question) => {
    const cleaned = question.trim();
    if (cleaned.length > SITUATION_QUESTION_LIMIT) {
      throw new Error("open question is too long");
    }
    return cleaned;
  }).filter(Boolean);
  return {
    problemStatement: cleanSituationText(input.problemStatement, "problem statement"),
    affectedParties: cleanSituationText(input.affectedParties, "affected parties"),
    impact: cleanSituationText(input.impact, "impact"),
    scope: cleanSituationText(input.scope, "scope"),
    openQuestions,
  };
}

/**
 * Gate consulted before every status transition.
 *
 * A status that claims the question was answered must have a record behind it.
 * The check lives on the service rather than the route so it cannot be skipped
 * by calling the status endpoint directly; the implementation lives in the
 * resolutions module, which owns what a valid record is.
 */
export interface StatusResolutionGuard {
  authorizeStatus(input: {
    caseId: string;
    status: CaseStatus;
    previousStatus: CaseStatus;
    actor: Actor;
    origin: string;
    resolution?: unknown;
    expectedResolutionRevision?: number;
  }): Promise<void>;
}

export interface StatusChangeOptions {
  clientTime?: string;
  /** Recorded atomically with the transition when the caller supplies one. */
  resolution?: unknown;
  expectedResolutionRevision?: number;
}

export class CaseService {
  private normalizationRevisionFor:
    | ((caseId: string) => Promise<number | null>)
    | null = null;

  constructor(
    private readonly evidence: EvidenceStore,
    private readonly audit: AuditStore,
    private readonly store: CaseStore = new MemoryCaseStore(),
    private readonly catalog: CatalogService = new CatalogService(),
    private readonly resolutionGuard?: StatusResolutionGuard,
  ) {}

  bindNormalizationRevision(
    lookup: (caseId: string) => Promise<number | null>,
  ): void {
    this.normalizationRevisionFor = lookup;
  }

  async withAtomic<T>(operation: () => Promise<T>): Promise<T> {
    return withCatalogCaseMutation(async () => {
      try {
        return await this.store.withAtomic(operation, this.audit);
      } catch (error) {
        if (error instanceof CaseStoreCommitOutcomeUnknownError) {
          throw error;
        }
        try {
          await this.catalog.rollbackCaseInserts();
        } catch {
          // Catalog cleanup must never replace the authoritative mutation error.
        }
        throw error;
      }
    });
  }

  async appendDomainTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow> {
    const clientTime = canonicalClientTime(event.clientTime);
    await this.requireCase(caseId);
    return this.store.appendTimeline(caseId, { ...event, clientTime });
  }

  async listCases(actor: Actor, isAdmin: boolean): Promise<CaseV1[]> {
    const rows = await this.store.listCases();
    return rows.filter((c) => isAdmin || this.isMember(c, actor.id)).map((c) => this.toCase(c));
  }

  async listActivityPage(
    actor: Actor,
    isAdmin: boolean,
    query: { caseId?: string; limit: number; after?: ActivityPageCursor },
  ): Promise<CaseTimelineRow[]> {
    if (query.caseId) {
      const row = await this.getCase(query.caseId, actor, isAdmin);
      if (!row) return [];
      return this.store.listActivityPage({
        caseId: query.caseId,
        limit: query.limit,
        ...(query.after ? { after: query.after } : {}),
      });
    }
    return this.store.listActivityPage({
      scope: { actorId: actor.id, isAdmin },
      limit: query.limit,
      ...(query.after ? { after: query.after } : {}),
    } satisfies ActivityPageQuery);
  }

  async listRecentActivity(
    actor: Actor,
    isAdmin: boolean,
    requestedLimit = 30,
  ): Promise<CaseActivityItem[]> {
    const limit = Math.min(100, Math.max(1, Math.trunc(requestedLimit) || 30));
    const cases = (await this.store.listCases()).filter(
      (row) => isAdmin || this.isMember(row, actor.id),
    );
    const byId = new Map(cases.map((row) => [row.id, row]));
    const events = await this.store.listRecentTimeline([...byId.keys()], limit);
    return events.flatMap((event): CaseActivityItem[] => {
      const row = byId.get(event.caseId);
      if (!row) return [];
      return [{
        caseId: row.id,
        caseTitle: row.title,
        caseStatus: row.status,
        caseSeverity: row.severity,
        seq: event.seq,
        kind: event.kind,
        actorUsername: event.actorUsername,
        targetId: event.targetId,
        occurredAt: event.serverTime,
        details: activityDetails(event.payload),
      }];
    });
  }

  /**
   * Membership-filtered timeline rows for activity projection.
   * Investigation-scoped reads use the full authoritative timeline; overview
   * reads use a bounded recent window over the same table.
   */
  async listAuthorizedTimelineSources(
    actor: Actor,
    isAdmin: boolean,
    options: { caseId?: string; limit: number },
  ): Promise<Array<{ caseId: string; title: string; event: CaseTimelineRow }>> {
    const visible = (await this.store.listCases()).filter(
      (row) => isAdmin || this.isMember(row, actor.id),
    );
    if (options.caseId) {
      const row = visible.find((item) => item.id === options.caseId);
      if (!row) return [];
      const events = await this.store.listTimeline(row.id);
      return events.map((event) => ({
        caseId: row.id,
        title: row.title,
        event: { ...event, caseId: row.id },
      }));
    }
    const limit = Math.max(0, Math.trunc(options.limit) || 0);
    if (limit === 0) return [];
    const events = await this.store.listActivityPage({
      scope: { actorId: actor.id, isAdmin },
      limit,
    });
    const byId = new Map(visible.map((row) => [row.id, row]));
    return events.flatMap((event) => {
      const row = byId.get(event.caseId);
      if (!row) return [];
      return [{ caseId: row.id, title: row.title, event }];
    });
  }

  async listOverviewCounts(scope: OverviewScope): Promise<OverviewCounts> {
    return this.store.overviewCounts(scope);
  }

  async overviewVisibilityBoundary(
    scope: OverviewScope,
  ): Promise<OverviewVisibilityBoundary | null> {
    return this.store.overviewVisibilityBoundary(scope);
  }

  async listOverviewOpenCases(
    scope: OverviewScope,
    requestedLimit = OVERVIEW_OPEN_CASE_CAP,
  ): Promise<OverviewOpenCaseRow[]> {
    const limit = Math.min(
      OVERVIEW_OPEN_CASE_CAP,
      Math.max(0, Math.trunc(requestedLimit) || OVERVIEW_OPEN_CASE_CAP),
    );
    if (limit === 0) return [];
    return this.store.listOverviewOpenCases(scope, limit);
  }

  async listOverviewActivity(
    scope: OverviewScope,
    requestedLimit = OVERVIEW_ACTIVITY_CAP,
  ): Promise<OverviewActivityRow[]> {
    const limit = Math.min(
      OVERVIEW_ACTIVITY_CAP,
      Math.max(0, Math.trunc(requestedLimit) || OVERVIEW_ACTIVITY_CAP),
    );
    if (limit === 0) return [];
    return this.store.listOverviewActivity(scope, limit);
  }

  async getCase(id: string, actor: Actor, isAdmin: boolean): Promise<CaseV1 | null> {
    const row = await this.store.getCase(id);
    if (!row) return null;
    if (!isAdmin && !this.isMember(row, actor.id)) return null;
    return this.toCase(row);
  }

  async createCase(
    actor: Actor,
    input: {
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
    },
    origin: string,
  ): Promise<CaseV1> {
    const clientTime = canonicalClientTime(input.clientTime);
    const id = randomUUID();
    const now = new Date().toISOString();
    // Two clocks from the first moment: `now` records when this row was
    // written, the occurrence records when the work happened. A historical
    // investigation opened today is ordinary, not an anomaly to correct.
    const occurrence = normalizeOccurredAt(input, { path: "$" });
    const situation = cleanSituation({
      problemStatement: input.problemStatement ?? "",
      affectedParties: input.affectedParties ?? "",
      impact: input.impact ?? "",
      scope: input.scope ?? "",
      openQuestions: input.openQuestions ?? [],
    });
    const investigationContext = normalizeInvestigationContext(input.investigationContext);
    const row = {
      id,
      title: input.title,
      ...situation,
      situationVersion: 0,
      investigationContext,
      occurredAt: occurrence.occurredAt,
      occurredAtPrecision: occurrence.occurredAtPrecision,
      occurredAtZone: occurrence.occurredAtZone,
      severity: input.severity ?? "medium",
      status: "open" as const,
      legalHold: false,
      retentionClass: "standard",
      createdAt: now,
      createdBy: actor.id,
      createdByUsername: actor.username,
      participants: [{ identityId: actor.id, username: actor.username }],
    };
    return this.store.withAtomic(async () => {
    await this.store.insertCase(row);
    await this.store.appendTimeline(id, {
      kind: "case_created",
      actor,
      targetId: id,
      clientTime,
      payload: {
        title: row.title,
        ...(occurrence.occurredAt === null ? {} : { occurredAt: occurrence.occurredAt }),
      },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_create",
      target: id,
      origin,
      outcome: "success",
    });
    return this.toCase(row);
    }, this.audit);
  }

  /**
   * Backfills when the investigated work happened.
   *
   * Moves the occurrence only. `createdAt`, the audit trail, and the timeline
   * sequence keep saying when each record was written, so describing something
   * that predates this tool never requires rewriting history. Clearing it back
   * to unrecorded is allowed and is itself recorded.
   */
  async setOccurredAt(
    caseId: string,
    actor: Actor,
    input: { occurredAt?: unknown; occurredAtPrecision?: unknown; occurredAtZone?: unknown },
    origin: string,
    clientTime?: string,
  ): Promise<CaseV1> {
    const canonicalTime = canonicalClientTime(clientTime);
    const row = await this.requireCase(caseId);
    const occurrence = normalizeOccurredAt(input, { path: "$" });
    const previous = row.occurredAt ?? null;
    await this.store.updateOccurredAt(caseId, occurrence);
    await this.store.appendTimeline(caseId, {
      kind: "case_occurred_at",
      actor,
      targetId: caseId,
      clientTime: canonicalTime,
      payload: {
        occurredAt: occurrence.occurredAt,
        occurredAtPrecision: occurrence.occurredAtPrecision,
        occurredAtZone: occurrence.occurredAtZone,
        previousOccurredAt: previous,
      },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_occurred_at",
      target: `${caseId}:${occurrence.occurredAt ?? "unrecorded"}`,
      origin,
      outcome: "success",
    });
    const updated = await this.requireCase(caseId);
    return this.toCase(updated);
  }

  async updateSituation(
    caseId: string,
    actor: Actor,
    input: Partial<CaseSituationInput>,
    expectedVersion: number,
    origin: string,
    clientTime?: string,
  ): Promise<CaseV1> {
    const canonicalTime = canonicalClientTime(clientTime);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative safe integer");
    }
    const row = await this.requireCase(caseId);
    const suppliedFields = Object.keys(input).filter((key) =>
      [
        "problemStatement",
        "affectedParties",
        "impact",
        "scope",
        "openQuestions",
        "investigationContext",
      ].includes(key),
    );
    if (suppliedFields.length === 0) throw new Error("no situation fields supplied");
    const situation = cleanSituation({
      problemStatement: input.problemStatement ?? row.problemStatement ?? "",
      affectedParties: input.affectedParties ?? row.affectedParties ?? "",
      impact: input.impact ?? row.impact ?? "",
      scope: input.scope ?? row.scope ?? "",
      openQuestions: input.openQuestions ?? row.openQuestions ?? [],
    });
    const investigationContext = Object.prototype.hasOwnProperty.call(input, "investigationContext")
      ? normalizeInvestigationContext(input.investigationContext)
      : row.investigationContext ?? null;
    const changedFields = suppliedFields.filter((field) => {
      if (field === "investigationContext") {
        return JSON.stringify(investigationContext) !== JSON.stringify(row.investigationContext ?? null);
      }
      if (field === "openQuestions") {
        return JSON.stringify(situation.openQuestions) !== JSON.stringify(row.openQuestions ?? []);
      }
      return situation[field as keyof Omit<CaseSituationInput, "openQuestions" | "investigationContext">]
        !== (row[field as keyof Omit<CaseSituationInput, "openQuestions" | "investigationContext">] ?? "");
    });
    const result = await this.store.updateSituationAtomic(
      {
        id: row.id,
        expectedVersion,
        situation: { ...situation, investigationContext },
        changedFields,
        timeline: {
          kind: "case_situation_updated",
          actor,
          targetId: caseId,
          clientTime: canonicalTime,
          payload: {
            changedFields,
            openQuestionCount: situation.openQuestions.length,
            predecessorVersion: expectedVersion,
            situationVersion: expectedVersion + 1,
          },
        },
        audit: {
          identity: actor.id,
          action: "case_situation_update",
          target: caseId,
          origin,
          outcome: "success",
        },
      },
      this.audit,
    );
    if (result.status === "not_found") throw new Error("case not found");
    if (result.status === "conflict") {
      throw new SituationConflictError(result.currentVersion);
    }
    return this.toCase(result.row);
  }

  async setStatus(
    caseId: string,
    actor: Actor,
    status: CaseStatus,
    origin: string,
    clientTimeOrOptions?: string | StatusChangeOptions,
  ): Promise<CaseV1> {
    const options: StatusChangeOptions =
      typeof clientTimeOrOptions === "string"
        ? { clientTime: clientTimeOrOptions }
        : (clientTimeOrOptions ?? {});
    const canonicalTime = canonicalClientTime(options.clientTime);
    let authorizedPreviousStatus: CaseStatus | null = null;
    let previewWasLifecycle = false;
    // Resolution stores are not necessarily bound to the PostgreSQL case
    // transaction. Authorize before taking FOR UPDATE so an FK insert cannot
    // self-block on the case row, then require the locked status to match the
    // status that was authorized. A preview that was already a lifecycle
    // transition skips the guard entirely so a generic archive/restore
    // rejection cannot supersede or create a resolution as a side effect.
    if (this.resolutionGuard) {
      const authorizationRow = await this.requireCase(caseId);
      previewWasLifecycle = isLifecycleTransition(authorizationRow.status, status);
      if (!previewWasLifecycle) {
        await this.resolutionGuard.authorizeStatus({
          caseId,
          status,
          previousStatus: authorizationRow.status,
          actor,
          origin,
          ...(options.resolution !== undefined ? { resolution: options.resolution } : {}),
          ...(options.expectedResolutionRevision !== undefined
            ? { expectedResolutionRevision: options.expectedResolutionRevision }
            : {}),
        });
        authorizedPreviousStatus = authorizationRow.status;
      }
    }
    return this.store.withAtomic(async () => {
      const row = await this.store.lockCase(caseId);
      if (!row) throw new Error("case not found");
      const previousStatus = row.status;
      // Lifecycle mutation must enter through the action-specific command.
      // The generic status endpoint cannot accept either direction because a
      // caller-selected target is not an archive/restore authorization token.
      if (isLifecycleTransition(previousStatus, status)) {
        throw new LifecycleActionRequiredError(
          caseId,
          status === ARCHIVED_STATUS ? "archive" : "restore",
        );
      }
      // Fail closed rather than fail open. An installation wired without a
      // resolution guard cannot reach a status that claims the question was
      // answered — the absence of a guard is treated as "nothing authorises
      // this", never as "no check applies".
      if (!this.resolutionGuard && statusRequiresResolution(status)) {
        throw new ResolutionRequiredError(status);
      }
      if (this.resolutionGuard) {
        if (previewWasLifecycle || authorizedPreviousStatus !== previousStatus) {
          throw new StatusChangedError(previousStatus);
        }
      }
      await this.store.updateCaseMeta({ id: caseId, status });
      await this.store.appendTimeline(caseId, {
        kind: "case_status",
        actor,
        targetId: caseId,
        clientTime: canonicalTime,
        payload: { status },
      });
      await this.audit.append({
        identity: actor.id,
        action: "case_status",
        target: `${caseId}:${status}`,
        origin,
        outcome: "success",
      });
      return this.toCase(await this.requireCase(caseId));
    }, this.audit);
  }

  /**
   * The recorded status changes for this investigation, oldest first.
   *
   * Read from the timeline rather than a dedicated column: `case_status` rows
   * already carry the status that was written, its per-case sequence, and the
   * clock it was written on, so restore reads history that has always been
   * there instead of requiring a migration to record it a second time.
   *
   * A row whose payload cannot be read is skipped rather than guessed at —
   * `restoreTarget` treats an absent history as "land on open", which is the
   * safe answer.
   */
  private async statusHistory(caseId: string): Promise<StatusHistoryEntry[]> {
    const rows = await this.store.listTimeline(caseId);
    const history: StatusHistoryEntry[] = [];
    for (const row of rows) {
      if (row.kind !== "case_status") continue;
      let status: unknown;
      try {
        status = (JSON.parse(row.payload) as { status?: unknown }).status;
      } catch {
        continue;
      }
      if (typeof status !== "string") continue;
      history.push({
        status,
        recordedSequence: row.seq,
        recordedAt: row.serverTime,
      });
    }
    return history;
  }

  /**
   * What archiving or restoring this investigation would do, decided once
   * from the same recorded history the write path uses.
   *
   * Both verdicts come from here rather than being recomputed by a caller, so
   * the answer a surface shows before the click and the answer the write path
   * enforces after it cannot drift apart.
   */
  private async lifecycleFromLockedRow(
    caseId: string,
    row: { status: CaseStatus; legalHold: boolean },
  ): Promise<InvestigationLifecycleV1> {
    const subject = { status: row.status, legalHold: row.legalHold };
    const history = await this.statusHistory(caseId);
    return {
      schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
      investigationId: caseId,
      status: row.status,
      legalHold: row.legalHold,
      archive: evaluateArchive(subject),
      restore: evaluateRestore(subject, history),
      restoreTarget: restoreTarget(history),
      deletion: describeDeleteRequest(),
    };
  }

  async lifecycleFor(caseId: string): Promise<InvestigationLifecycleV1> {
    return this.store.withAtomic(async () => {
      const row = await this.store.lockCase(caseId);
      if (!row) throw new Error("case not found");
      return this.lifecycleFromLockedRow(caseId, row);
    });
  }

  async applyLifecycleAction(
    request: InvestigationLifecycleActionRequestV1,
    actor: Actor,
    origin: string,
  ): Promise<InvestigationLifecycleActionSuccessV1> {
    const canonicalTime = canonicalClientTime(request.clientTime);
    return this.store.withAtomic(async () => {
      const row = await this.store.lockCase(request.investigationId);
      if (!row) throw new Error("case not found");
      const current = await this.lifecycleFromLockedRow(request.investigationId, row);
      if (
        request.expected.status !== current.status
        || request.expected.legalHold !== current.legalHold
        || request.expected.restoreTarget !== current.restoreTarget
      ) {
        throw new LifecycleChangedError({
          schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
          error: "lifecycle_changed",
          investigationId: request.investigationId,
          action: request.action,
          current,
        });
      }

      const verdict = current[request.action];
      if (!verdict.allowed) {
        throw new LifecycleRefusedError(
          request.investigationId,
          request.action,
          verdict.reason,
          verdict.detail,
        );
      }
      const appliedStatus = verdict.targetStatus;
      // Restoring to a status that claims the investigation is resolved must
      // still be backed by an active resolution at the moment the lifecycle
      // command owns the case lock. This guard call does not accept a new
      // resolution; it can only confirm the record that archive deliberately
      // preserved. Resolution reads do not acquire the case row lock, so the
      // check is safe while PostgreSQL holds FOR UPDATE on the case.
      //
      // Archive and non-resolved restores intentionally skip the guard. In
      // particular, archiving a resolved investigation must not supersede the
      // reasoning that a later restore needs in order to return to resolved.
      if (request.action === "restore" && statusRequiresResolution(appliedStatus)) {
        if (!this.resolutionGuard) {
          throw new ResolutionRequiredError(appliedStatus);
        }
        await this.resolutionGuard.authorizeStatus({
          caseId: request.investigationId,
          status: appliedStatus,
          previousStatus: row.status,
          actor,
          origin,
        });
      }
      await this.store.updateCaseMeta({ id: request.investigationId, status: appliedStatus });
      await this.store.appendTimeline(request.investigationId, {
        kind: "case_status",
        actor,
        targetId: request.investigationId,
        clientTime: canonicalTime,
        payload: { status: appliedStatus },
      });
      await this.audit.append({
        identity: actor.id,
        action: "case_status",
        target: `${request.investigationId}:${appliedStatus}`,
        origin,
        outcome: "success",
      });
      return {
        schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
        investigationId: request.investigationId,
        action: request.action,
        previousStatus: row.status,
        appliedStatus,
        case: this.toCase(await this.requireCase(request.investigationId)),
      };
    }, this.audit);
  }

  async addParticipant(
    caseId: string,
    actor: Actor,
    participant: { identityId: string; username: string },
    origin: string,
  ): Promise<CaseV1> {
    await this.requireCase(caseId);
    return this.store.withAtomic(async () => {
    await this.store.addParticipant(caseId, participant, actor.id);
    await this.store.appendTimeline(caseId, {
      kind: "membership",
      actor,
      targetId: participant.identityId,
      clientTime: null,
      payload: { username: participant.username },
    });
    await this.audit.append({
      identity: actor.id,
      action: "case_membership",
      target: `${caseId}:${participant.identityId}`,
      origin,
      outcome: "success",
    });
    const updated = await this.requireCase(caseId);
    return this.toCase(updated);
    }, this.audit);
  }

  async setLegalHold(
    caseId: string,
    actor: Actor,
    legalHold: boolean,
    origin: string,
  ): Promise<CaseV1> {
    return this.store.withAtomic(async () => {
      const row = await this.store.lockCase(caseId);
      if (!row) throw new Error("case not found");
      await this.store.updateCaseMeta({ id: caseId, legalHold });
      await this.store.appendTimeline(caseId, {
        kind: "legal_hold",
        actor,
        targetId: caseId,
        clientTime: null,
        payload: { legalHold },
      });
      await this.audit.append({
        identity: actor.id,
        action: "legal_hold",
        target: `${caseId}:${legalHold}`,
        origin,
        outcome: "success",
      });
      return this.toCase(await this.requireCase(caseId));
    }, this.audit);
  }

  async listTimeline(caseId: string): Promise<TimelineRow[]> {
    await this.requireCase(caseId);
    return this.store.listTimeline(caseId);
  }

  async listContributions(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<ContributionV1[]> {
    if (!(await this.getCase(caseId, actor, isAdmin))) return [];
    const rows = await this.store.listLatestRevisions(caseId);
    return rows.map((row) => this.toContribution(row, row.tombstone));
  }

  async listArtifacts(caseId: string, actor: Actor, isAdmin: boolean): Promise<ArtifactV1[]> {
    if (!(await this.getCase(caseId, actor, isAdmin))) return [];
    return (await this.store.listArtifactsByCase(caseId)).map((row) => this.toArtifact(row));
  }

  async listSnapshots(caseId: string, actor: Actor, isAdmin: boolean): Promise<SnapshotV1[]> {
    if (!(await this.getCase(caseId, actor, isAdmin))) return [];
    return this.store.listSnapshotsByCase(caseId);
  }

  async createSnapshot(
    caseId: string,
    actor: Actor,
    input: {
      evidenceIds: string[];
      visibility?: PrivacyClass;
      protocolVersion?: string;
      clientTime?: string;
      normalizationRevision?: number | null;
    },
    origin: string,
  ): Promise<SnapshotV1> {
    const clientTime = canonicalClientTime(input.clientTime);
    await this.requireCase(caseId);
    const evidenceIds = input.evidenceIds;
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error("snapshot evidence ids must be unique");
    }
    const protocolVersion = input.protocolVersion ?? "cd-collab.snapshot.v1";
    return this.store.withAtomic(async () => {
      await this.requireCase(caseId);
      const artifacts = await this.store.listArtifactsByCase(caseId);
      const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      const selected = evidenceIds.map((id, ordinal) => {
        const artifact = byId.get(id);
        if (!artifact) throw new Error("evidence not found");
        return {
          evidenceId: artifact.id,
          ordinal,
          contentHash: artifact.contentHash,
          expectedHash: artifact.expectedHash,
          verificationStatus: artifact.verificationStatus,
          privacyClass: artifact.privacyClass,
        };
      });
      const existing = await this.store.listSnapshotsByCase(caseId);
      const parentSnapshotId = existing.at(-1)?.id ?? null;
      const visibility = input.visibility ?? "owner_only";
      if (visibility === "share_safe" && selected.some((item) => item.privacyClass !== "share_safe")) {
        throw new Error("share-safe snapshot cannot include owner-only evidence");
      }
      const normalizationRevision =
        input.normalizationRevision !== undefined
          ? input.normalizationRevision
          : (await this.normalizationRevisionFor?.(caseId)) ?? null;
      const fingerprint = snapshotFingerprint({
        parentSnapshotId,
        evidence: selected,
        visibility,
        protocolVersion,
        ...(typeof normalizationRevision === "number"
          ? { normalizationRevision }
          : {}),
      });
      const replay = existing.find((row) => row.fingerprint === fingerprint);
      if (replay) return replay;
      const row: SnapshotRow = {
        schemaId: "cd-collab.snapshot.v1",
        id: randomUUID(),
        caseId,
        fingerprint,
        parentSnapshotId,
        evidence: selected,
        visibility,
        protocolVersion,
        fairnessClass: snapshotFairness(selected),
        status: "frozen",
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        ...(typeof normalizationRevision === "number"
          ? { normalizationRevision }
          : { normalizationRevision: null }),
      };
      try {
        await this.store.insertSnapshot(row);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/snapshot fingerprint already exists/i.test(message)) {
          const found = (await this.store.listSnapshotsByCase(caseId)).find(
            (item) => item.fingerprint === fingerprint,
          );
          if (found) return found;
        }
        throw error;
      }
      await this.store.appendTimeline(caseId, {
        kind: "snapshot_frozen",
        actor,
        targetId: row.id,
        clientTime,
        payload: {
          fingerprint,
          parentSnapshotId,
          evidenceCount: selected.length,
          visibility,
        },
      });
      await this.audit.append({
        identity: actor.id,
        action: "snapshot_freeze",
        target: row.id,
        origin,
        outcome: "success",
      });
      return row;
    }, this.audit);
  }

  async getCaseBoard(
    caseId: string,
    actor: Actor,
    isAdmin: boolean,
    snapshotId?: string,
    acceptedDecisions?: AcceptedDecisionBoardInput[],
  ) {
    if (!(await this.getCase(caseId, actor, isAdmin))) return null;
    const snapshots = await this.store.listSnapshotsByCase(caseId);
    const snapshot = snapshotId
      ? await this.store.getSnapshot(snapshotId)
      : snapshots.at(-1) ?? null;
    if (snapshotId && !snapshot) throw new Error("snapshot not found");
    if (snapshot && snapshot.caseId !== caseId) throw new Error("snapshot not found");
    const selectedIds = snapshot ? new Set(snapshot.evidence.map((item) => item.evidenceId)) : null;
    const artifacts = (await this.store.listArtifactsByCase(caseId))
      .filter((artifact) => !selectedIds || selectedIds.has(artifact.id))
      .map((row) => this.toArtifact(row));
    const contributions = await this.listContributions(caseId, actor, isAdmin);
    return deriveCaseBoard({
      caseId,
      snapshotId: snapshot?.id ?? null,
      selectedSnapshotFingerprint: snapshot?.fingerprint ?? null,
      generatedAt: new Date().toISOString(),
      artifacts,
      contributions,
      ...(acceptedDecisions === undefined ? {} : { acceptedDecisions }),
    });
  }

  async addContribution(
    caseId: string,
    actor: Actor,
    input: ContributionWriteInput,
    origin: string,
  ): Promise<ContributionV1> {
    try {
      return await this.withAtomic(
        () => this.persistContribution(caseId, actor, input, origin),
      );
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const sourceId = await this.resolveSourceId(actor, input.sourceId);
        const privacy = defaultPrivacy(input.privacyClass);
        const links = input.hypothesisLinks === undefined
          ? []
          : parseHypothesisLinks(input.hypothesisLinks);
        const digest = contributionWriteDigest({
          kind: input.kind,
          body: input.body,
          privacyClass: privacy,
          hypothesisStatus: input.kind === "hypothesis" ? (input.hypothesisStatus ?? "proposed") : null,
          hypothesisLinks: links,
          sourceId,
        });
        return this.replayContributionWrite(caseId, actor.id, input.idempotencyKey, digest);
      }
      throw error;
    }
  }

  /**
   * Persist a contribution without wrapping `withAtomic`.
   * Callers composing this with other domain writes must already be inside a case transaction.
   */
  async persistContribution(
    caseId: string,
    actor: Actor,
    input: ContributionWriteInput,
    origin: string,
  ): Promise<ContributionV1> {
    const clientTime = canonicalClientTime(input.clientTime);
    await this.requireCase(caseId);
    if (!isContributionKind(input.kind)) {
      throw new Error(`unknown contribution kind: ${input.kind}`);
    }
    const links = await this.validatedContributionLinks(
      caseId,
      input.kind,
      input.hypothesisLinks,
    );
    if (input.kind === "hypothesis") {
      assertSupportedLinks(input.hypothesisStatus ?? "proposed", links);
    }
    const privacy = defaultPrivacy(input.privacyClass);
    const sourceId = await this.resolveSourceId(actor, input.sourceId);
    const hypothesisStatus =
      input.kind === "hypothesis" ? (input.hypothesisStatus ?? "proposed") : null;
    const digest = contributionWriteDigest({
      kind: input.kind,
      body: input.body,
      privacyClass: privacy,
      hypothesisStatus,
      hypothesisLinks: links,
      sourceId,
    });
    const idempotencyKey = input.idempotencyKey;
    if (idempotencyKey !== undefined) {
      if (!isContributionIdempotencyKey(idempotencyKey)) {
        throw new Error("invalid contribution idempotency key");
      }
      await this.store.lockContributionIdempotency(caseId, actor.id, idempotencyKey);
      const existing = await this.store.getContributionIdempotency(
        caseId,
        actor.id,
        idempotencyKey,
      );
      if (existing) {
        if (existing.requestDigest !== digest) {
          throw new ContributionConflictError();
        }
        return this.loadContribution(caseId, existing.contributionId);
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const hash = hashContributionContent(input.kind, input.body);
    const rev: RevisionRow = {
      contributionId: id,
      caseId,
      kind: input.kind,
      revision: 1,
      predecessorRevision: null,
      body: input.body,
      contentHash: hash,
      privacyClass: privacy,
      tombstone: false,
      authorId: actor.id,
      authorUsername: actor.username,
      createdAt: now,
      hypothesisStatus,
      hypothesisLinks: links,
      sourceId,
    };
    await this.store.insertRevision(rev);
    if (idempotencyKey !== undefined) {
      await this.store.insertContributionIdempotency({
        caseId,
        actorId: actor.id,
        idempotencyKey,
        requestDigest: digest,
        contributionId: id,
        createdAt: now,
      });
    }
    await this.store.appendTimeline(caseId, {
      kind: "contribution_created",
      actor,
      targetId: id,
      clientTime,
      payload: { kind: input.kind, contentHash: hash, privacyClass: privacy, sourceId },
    });
    await this.audit.append({
      identity: actor.id,
      action: "contribution_create",
      target: id,
      origin,
      outcome: "success",
    });
    return this.toContribution(rev, false);
  }

  async reviseContribution(
    caseId: string,
    contributionId: string,
    actor: Actor,
    body: string,
    origin: string,
    expectedRevision: number,
    clientTime?: string,
  ): Promise<ContributionV1> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("expectedRevision is required");
    }
    try {
      return await this.store.withAtomic(async () => {
        const canonicalTime = canonicalClientTime(clientTime);
        const latest = await this.requireLatest(caseId, contributionId);
        if (latest.tombstone) throw new Error("contribution not found");
        if (latest.revision !== expectedRevision) {
          throw new ContributionConflictError(latest.revision);
        }
        const next: RevisionRow = {
          ...latest,
          revision: latest.revision + 1,
          predecessorRevision: latest.revision,
          body,
          contentHash: hashContributionContent(latest.kind, body),
          authorId: actor.id,
          authorUsername: actor.username,
          createdAt: new Date().toISOString(),
          tombstone: false,
        };
        await this.store.insertRevision(next);
        await this.store.appendTimeline(caseId, {
          kind: "contribution_revised",
          actor,
          targetId: contributionId,
          clientTime: canonicalTime,
          payload: {
            kind: next.kind,
            revision: next.revision,
            predecessor: latest.revision,
            contentHash: next.contentHash,
          },
        });
        await this.audit.append({
          identity: actor.id,
          action: "contribution_revise",
          target: `${contributionId}:${next.revision}`,
          origin,
          outcome: "success",
        });
        return this.toContribution(next, false);
      }, this.audit);
    } catch (error) {
      if (error instanceof ContributionConflictError) throw error;
      if (isUniqueViolation(error)) {
        const latest = await this.requireLatest(caseId, contributionId);
        throw new ContributionConflictError(latest.revision);
      }
      throw error;
    }
  }

  async tombstoneContribution(
    caseId: string,
    contributionId: string,
    actor: Actor,
    origin: string,
  ): Promise<ContributionV1> {
    try {
      return await this.store.withAtomic(async () => {
        const row = await this.requireCase(caseId);
        assertCanTombstone(row.legalHold);
        const latest = await this.requireLatest(caseId, contributionId);
        if (latest.tombstone) return this.toContribution(latest, true);
        const next: RevisionRow = {
          ...latest,
          revision: latest.revision + 1,
          predecessorRevision: latest.revision,
          body: "",
          contentHash: hashContributionContent(latest.kind, ""),
          authorId: actor.id,
          authorUsername: actor.username,
          createdAt: new Date().toISOString(),
          tombstone: true,
        };
        await this.store.insertRevision(next);
        await this.store.appendTimeline(caseId, {
          kind: "contribution_tombstoned",
          actor,
          targetId: contributionId,
          clientTime: null,
          payload: { kind: latest.kind, revision: next.revision, tombstone: true },
        });
        await this.audit.append({
          identity: actor.id,
          action: "contribution_tombstone",
          target: contributionId,
          origin,
          outcome: "success",
        });
        return this.toContribution(next, true);
      }, this.audit);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const latest = await this.requireLatest(caseId, contributionId);
        throw new ContributionConflictError(latest.revision);
      }
      throw error;
    }
  }

  async provenance(caseId: string, contributionId: string): Promise<ContributionV1[]> {
    const chain = await this.store.listRevisions(contributionId);
    if (!chain.length || chain[0]?.caseId !== caseId) {
      throw new Error("contribution not found");
    }
    return chain.map((rev) => this.toContribution(rev, false));
  }

  async setHypothesisStatus(
    caseId: string,
    contributionId: string,
    actor: Actor,
    status: HypothesisStatus,
    linksInput: unknown,
    origin: string,
    clientTime?: string,
  ): Promise<ContributionV1> {
    const canonicalTime = canonicalClientTime(clientTime);
    try {
      return await this.store.withAtomic(async () => {
        const latest = await this.requireLatest(caseId, contributionId);
        if (latest.kind !== "hypothesis" || latest.tombstone) {
          throw new Error("hypothesis not found");
        }
        const links = await this.validatedHypothesisLinks(caseId, linksInput, "$.links");
        assertSupportedLinks(status, links);
        if (
          latest.hypothesisStatus === status
          && sameHypothesisLinks(latest.hypothesisLinks, links)
        ) {
          return this.toContribution(latest, false);
        }
        const next: RevisionRow = {
          ...latest,
          revision: latest.revision + 1,
          predecessorRevision: latest.revision,
          contentHash: hashContributionContent(latest.kind, latest.body),
          authorId: actor.id,
          authorUsername: actor.username,
          createdAt: new Date().toISOString(),
          hypothesisStatus: status,
          hypothesisLinks: links,
        };
        await this.store.insertRevision(next);
        await this.store.appendTimeline(caseId, {
          kind: "hypothesis_status",
          actor,
          targetId: contributionId,
          clientTime: canonicalTime,
          payload: { kind: next.kind, revision: next.revision, status, links },
        });
        await this.audit.append({
          identity: actor.id,
          action: "hypothesis_status",
          target: `${contributionId}:${status}`,
          origin,
          outcome: "success",
        });
        return this.toContribution(next, false);
      }, this.audit);
    } catch (error) {
      if (error instanceof ContributionConflictError) throw error;
      if (isUniqueViolation(error)) {
        const latest = await this.requireLatest(caseId, contributionId);
        throw new ContributionConflictError(latest.revision);
      }
      throw error;
    }
  }

  async addEvidence(
    caseId: string,
    actor: Actor,
    input: {
      kind: ArtifactKind;
      filename?: string;
      mediaType?: string;
      bytes?: Uint8Array;
      uri?: string;
      expectedHash?: string | null;
      summary: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      sourceId?: string;
    },
    origin: string,
  ): Promise<{ artifact: ArtifactV1; summary: ContributionV1 }> {
    const clientTime = canonicalClientTime(input.clientTime);
    await this.requireCase(caseId);
    const privacy = defaultPrivacy(input.privacyClass);
    if (input.filename !== undefined) assertFilenameAllowed(input.filename);
    const id = randomUUID();
    const uri: string | null = input.uri ?? null;
    let mediaType = input.mediaType ?? null;
    const expectedHash: string | null = input.expectedHash ?? null;

    if (input.kind === "file_server_ref") {
      if (!input.uri) throw new Error("file-server reference requires a URI");
      let refId: string | null = null;
      try {
        const ref = await this.evidence.putFileServerReference({
          uri: input.uri,
          expectedHash,
          verificationStatus: "unverified",
        });
        refId = ref.id;
        return await this.persistEvidenceMetadata(caseId, actor, origin, clientTime, {
          id,
          kind: input.kind,
          filename: input.filename ?? null,
          uri,
          mediaType,
          byteLength: null,
          contentHash: null,
          expectedHash: ref.expectedHash,
          verificationStatus: ref.verificationStatus,
          refId: ref.id,
          privacyClass: privacy,
          sourceId: input.sourceId,
          summary: input.summary,
        });
      } catch (error) {
        if (refId && !(error instanceof CaseStoreCommitOutcomeUnknownError)) {
          await this.evidence.abandonFileServerReference(refId);
        }
        throw error;
      }
    }

    if (!input.bytes) throw new Error("held artifact requires bytes");
    mediaType = mediaType ?? (input.kind === "email" ? "message/rfc822" : "text/plain");
    assertUploadAllowed(mediaType, input.bytes.byteLength);
    if (expectedHash !== null && expectedHash !== sha256Hex(input.bytes)) {
      throw new Error("held evidence hash mismatch");
    }
    const stages: EvidenceStage[] = [];
    let evidenceBatch: EvidenceWriteBatch | null = null;
    let evidenceCommitted = false;
    try {
      evidenceBatch = await this.evidence.beginWriteBatch?.() ?? null;
      const result = await this.withAtomic(async () => {
        const sourceId = await this.resolveSourceId(actor, input.sourceId);
        let meta: { hash: string; byteLength: number };
        if (evidenceBatch) {
          meta = await evidenceBatch.put(input.bytes!, { contentType: mediaType ?? undefined });
        } else {
          const stage = await this.evidence.stage(input.bytes!, { contentType: mediaType ?? undefined });
          meta = stage.meta;
          stages.push(stage);
        }
        if (expectedHash !== null && expectedHash !== meta.hash) {
          throw new Error("held evidence hash mismatch");
        }
        const summaryInput: ContributionWriteInput = {
          kind: "upload",
          body: input.summary,
          privacyClass: privacy,
          sourceId,
        };
        if (clientTime !== null) summaryInput.clientTime = clientTime;
        const summary = await this.persistContribution(caseId, actor, summaryInput, origin);
        const row: ArtifactRow = {
          id,
          caseId,
          kind: input.kind,
          filename: input.filename ?? null,
          uri,
          mediaType,
          byteLength: meta.byteLength,
          contentHash: meta.hash,
          expectedHash,
          verificationStatus: "verified",
          refId: null,
          privacyClass: privacy,
          summaryContributionId: summary.id,
          uploaderId: actor.id,
          uploaderUsername: actor.username,
          sourceId,
        };
        await this.store.insertArtifact(row);
        await this.store.appendTimeline(caseId, {
          kind: "evidence_registered",
          actor,
          targetId: id,
          clientTime,
          payload: {
            artifactKind: input.kind,
            contentHash: meta.hash,
            privacyClass: privacy,
            summaryId: summary.id,
          },
        });
        await this.audit.append({
          identity: actor.id,
          action: "evidence_register",
          target: id,
          origin,
          outcome: "success",
        });
        if (evidenceBatch) {
          await evidenceBatch.promote();
        } else {
          for (const stage of stages) await stage.commit();
        }
        evidenceCommitted = true;
        if (!(await this.evidence.verify(meta.hash))) {
          throw new Error("hash verification failed after storage");
        }
        return { artifact: this.toArtifact(row), summary };
      });
      await evidenceBatch?.finalize();
      return result;
    } catch (error) {
      await settleEvidenceAfterCaseTransactionFailure(
        error,
        evidenceBatch,
        stages,
        evidenceCommitted,
      );
      throw error;
    } finally {
      for (const stage of stages) stage.release();
    }
  }

  async addStreamedEvidence(
    caseId: string,
    actor: Actor,
    input: {
      kind: ArtifactKind;
      filename?: string;
      mediaType?: string;
      source: AsyncIterable<Uint8Array>;
      expectedHash?: string | null;
      summary: string;
      privacyClass?: PrivacyClass;
      clientTime?: string;
      sourceId?: string;
      maxBytes: number;
      signal?: AbortSignal;
    },
    origin: string,
  ): Promise<{ artifact: ArtifactV1; summary: ContributionV1 }> {
    if (input.kind === "file_server_ref") {
      throw new Error("streaming evidence does not accept file-server references");
    }
    const clientTime = canonicalClientTime(input.clientTime);
    await this.requireCase(caseId);
    const privacy = defaultPrivacy(input.privacyClass);
    if (input.filename !== undefined) assertFilenameAllowed(input.filename);
    const id = randomUUID();
    const mediaType = input.mediaType
      ?? (input.kind === "email" ? "message/rfc822" : "text/plain");
    assertUploadAllowed(mediaType, 0);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new Error("upload exceeds size cap");
    }
    const expectedHash: string | null = input.expectedHash ?? null;
    throwIfStreamAborted(input.signal);
    let stage: EvidenceStreamStage | null = null;
    let evidenceCommitted = false;
    try {
      stage = await this.evidence.stageStream(
        nonEmptyStreamChunks(input.source, input.signal),
        {
          contentType: mediaType,
          maxBytes: input.maxBytes,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (expectedHash !== null && expectedHash !== stage.meta.hash) {
        throw new Error("held evidence hash mismatch");
      }
      const result = await this.withAtomic(async () => {
        const sourceId = await this.resolveSourceId(actor, input.sourceId);
        const summaryInput: ContributionWriteInput = {
          kind: "upload",
          body: input.summary,
          privacyClass: privacy,
          sourceId,
        };
        if (clientTime !== null) summaryInput.clientTime = clientTime;
        const summary = await this.persistContribution(caseId, actor, summaryInput, origin);
        const row: ArtifactRow = {
          id,
          caseId,
          kind: input.kind,
          filename: input.filename ?? null,
          uri: null,
          mediaType,
          byteLength: stage!.meta.byteLength,
          contentHash: stage!.meta.hash,
          expectedHash,
          verificationStatus: "verified",
          refId: null,
          privacyClass: privacy,
          summaryContributionId: summary.id,
          uploaderId: actor.id,
          uploaderUsername: actor.username,
          sourceId,
        };
        await this.store.insertArtifact(row);
        await this.store.appendTimeline(caseId, {
          kind: "evidence_registered",
          actor,
          targetId: id,
          clientTime,
          payload: {
            artifactKind: input.kind,
            contentHash: stage!.meta.hash,
            privacyClass: privacy,
            summaryId: summary.id,
          },
        });
        await this.audit.append({
          identity: actor.id,
          action: "evidence_register",
          target: id,
          origin,
          outcome: "success",
        });
        await stage!.promote();
        evidenceCommitted = true;
        if (!(await this.evidence.verify(stage!.meta.hash))) {
          throw new Error("hash verification failed after storage");
        }
        return { artifact: this.toArtifact(row), summary };
      });
      await stage.finalize();
      return result;
    } catch (error) {
      await settleStreamedEvidenceAfterCaseTransactionFailure(
        error,
        stage,
        evidenceCommitted,
      );
      throw error;
    }
  }

  async previewCorpusIntake(
    caseId: string,
    actor: Actor,
    raw: unknown,
  ): Promise<CorpusIntakePreviewReportV1> {
    await this.requireCase(caseId);
    const request = parseCorpusIntakePreviewRequest(raw);
    const artifacts = await this.store.listArtifactsByCase(caseId);
    const knownDigests = new Set(
      artifacts.map((row) => row.contentHash).filter((hash): hash is string => Boolean(hash)),
    );
    const files = request.files.map((file) => ({
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: decodeBase64(file.relativePath, file.contentBase64),
    }));
    const archive = request.archiveBase64
      ? decodeBase64("archive", request.archiveBase64)
      : null;
    return previewCorpusBytes({
      caseId,
      actorId: actor.id,
      origin: request.origin,
      privacyClass: request.privacyClass,
      sourceLabel: request.sourceLabel,
      idempotencyKey: request.idempotencyKey,
      files,
      archive,
      knownDigests,
    }).report;
  }

  async commitCorpusIntake(
    caseId: string,
    actor: Actor,
    raw: unknown,
    origin: string,
  ): Promise<CorpusIntakeBatchV1> {
    await this.requireCase(caseId);
    const request = parseCorpusIntakeCommitRequest(raw);
    const artifacts = await this.store.listArtifactsByCase(caseId);
    const knownDigests = new Set(
      artifacts.map((row) => row.contentHash).filter((hash): hash is string => Boolean(hash)),
    );
    const files = request.files.map((file) => ({
      relativePath: file.relativePath,
      mediaType: file.mediaType,
      bytes: decodeBase64(file.relativePath, file.contentBase64),
    }));
    const archive = request.archiveBase64
      ? decodeBase64("archive", request.archiveBase64)
      : null;
    const preview = previewCorpusBytes({
      caseId,
      actorId: actor.id,
      origin: request.origin,
      privacyClass: request.privacyClass,
      sourceLabel: request.sourceLabel,
      idempotencyKey: request.idempotencyKey,
      files,
      archive,
      knownDigests,
    });
    const requestDigest = corpusIntakeRequestDigest({
      caseId,
      actorId: actor.id,
      origin: request.origin,
      privacyClass: request.privacyClass,
      sourceLabel: request.sourceLabel,
      idempotencyKey: request.idempotencyKey,
      files,
      archive,
    });
    if (request.previewToken !== requestDigest || preview.report.previewToken !== requestDigest) {
      throw new CorpusIntakeConflictError("preview token does not match commit input");
    }
    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    const stages: EvidenceStage[] = [];
    let evidenceBatch: EvidenceWriteBatch | null = null;
    let evidenceCommitted = false;
    try {
      evidenceBatch = await this.evidence.beginWriteBatch?.() ?? null;
      const result = await this.withAtomic(async () => {
        await this.store.lockIntakeIdempotency(caseId, request.idempotencyKey);
        const replay = await this.store.getIntakeBatchByIdempotency(caseId, request.idempotencyKey);
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new CorpusIntakeConflictError("idempotency key already belongs to another request");
          }
          return { ...parseCorpusIntakeBatch(JSON.parse(replay.payloadJson)), replayed: true };
        }
        const sourceId = await this.resolveSourceId(actor);

        const metaByDigest = new Map<string, { hash: string; byteLength: number }>();
        const uniqueFiles = [...new Map(
          preview.classified.map((file) => [file.digest, file]),
        ).values()].sort((left, right) => left.digest.localeCompare(right.digest));
        for (const file of uniqueFiles) {
          await this.store.lockEvidenceDigest(file.digest);
          if (evidenceBatch) {
            const meta = await evidenceBatch.put(file.bytes, { contentType: file.mediaType });
            metaByDigest.set(file.digest, meta);
          } else {
            const stage = await this.evidence.stage(file.bytes, { contentType: file.mediaType });
            metaByDigest.set(file.digest, stage.meta);
            stages.push(stage);
          }
        }
        const liveArtifacts = await this.store.listArtifactsByCase(caseId);
        const liveKnown = new Set(
          liveArtifacts
            .map((row) => row.contentHash)
            .filter((hash): hash is string => Boolean(hash)),
        );
        const duplicateFlags = duplicateDigestFlags(
          preview.classified.map((file) => file.digest),
          liveKnown,
        );
        const items: CorpusIntakeBatchV1["items"] = preview.classified.map((file, index) => ({
          artifactId: randomUUID(),
          relativePath: file.relativePath,
          digest: file.digest,
          byteLength: file.bytes.byteLength,
          mediaType: file.mediaType,
          privacyClass: request.privacyClass,
          sourceId,
          duplicateDigest: duplicateFlags[index] ?? false,
          encodingStatus: file.encodingStatus,
        }));
        const batch: CorpusIntakeBatchV1 = {
          schemaId: CORPUS_INTAKE_BATCH_SCHEMA_ID,
          id: batchId,
          caseId,
          origin: request.origin,
          sourceLabel: request.sourceLabel,
          privacyClass: request.privacyClass,
          idempotencyKey: request.idempotencyKey,
          requestDigest,
          replayed: false,
          createdAt,
          createdBy: actor.id,
          items,
          rejected: preview.report.rejected,
        };
        await this.store.insertIntakeBatch({
          id: batchId,
          caseId,
          idempotencyKey: request.idempotencyKey,
          requestDigest,
          origin: request.origin,
          sourceLabel: request.sourceLabel,
          privacyClass: request.privacyClass,
          createdAt,
          createdBy: actor.id,
          payloadJson: JSON.stringify(batch),
        });

        for (const [index, file] of preview.classified.entries()) {
          const item = items[index];
          if (!item) throw new Error("intake item materialization failed");
          const meta = metaByDigest.get(file.digest);
          if (!meta) throw new Error("evidence stage is missing");
          const summary = await this.persistContribution(
            caseId,
            actor,
            {
              kind: "upload",
              body: `Corpus intake ${file.relativePath}`,
              privacyClass: request.privacyClass,
              sourceId,
            },
            origin,
          );
          await this.store.insertArtifact({
            id: item.artifactId,
            caseId,
            kind: file.artifactKind,
            filename: file.relativePath,
            uri: null,
            mediaType: file.mediaType,
            byteLength: meta.byteLength,
            contentHash: meta.hash,
            expectedHash: meta.hash,
            verificationStatus: "verified",
            refId: null,
            privacyClass: request.privacyClass,
            summaryContributionId: summary.id,
            uploaderId: actor.id,
            uploaderUsername: actor.username,
            sourceId,
            relativePath: file.relativePath,
            intakeBatchId: batchId,
          });
          await this.store.appendTimeline(caseId, {
            kind: "evidence_registered",
            actor,
            targetId: item.artifactId,
            clientTime: null,
            payload: {
              artifactKind: file.artifactKind,
              contentHash: meta.hash,
              privacyClass: request.privacyClass,
              summaryId: summary.id,
              relativePath: file.relativePath,
              intakeBatchId: batchId,
            },
          });
        }
        if (evidenceBatch) {
          await evidenceBatch.promote();
        } else {
          for (const stage of stages) await stage.commit();
        }
        evidenceCommitted = true;
        for (const meta of metaByDigest.values()) {
          if (!(await this.evidence.verify(meta.hash))) {
            throw new Error("hash verification failed after storage");
          }
        }
        await this.store.appendTimeline(caseId, {
          kind: "corpus_intake_committed",
          actor,
          targetId: batchId,
          clientTime: null,
          payload: { accepted: items.length, rejected: preview.report.rejected.length, origin: request.origin },
        });
        await this.audit.append({
          identity: actor.id,
          action: "corpus_intake_commit",
          target: batchId,
          origin,
          outcome: "success",
        });
        return batch;
      });
      await evidenceBatch?.finalize();
      return result;
    } catch (error) {
      await settleEvidenceAfterCaseTransactionFailure(
        error,
        evidenceBatch,
        stages,
        evidenceCommitted,
      );
      throw error;
    } finally {
      for (const stage of stages) stage.release();
    }
  }

  async getCorpusIntakeBatch(caseId: string, batchId: string): Promise<CorpusIntakeBatchV1 | null> {
    const row = await this.store.getIntakeBatch(caseId, batchId);
    if (!row) return null;
    return parseCorpusIntakeBatch(JSON.parse(row.payloadJson));
  }

  async getArtifact(caseId: string, artifactId: string): Promise<ArtifactV1 | null> {
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId) return null;
    return this.toArtifact(row);
  }

  async getReadableHeldArtifact(
    caseId: string,
    artifactId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<ArtifactRow | null> {
    const caseRow = await this.store.getCase(caseId);
    if (!caseRow) return null;
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId) return null;
    if (
      !row.contentHash
      || !isContentHash(row.contentHash)
      || row.byteLength === null
      || row.refId
    ) {
      return null;
    }
    if (row.privacyClass === "owner_only") {
      if (!canReadPrivate) return null;
      if (!isAdmin && !this.isMember(caseRow, actor.id)) return null;
    }
    return row;
  }

  async getArtifactBytes(
    caseId: string,
    artifactId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<Uint8Array | null> {
    await this.requireCase(caseId);
    const row = await this.getReadableHeldArtifact(
      caseId,
      artifactId,
      actor,
      isAdmin,
      canReadPrivate,
    );
    if (!row?.contentHash) return null;
    return this.evidence.get(row.contentHash);
  }

  async getArtifactJsonBytes(
    caseId: string,
    artifactId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<
    { outcome: "not_found" } | { outcome: "too_large" } | { outcome: "ok"; bytes: Uint8Array }
  > {
    await this.requireCase(caseId);
    const row = await this.getReadableHeldArtifact(
      caseId,
      artifactId,
      actor,
      isAdmin,
      canReadPrivate,
    );
    if (!row?.contentHash || row.byteLength === null) return { outcome: "not_found" };
    if (row.byteLength > MAX_UPLOAD_BYTES) return { outcome: "too_large" };
    const bytes = await this.evidence.get(row.contentHash);
    if (!bytes) return { outcome: "not_found" };
    return { outcome: "ok", bytes };
  }

  async headEvidence(hash: string): Promise<BlobMetaV1 | null> {
    if (!isContentHash(hash)) return null;
    return this.evidence.head(hash);
  }

  async openEvidenceRead(
    hash: string,
    range?: EvidenceReadRange,
  ): Promise<EvidenceReadHandle> {
    if (!isContentHash(hash)) {
      throw new Error("invalid content hash");
    }
    return this.evidence.openRead(hash as ContentHash, range);
  }

  async recheckReference(
    caseId: string,
    artifactId: string,
    actor: Actor,
    origin: string,
  ): Promise<{ artifact: ArtifactV1; status: string }> {
    const row = await this.store.getArtifact(artifactId);
    if (!row || row.caseId !== caseId || !row.refId) {
      throw new Error("file-server reference not found");
    }
    const snapshot = { ...row };
    const previous = await this.evidence.getFileServerReference(row.refId);
    if (!previous) throw new Error("file-server reference not found");
    try {
      const checked = await this.evidence.verifyFileServerReference(row.refId);
      await this.store.withAtomic(async () => {
        await this.store.appendTimeline(caseId, {
          kind: "evidence_recheck",
          actor,
          targetId: artifactId,
          clientTime: null,
          payload: {
            verificationStatus: checked.verificationStatus,
            originalVerificationStatus: snapshot.verificationStatus,
          },
        });
        await this.audit.append({
          identity: actor.id,
          action: "evidence_recheck",
          target: artifactId,
          origin,
          outcome: checked.verificationStatus === "verified" ? "success" : "failure",
        });
      }, this.audit);
      return { artifact: this.toArtifact(snapshot), status: checked.verificationStatus };
    } catch (error) {
      await this.evidence.restoreFileServerReference(previous);
      throw error;
    }
  }

  async isMemberOf(caseId: string, identityId: string): Promise<boolean> {
    const row = await this.store.getCase(caseId);
    return row ? this.isMember(row, identityId) : false;
  }

  private isMember(row: { participants: { identityId: string }[] }, identityId: string): boolean {
    return row.participants.some((p) => p.identityId === identityId);
  }

  private async persistEvidenceMetadata(
    caseId: string,
    actor: Actor,
    origin: string,
    clientTime: string | null,
    input: {
      id: string;
      kind: ArtifactKind;
      filename: string | null;
      uri: string | null;
      mediaType: string | null;
      byteLength: number | null;
      contentHash: string | null;
      expectedHash: string | null;
      verificationStatus: string | null;
      refId: string | null;
      privacyClass: PrivacyClass;
      sourceId: string | undefined;
      summary: string;
    },
  ): Promise<{ artifact: ArtifactV1; summary: ContributionV1 }> {
    return this.withAtomic(async () => {
      const sourceId = await this.resolveSourceId(actor, input.sourceId);
      const summaryInput: ContributionWriteInput = {
        kind: "upload",
        body: input.summary,
        privacyClass: input.privacyClass,
        sourceId,
      };
      if (clientTime !== null) summaryInput.clientTime = clientTime;
      const summary = await this.persistContribution(caseId, actor, summaryInput, origin);
      const row: ArtifactRow = {
        id: input.id,
        caseId,
        kind: input.kind,
        filename: input.filename,
        uri: input.uri,
        mediaType: input.mediaType,
        byteLength: input.byteLength,
        contentHash: input.contentHash,
        expectedHash: input.expectedHash,
        verificationStatus: input.verificationStatus,
        refId: input.refId,
        privacyClass: input.privacyClass,
        summaryContributionId: summary.id,
        uploaderId: actor.id,
        uploaderUsername: actor.username,
        sourceId,
      };
      await this.store.insertArtifact(row);
      await this.store.appendTimeline(caseId, {
        kind: "evidence_registered",
        actor,
        targetId: input.id,
        clientTime,
        payload: {
          artifactKind: input.kind,
          contentHash: input.contentHash,
          privacyClass: input.privacyClass,
          summaryId: summary.id,
        },
      });
      await this.audit.append({
        identity: actor.id,
        action: "evidence_register",
        target: input.id,
        origin,
        outcome: "success",
      });
      return { artifact: this.toArtifact(row), summary };
    });
  }

  private async replayContributionWrite(
    caseId: string,
    actorId: string,
    key: string,
    digest: string,
  ): Promise<ContributionV1> {
    const existing = await this.store.getContributionIdempotency(caseId, actorId, key);
    if (!existing || existing.requestDigest !== digest) {
      throw new ContributionConflictError();
    }
    return this.loadContribution(caseId, existing.contributionId);
  }

  private async loadContribution(caseId: string, contributionId: string): Promise<ContributionV1> {
    const chain = await this.store.listRevisions(contributionId);
    const created = chain.find((row) => row.revision === 1) ?? chain[0];
    if (!created || created.caseId !== caseId) {
      throw new Error("contribution not found");
    }
    return this.toContribution(created, false);
  }

  private async requireCase(id: string) {
    const row = await this.store.getCase(id);
    if (!row) throw new Error("case not found");
    return row;
  }

  private async requireLatest(caseId: string, contributionId: string): Promise<RevisionRow> {
    const chain = await this.store.listRevisions(contributionId);
    if (!chain.length || chain[0]?.caseId !== caseId) {
      throw new Error("contribution not found");
    }
    const latest = chain[chain.length - 1];
    if (!latest) throw new Error("contribution not found");
    return latest;
  }

  /**
   * A contribution may carry links only when it is a hypothesis. Structural
   * validity and case-local existence are decided by the server before any
   * revision, idempotency intent, timeline row, or audit record is written.
   */
  private async validatedContributionLinks(
    caseId: string,
    kind: ContributionKind,
    raw: unknown,
  ): Promise<HypothesisLinkInput[]> {
    if (raw === undefined) return [];
    if (kind !== "hypothesis") {
      throw new ContractViolation(
        "$.hypothesisLinks",
        "links require a hypothesis contribution",
      );
    }
    return this.validatedHypothesisLinks(caseId, raw, "$.hypothesisLinks");
  }

  /** Resolve every link under the same case transaction that persists it. */
  private async validatedHypothesisLinks(
    caseId: string,
    raw: unknown,
    path: string,
  ): Promise<HypothesisLinkInput[]> {
    const links = parseHypothesisLinks(raw, path);
    for (const [index, link] of links.entries()) {
      const invalidReference = () => new ContractViolation(
        `${path}[${index}].id`,
        "must reference an existing artifact or contribution in this investigation",
      );
      // PostgreSQL stores both namespaces as UUID columns. Reject malformed
      // values at the domain boundary so they never reach a driver cast and so
      // memory and PostgreSQL return the same bounded contract failure.
      if (!isRfc4122Uuid(link.id)) throw invalidReference();
      let belongsToCase: boolean;
      if (link.kind === "artifact") {
        belongsToCase = (await this.store.getArtifact(link.id))?.caseId === caseId;
      } else {
        const revisions = await this.store.listRevisions(link.id);
        belongsToCase = revisions.length > 0
          && revisions.every((revision) => revision.caseId === caseId);
      }
      if (!belongsToCase) {
        throw invalidReference();
      }
    }
    return links;
  }

  private toCase(row: {
    id: string;
    title: string;
    problemStatement?: string;
    affectedParties?: string;
    impact?: string;
    scope?: string;
    openQuestions?: string[];
    situationVersion?: number;
    investigationContext?: InvestigationContextV1 | null;
    occurredAt?: string | null;
    occurredAtPrecision?: OccurredAtPrecision;
    occurredAtZone?: OccurredAtZone;
    severity: CaseSeverity;
    status: CaseStatus;
    legalHold: boolean;
    retentionClass: string;
    participants: { identityId: string; username: string }[];
    createdAt: string;
    createdBy: string;
  }): CaseV1 {
    return {
      schemaId: CASE_SCHEMA_ID,
      id: row.id,
      title: row.title,
      problemStatement: row.problemStatement ?? "",
      affectedParties: row.affectedParties ?? "",
      impact: row.impact ?? "",
      scope: row.scope ?? "",
      openQuestions: row.openQuestions ? [...row.openQuestions] : [],
      situationVersion: row.situationVersion ?? 0,
      investigationContext: row.investigationContext ?? null,
      occurredAt: row.occurredAt ?? null,
      occurredAtPrecision: row.occurredAtPrecision ?? "unknown",
      occurredAtZone: row.occurredAtZone ?? "unspecified",
      severity: row.severity,
      status: row.status,
      legalHold: row.legalHold,
      retentionClass: row.retentionClass,
      participants: row.participants.map((p) => ({
        identityId: p.identityId,
        username: p.username,
      })),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    };
  }

  private toContribution(rev: RevisionRow, hide: boolean): ContributionV1 {
    return {
      schemaId: CONTRIBUTION_SCHEMA_ID,
      id: rev.contributionId,
      caseId: rev.caseId,
      kind: rev.kind,
      revision: rev.revision,
      predecessorRevision: rev.predecessorRevision,
      body: hide ? visibleBody(true, rev.body) : rev.body,
      contentHash: rev.contentHash,
      privacyClass: rev.privacyClass,
      tombstoned: rev.tombstone,
      authorId: rev.authorId,
      authorUsername: rev.authorUsername,
      createdAt: rev.createdAt,
      hypothesisStatus: rev.hypothesisStatus,
      hypothesisLinks: rev.kind === "hypothesis" ? rev.hypothesisLinks : null,
      sourceId: rev.sourceId,
    };
  }

  private toArtifact(row: ArtifactRow): ArtifactV1 {
    return {
      schemaId: ARTIFACT_SCHEMA_ID,
      id: row.id,
      caseId: row.caseId,
      kind: row.kind,
      filename: row.filename,
      uri: row.uri,
      mediaType: row.mediaType,
      byteLength: row.byteLength,
      contentHash: row.contentHash,
      expectedHash: row.expectedHash,
      verificationStatus: row.verificationStatus,
      privacyClass: row.privacyClass,
      summaryContributionId: row.summaryContributionId,
      uploaderId: row.uploaderId,
      sourceId: row.sourceId,
      relativePath: row.relativePath ?? row.filename,
      intakeBatchId: row.intakeBatchId ?? null,
    };
  }

  private async resolveSourceId(actor: Actor, sourceId?: string): Promise<string> {
    if (sourceId) {
      const found = await this.catalog.get(sourceId);
      if (!found) throw new Error("source not found");
      return found.id;
    }
    return (await this.catalog.ensureHumanSource(actor)).id;
  }
}

export { LegalHoldError };
export { MemoryCaseStore, PgCaseStore } from "./store.js";
export type { CaseStore } from "./store.js";
