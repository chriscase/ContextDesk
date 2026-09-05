import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import {
  parseSnapshot,
  SNAPSHOT_SCHEMA_ID,
  CASE_SEVERITIES,
  CASE_STATUSES,
  normalizeInvestigationContext,
  OVERVIEW_OPEN_STATUSES,
  type ArtifactKind,
  type CaseSeverity,
  type CaseStatus,
  type ContributionKind,
  type HypothesisStatus,
  type InvestigationCoordinatorIdentityV1,
  type OverviewOpenStatus,
  type OverviewSeverityCountsV1,
  type OverviewStatusCountsV1,
  type InvestigationContextV1,
  type OccurredAtPrecision,
  type OccurredAtZone,
  type PrivacyClass,
  type SnapshotV1,
} from "@cd-collab/contracts";
import {
  MemoryAuditStore,
  PgAuditStore,
  type AuditRecord,
  type AuditStore,
} from "../audit/index.js";
export interface Actor {
  id: string;
  username: string;
}

/**
 * PostgreSQL COMMIT was attempted and its outcome is unknown.
 *
 * The acknowledgement may have been lost after the transaction applied.
 * Callers must not ROLLBACK, must not report success, and must not retry
 * the same write as if it definitely failed.
 */
export class CaseStoreCommitOutcomeUnknownError extends Error {
  constructor() {
    super("case-store transaction commit outcome is unknown");
    this.name = "CaseStoreCommitOutcomeUnknownError";
  }
}

export interface TimelineRow {
  seq: number;
  kind: string;
  actorId: string;
  actorUsername: string;
  targetId: string | null;
  clientTime: string | null;
  serverTime: string;
  payload: string;
}

export interface CaseTimelineRow extends TimelineRow {
  caseId: string;
}

export interface CaseRow {
  id: string;
  title: string;
  problemStatement?: string;
  affectedParties?: string;
  impact?: string;
  scope?: string;
  openQuestions?: string[];
  situationVersion?: number;
  investigationContext?: InvestigationContextV1 | null;
  /**
   * When the investigated work actually happened, as recorded. Literal text,
   * so an unknown time zone is never guessed into UTC. `createdAt` keeps
   * saying when the row was written and is never rewritten by a backfill.
   */
  occurredAt?: string | null;
  occurredAtPrecision?: OccurredAtPrecision;
  occurredAtZone?: OccurredAtZone;
  severity: CaseSeverity;
  status: CaseStatus;
  legalHold: boolean;
  retentionClass: string;
  createdAt: string;
  createdBy: string;
  createdByUsername: string;
  participants: { identityId: string; username: string }[];
}

export interface RevisionRow {
  contributionId: string;
  caseId: string;
  kind: ContributionKind;
  revision: number;
  predecessorRevision: number | null;
  body: string;
  contentHash: string;
  privacyClass: PrivacyClass;
  tombstone: boolean;
  authorId: string;
  authorUsername: string;
  createdAt: string;
  hypothesisStatus: HypothesisStatus | null;
  hypothesisLinks: { kind: "artifact" | "contribution"; id: string }[];
  sourceId: string;
}

export interface ArtifactRow {
  id: string;
  caseId: string;
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
  summaryContributionId: string | null;
  uploaderId: string;
  uploaderUsername: string;
  sourceId: string;
  relativePath?: string | null;
  intakeBatchId?: string | null;
}

/** Durable, insert-only annotation attached to one evidence artifact. */
export interface ArtifactAnnotationRow {
  id: string;
  caseId: string;
  artifactId: string;
  body: string;
  contentHash: string;
  privacyClass: PrivacyClass;
  authorId: string;
  authorUsername: string;
  createdAt: string;
  sourceId: string;
}

/** Insert-only intent record used to make annotation retries replay-safe. */
export interface ArtifactAnnotationWriteIntent {
  caseId: string;
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
  annotationId: string;
  createdAt: string;
}

/** One parent intent owns the complete, deterministic result of a bulk request. */
export interface ArtifactAnnotationBulkWriteIntent {
  caseId: string;
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
  resultJson: string;
  createdAt: string;
}

/** Materialized answer to who currently coordinates one investigation. */
export interface InvestigationCoordinationRow {
  caseId: string;
  coordinator: InvestigationCoordinatorIdentityV1 | null;
  revision: number;
  updatedAt: string;
  updatedBy: InvestigationCoordinatorIdentityV1;
}

/** One visibility-scoped, statement-consistent case and coordination read. */
export interface CaseCoordinationSnapshotRow {
  caseRow: CaseRow;
  coordination: InvestigationCoordinationRow | null;
}

/** Insert-only successful command envelope used for exact retry replay. */
export interface InvestigationCoordinationSuccessIntent {
  caseId: string;
  actorId: string;
  idempotencyKey: string;
  action: "claim_self" | "release_self" | "assign_participant" | "release_participant";
  targetIdentityId: string | null;
  successJson: string;
  createdAt: string;
}

export interface IntakeBatchRow {
  id: string;
  caseId: string;
  idempotencyKey: string;
  requestDigest: string;
  origin: string;
  sourceLabel: string;
  privacyClass: PrivacyClass;
  createdAt: string;
  createdBy: string;
  payloadJson: string;
}

export interface ContributionWriteIntent {
  caseId: string;
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
  contributionId: string;
  createdAt: string;
}

export type SnapshotRow = SnapshotV1;

export interface TimelineInsert {
  kind: string;
  actor: Actor;
  targetId: string | null;
  clientTime: string | null;
  /** Server-owned historical timestamp used only by verified portable restore. */
  serverTime?: string;
  payload: unknown;
}

export interface AtomicSituationUpdate {
  id: string;
  expectedVersion: number;
  situation: {
    problemStatement: string;
    affectedParties: string;
    impact: string;
    scope: string;
    openQuestions: string[];
    investigationContext: InvestigationContextV1 | null;
  };
  changedFields: string[];
  timeline: TimelineInsert;
  audit: AuditRecord;
}

export type AtomicSituationUpdateResult =
  | { status: "updated" | "unchanged"; row: CaseRow }
  | { status: "conflict"; currentVersion: number }
  | { status: "not_found" };

export type AtomicBoundary = <T>(operation: () => Promise<T>) => Promise<T>;

function serializedAtomicBoundary(boundary: AtomicBoundary): AtomicBoundary {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(
      () => boundary(operation),
      () => boundary(operation),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export interface OverviewScope {
  actorId: string;
  isAdmin: boolean;
}

export interface ActivityPageCursor {
  serverTime: string;
  caseId: string;
  seq: number;
}

export interface ActivityPageQuery {
  caseId?: string;
  scope?: OverviewScope;
  limit: number;
  after?: ActivityPageCursor;
}

/**
 * Process-local visibility boundary used by memory-backed Overview stores.
 * PostgreSQL stores correlate visibility inside SQL and therefore return null.
 */
export interface OverviewVisibilityBoundary {
  caseTitle(caseId: string): string | null;
}

export interface OverviewActivityRow {
  caseId: string;
  title: string;
  kind: string;
  actor: string;
  serverTime: string;
  seq: number;
}

export interface OverviewOpenCaseRow {
  id: string;
  title: string;
  status: OverviewOpenStatus;
  severity: CaseSeverity;
  createdAt: string;
}

export interface OverviewCounts {
  status: OverviewStatusCountsV1;
  severity: OverviewSeverityCountsV1;
}

export function overviewVisiblePredicate(
  caseIdExpr: string,
  adminParam: string,
  actorParam: string,
): string {
  return `(${adminParam}::boolean OR EXISTS (
    SELECT 1 FROM case_participants p
    WHERE p.case_id = ${caseIdExpr} AND p.identity_id = ${actorParam}
  ))`;
}

export function isOverviewVisibleCase(
  row: { participants: { identityId: string }[] },
  scope: OverviewScope,
): boolean {
  return scope.isAdmin || row.participants.some((participant) => participant.identityId === scope.actorId);
}

export function compareActivityDesc(
  left: { serverTime: string; caseId: string; seq: number },
  right: { serverTime: string; caseId: string; seq: number },
): number {
  const byTime = right.serverTime.localeCompare(left.serverTime);
  if (byTime !== 0) return byTime;
  const byCase = left.caseId.localeCompare(right.caseId);
  return byCase !== 0 ? byCase : right.seq - left.seq;
}

export function activityComesAfter(
  event: { serverTime: string; caseId: string; seq: number },
  cursor: ActivityPageCursor,
): boolean {
  if (event.serverTime < cursor.serverTime) return true;
  if (event.serverTime > cursor.serverTime) return false;
  if (event.caseId > cursor.caseId) return true;
  if (event.caseId < cursor.caseId) return false;
  return event.seq < cursor.seq;
}

function emptyOverviewCounts(): OverviewCounts {
  return {
    status: { open: 0, monitoring: 0, resolved: 0, archived: 0 },
    severity: { low: 0, medium: 0, high: 0, critical: 0 },
  };
}

function isOverviewOpenStatus(status: string): status is OverviewOpenStatus {
  return (OVERVIEW_OPEN_STATUSES as readonly string[]).includes(status);
}

function compareOverviewOpenCases(left: OverviewOpenCaseRow, right: OverviewOpenCaseRow): number {
  const byCreated = right.createdAt.localeCompare(left.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
}

function addReferencedHash(into: Set<string>, value: string | null | undefined): void {
  if (value && /^[0-9a-f]{64}$/.test(value)) into.add(value);
}

/**
 * Destination keys this module owns, addressed one batch at a time. Portable
 * apply probes these to decide collisions without enumerating the corpus.
 */
export const CASE_PROBE_KINDS = ["case", "contribution", "artifact", "snapshot", "intake_batch"] as const;
export type CaseProbeKind = (typeof CASE_PROBE_KINDS)[number];

export interface ParticipantIdentityRow {
  identityId: string;
  username: string;
}

/** Whose view a participant probe is answered from. */
export interface ParticipantVisibilityScope {
  actorId: string;
  isAdmin: boolean;
}

export interface CaseStore {
  listCases(): Promise<CaseRow[]>;
  listCaseCoordinationSnapshot(
    scope: OverviewScope,
  ): Promise<CaseCoordinationSnapshotRow[]>;
  getCase(id: string): Promise<CaseRow | null>;
  /**
   * Lock and reload one case inside `withAtomic`.
   *
   * Mutation decisions that depend on case metadata must use this read rather
   * than a preview obtained before the atomic boundary.
   */
  lockCase(id: string): Promise<CaseRow | null>;
  insertCase(row: CaseRow): Promise<void>;
  updateCaseMeta(row: { id: string; status?: CaseRow["status"]; legalHold?: boolean }): Promise<void>;
  updateOccurredAt(
    id: string,
    occurrence: {
      occurredAt: string | null;
      occurredAtPrecision: OccurredAtPrecision;
      occurredAtZone: OccurredAtZone;
    },
  ): Promise<void>;
  updateSituationAtomic(
    input: AtomicSituationUpdate,
    audit: AuditStore,
  ): Promise<AtomicSituationUpdateResult>;
  addParticipant(
    caseId: string,
    participant: { identityId: string; username: string },
    addedBy: string,
  ): Promise<void>;
  listTimeline(caseId: string): Promise<TimelineRow[]>;
  listRecentTimeline(caseIds: string[], limit: number): Promise<CaseTimelineRow[]>;
  listActivityPage(query: ActivityPageQuery): Promise<CaseTimelineRow[]>;
  overviewVisibilityBoundary(scope: OverviewScope): Promise<OverviewVisibilityBoundary | null>;
  overviewCounts(scope: OverviewScope): Promise<OverviewCounts>;
  listOverviewOpenCases(scope: OverviewScope, limit: number): Promise<OverviewOpenCaseRow[]>;
  listOverviewActivity(scope: OverviewScope, limit: number): Promise<OverviewActivityRow[]>;
  appendTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow>;
  listRevisions(contributionId: string): Promise<RevisionRow[]>;
  listLatestRevisions(caseId: string): Promise<RevisionRow[]>;
  insertRevision(rev: RevisionRow): Promise<void>;
  getArtifact(artifactId: string): Promise<ArtifactRow | null>;
  getArtifactsByIds(artifactIds: readonly string[]): Promise<ArtifactRow[]>;
  listArtifactsByCase(caseId: string): Promise<ArtifactRow[]>;
  listArtifactAnnotationsByCase(caseId: string): Promise<ArtifactAnnotationRow[]>;
  listReferencedContentHashes(): Promise<ReadonlySet<string>>;
  listReferencedContentHashes(): Promise<ReadonlySet<string>>;
  insertArtifact(row: ArtifactRow): Promise<void>;
  insertArtifactAnnotation(row: ArtifactAnnotationRow): Promise<void>;
  lockArtifactAnnotationIdempotency(caseId: string, actorId: string, key: string): Promise<void>;
  getArtifactAnnotationIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationWriteIntent | null>;
  insertArtifactAnnotationIdempotency(row: ArtifactAnnotationWriteIntent): Promise<void>;
  lockArtifactAnnotationBulkIdempotency(caseId: string, actorId: string, key: string): Promise<void>;
  getArtifactAnnotationBulkIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationBulkWriteIntent | null>;
  insertArtifactAnnotationBulkIdempotency(row: ArtifactAnnotationBulkWriteIntent): Promise<void>;
  getInvestigationCoordination(caseId: string): Promise<InvestigationCoordinationRow | null>;
  saveInvestigationCoordination(row: InvestigationCoordinationRow): Promise<void>;
  getInvestigationCoordinationSuccessIntent(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<InvestigationCoordinationSuccessIntent | null>;
  insertInvestigationCoordinationSuccessIntent(
    row: InvestigationCoordinationSuccessIntent,
  ): Promise<void>;
  withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T>;
  lockIntakeIdempotency(caseId: string, key: string): Promise<void>;
  lockEvidenceDigest(digest: string): Promise<void>;
  getIntakeBatchByIdempotency(caseId: string, key: string): Promise<IntakeBatchRow | null>;
  getIntakeBatch(caseId: string, batchId: string): Promise<IntakeBatchRow | null>;
  insertIntakeBatch(row: IntakeBatchRow): Promise<void>;
  lockContributionIdempotency(caseId: string, actorId: string, key: string): Promise<void>;
  getContributionIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ContributionWriteIntent | null>;
  insertContributionIdempotency(row: ContributionWriteIntent): Promise<void>;
  listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]>;
  getSnapshot(snapshotId: string): Promise<SnapshotRow | null>;
  insertSnapshot(row: SnapshotRow): Promise<void>;
  /**
   * Returns the subset of `ids` that already key a row of `kind`. Host-owned
   * and batched: one round trip per kind, and cost follows the probed id count
   * rather than the size of the destination corpus. Never filtered by actor
   * visibility — an invisible row still occupies the key.
   */
  probeExistingIds(kind: CaseProbeKind, ids: readonly string[]): Promise<string[]>;
  /**
   * Distinct participant identities matching any supplied id or username,
   * restricted to what `scope` may already see: every case for an admin, and
   * otherwise only cases the scoped actor participates in. Targeted lookup for
   * identity mapping; never an enumeration of people, and never wider than the
   * caller's existing view.
   */
  probeParticipants(input: {
    scope: ParticipantVisibilityScope;
    identityIds?: readonly string[];
    usernames?: readonly string[];
  }): Promise<ParticipantIdentityRow[]>;
}

export type Queryable = Pick<Pool, "query">;

export class MemoryCaseStore implements CaseStore {
  private readonly cases = new Map<string, CaseRow>();
  private readonly timeline = new Map<string, TimelineRow[]>();
  private readonly revisions = new Map<string, RevisionRow[]>();
  private readonly artifacts = new Map<string, ArtifactRow>();
  private readonly artifactAnnotations = new Map<string, ArtifactAnnotationRow>();
  private readonly artifactAnnotationIntents = new Map<string, ArtifactAnnotationWriteIntent>();
  private readonly artifactAnnotationBulkIntents = new Map<string, ArtifactAnnotationBulkWriteIntent>();
  private readonly investigationCoordinations = new Map<string, InvestigationCoordinationRow>();
  private readonly investigationCoordinationSuccessIntents = new Map<string, InvestigationCoordinationSuccessIntent>();
  private readonly snapshots = new Map<string, SnapshotRow>();
  private readonly intakeBatches = new Map<string, IntakeBatchRow>();
  private readonly contributionIntents = new Map<string, ContributionWriteIntent>();
  private readonly atomicBoundary: AtomicBoundary;
  private readonly atomicContext = new AsyncLocalStorage<boolean>();

  constructor(boundary: AtomicBoundary = async (operation) => operation()) {
    this.atomicBoundary = serializedAtomicBoundary(boundary);
  }

  capture(): unknown {
    return structuredClone({
      cases: [...this.cases.entries()],
      timeline: [...this.timeline.entries()],
      revisions: [...this.revisions.entries()],
      artifacts: [...this.artifacts.entries()],
      artifactAnnotations: [...this.artifactAnnotations.entries()],
      artifactAnnotationIntents: [...this.artifactAnnotationIntents.entries()],
      artifactAnnotationBulkIntents: [...this.artifactAnnotationBulkIntents.entries()],
      investigationCoordinations: [...this.investigationCoordinations.entries()],
      investigationCoordinationSuccessIntents: [...this.investigationCoordinationSuccessIntents.entries()],
      snapshots: [...this.snapshots.entries()],
      intakeBatches: [...this.intakeBatches.entries()],
      contributionIntents: [...this.contributionIntents.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as {
      cases: [string, CaseRow][];
      timeline: [string, TimelineRow[]][];
      revisions: [string, RevisionRow[]][];
      artifacts: [string, ArtifactRow][];
      artifactAnnotations?: [string, ArtifactAnnotationRow][];
      artifactAnnotationIntents?: [string, ArtifactAnnotationWriteIntent][];
      artifactAnnotationBulkIntents?: [string, ArtifactAnnotationBulkWriteIntent][];
      investigationCoordinations?: [string, InvestigationCoordinationRow][];
      investigationCoordinationSuccessIntents?: [string, InvestigationCoordinationSuccessIntent][];
      snapshots: [string, SnapshotRow][];
      intakeBatches: [string, IntakeBatchRow][];
      contributionIntents?: [string, ContributionWriteIntent][];
    };
    this.cases.clear();
    this.timeline.clear();
    this.revisions.clear();
    this.artifacts.clear();
    this.artifactAnnotations.clear();
    this.artifactAnnotationIntents.clear();
    this.artifactAnnotationBulkIntents.clear();
    this.investigationCoordinations.clear();
    this.investigationCoordinationSuccessIntents.clear();
    this.snapshots.clear();
    this.intakeBatches.clear();
    this.contributionIntents.clear();
    for (const [id, value] of row.cases) this.cases.set(id, value);
    for (const [id, value] of row.timeline) this.timeline.set(id, value);
    for (const [id, value] of row.revisions) this.revisions.set(id, value);
    for (const [id, value] of row.artifacts) this.artifacts.set(id, value);
    for (const [id, value] of row.artifactAnnotations ?? []) this.artifactAnnotations.set(id, value);
    for (const [id, value] of row.artifactAnnotationIntents ?? []) this.artifactAnnotationIntents.set(id, value);
    for (const [id, value] of row.artifactAnnotationBulkIntents ?? []) this.artifactAnnotationBulkIntents.set(id, value);
    for (const [id, value] of row.investigationCoordinations ?? []) this.investigationCoordinations.set(id, value);
    for (const [id, value] of row.investigationCoordinationSuccessIntents ?? []) {
      this.investigationCoordinationSuccessIntents.set(id, value);
    }
    for (const [id, value] of row.snapshots) this.snapshots.set(id, value);
    for (const [id, value] of row.intakeBatches) this.intakeBatches.set(id, value);
    for (const [id, value] of row.contributionIntents ?? []) this.contributionIntents.set(id, value);
  }

  async listCases(): Promise<CaseRow[]> {
    return [...this.cases.values()].map((row) => cloneCase(row));
  }

  async listCaseCoordinationSnapshot(
    scope: OverviewScope,
  ): Promise<CaseCoordinationSnapshotRow[]> {
    const snapshot: CaseCoordinationSnapshotRow[] = [];
    for (const row of this.cases.values()) {
      if (!isOverviewVisibleCase(row, scope)) continue;
      const coordination = this.investigationCoordinations.get(row.id);
      snapshot.push({
        caseRow: cloneCase(row),
        coordination: coordination ? cloneInvestigationCoordinationRow(coordination) : null,
      });
    }
    return snapshot;
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const row = this.cases.get(id);
    return row ? cloneCase(row) : null;
  }

  async lockCase(id: string): Promise<CaseRow | null> {
    if (!this.atomicContext.getStore()) {
      throw new Error("case lock requires an atomic boundary");
    }
    const row = this.cases.get(id);
    // The serialized atomic boundary is the memory lock. Return a clone so a
    // decision cannot mutate the stored row without an explicit store write.
    return row ? cloneCase(row) : null;
  }

  async insertCase(row: CaseRow): Promise<void> {
    this.cases.set(row.id, cloneCase(row));
    this.timeline.set(row.id, []);
  }

  async updateCaseMeta(row: { id: string; status?: CaseRow["status"]; legalHold?: boolean }): Promise<void> {
    const existing = this.cases.get(row.id);
    if (!existing) throw new Error("case not found");
    if (row.status === undefined && row.legalHold === undefined) {
      throw new Error("case meta update requires status or legalHold");
    }
    if (row.status !== undefined) existing.status = row.status;
    if (row.legalHold !== undefined) existing.legalHold = row.legalHold;
  }

  async updateOccurredAt(
    id: string,
    occurrence: {
      occurredAt: string | null;
      occurredAtPrecision: OccurredAtPrecision;
      occurredAtZone: OccurredAtZone;
    },
  ): Promise<void> {
    const existing = this.cases.get(id);
    if (!existing) throw new Error("case not found");
    existing.occurredAt = occurrence.occurredAt;
    existing.occurredAtPrecision = occurrence.occurredAtPrecision;
    existing.occurredAtZone = occurrence.occurredAtZone;
  }

  async updateSituationAtomic(
    input: AtomicSituationUpdate,
    audit: AuditStore,
  ): Promise<AtomicSituationUpdateResult> {
    return this.atomicBoundary(async () => {
      const existing = this.cases.get(input.id);
      if (!existing) return { status: "not_found" };
      const currentVersion = existing.situationVersion ?? 0;
      if (currentVersion !== input.expectedVersion) {
        return { status: "conflict", currentVersion };
      }
      if (input.changedFields.length === 0) {
        return { status: "unchanged", row: cloneCase(existing) };
      }

      const before = cloneCase(existing);
      const timelineBefore = [...(this.timeline.get(input.id) ?? [])];
      try {
        existing.problemStatement = input.situation.problemStatement;
        existing.affectedParties = input.situation.affectedParties;
        existing.impact = input.situation.impact;
        existing.scope = input.situation.scope;
        existing.openQuestions = [...input.situation.openQuestions];
        existing.investigationContext = input.situation.investigationContext;
        existing.situationVersion = currentVersion + 1;
        this.appendTimelineInMemory(input.id, input.timeline);
        await audit.append(input.audit);
        return { status: "updated", row: cloneCase(existing) };
      } catch (error) {
        this.cases.set(input.id, before);
        this.timeline.set(input.id, timelineBefore);
        throw error;
      }
    });
  }

  private appendTimelineInMemory(caseId: string, event: TimelineInsert): TimelineRow {
    const list = this.timeline.get(caseId) ?? [];
    const row: TimelineRow = {
      seq: list.length + 1,
      kind: event.kind,
      actorId: event.actor.id,
      actorUsername: event.actor.username,
      targetId: event.targetId,
      clientTime: event.clientTime,
      serverTime: event.serverTime ?? new Date().toISOString(),
      payload: JSON.stringify(event.payload),
    };
    list.push(row);
    this.timeline.set(caseId, list);
    return row;
  }

  async addParticipant(
    caseId: string,
    participant: { identityId: string; username: string },
    _addedBy: string,
  ): Promise<void> {
    const existing = this.cases.get(caseId);
    if (!existing) throw new Error("case not found");
    if (!existing.participants.some((p) => p.identityId === participant.identityId)) {
      existing.participants.push({ ...participant });
    }
  }

  async listTimeline(caseId: string): Promise<TimelineRow[]> {
    return [...(this.timeline.get(caseId) ?? [])];
  }

  async listRecentTimeline(caseIds: string[], limit: number): Promise<CaseTimelineRow[]> {
    return this.listActivityPage({ caseIds, limit });
  }

  async listActivityPage(query: ActivityPageQuery & { caseIds?: string[] }): Promise<CaseTimelineRow[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (cap === 0) return [];
    const rows: CaseTimelineRow[] = [];
    const sourceIds = query.caseId
      ? [query.caseId]
      : query.caseIds
        ? query.caseIds
        : [...this.cases.keys()];
    for (const caseId of sourceIds) {
      const caseRow = this.cases.get(caseId);
      if (!caseRow) continue;
      if (query.scope && !isOverviewVisibleCase(caseRow, query.scope)) continue;
      for (const event of this.timeline.get(caseId) ?? []) {
        const row = { ...event, caseId };
        if (query.after && !activityComesAfter(row, query.after)) continue;
        rows.push(row);
      }
    }
    return rows.sort(compareActivityDesc).slice(0, cap);
  }

  async overviewVisibilityBoundary(scope: OverviewScope): Promise<OverviewVisibilityBoundary> {
    return {
      caseTitle: (caseId) => {
        const row = this.cases.get(caseId);
        return row && isOverviewVisibleCase(row, scope) ? row.title : null;
      },
    };
  }

  async overviewCounts(scope: OverviewScope): Promise<OverviewCounts> {
    const counts = emptyOverviewCounts();
    for (const row of this.cases.values()) {
      if (!isOverviewVisibleCase(row, scope)) continue;
      if ((CASE_STATUSES as readonly string[]).includes(row.status)) {
        counts.status[row.status] += 1;
      }
      if ((CASE_SEVERITIES as readonly string[]).includes(row.severity)) {
        counts.severity[row.severity] += 1;
      }
    }
    return counts;
  }

  async listOverviewOpenCases(scope: OverviewScope, limit: number): Promise<OverviewOpenCaseRow[]> {
    const cap = Math.max(0, Math.trunc(limit) || 0);
    if (cap === 0) return [];
    return [...this.cases.values()]
      .flatMap((row): OverviewOpenCaseRow[] => {
        if (!isOverviewVisibleCase(row, scope) || !isOverviewOpenStatus(row.status)) return [];
        return [{
          id: row.id,
          title: row.title,
          status: row.status,
          severity: row.severity,
          createdAt: row.createdAt,
        }];
      })
      .sort(compareOverviewOpenCases)
      .slice(0, cap);
  }

  async listOverviewActivity(scope: OverviewScope, limit: number): Promise<OverviewActivityRow[]> {
    const cap = Math.max(0, Math.trunc(limit) || 0);
    if (cap === 0) return [];
    const rows: OverviewActivityRow[] = [];
    for (const row of this.cases.values()) {
      if (!isOverviewVisibleCase(row, scope)) continue;
      for (const event of this.timeline.get(row.id) ?? []) {
        rows.push({
          caseId: row.id,
          title: row.title,
          kind: event.kind,
          actor: event.actorUsername,
          serverTime: event.serverTime,
          seq: event.seq,
        });
      }
    }
    return rows
      .sort((left, right) => {
        const byTime = right.serverTime.localeCompare(left.serverTime);
        if (byTime !== 0) return byTime;
        const byCase = left.caseId.localeCompare(right.caseId);
        return byCase !== 0 ? byCase : right.seq - left.seq;
      })
      .slice(0, cap);
  }

  async appendTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow> {
    return this.appendTimelineInMemory(caseId, event);
  }

  async listRevisions(contributionId: string): Promise<RevisionRow[]> {
    return [...(this.revisions.get(contributionId) ?? [])].map((rev) => ({
      ...rev,
      hypothesisLinks: [...rev.hypothesisLinks],
    }));
  }

  async listLatestRevisions(caseId: string): Promise<RevisionRow[]> {
    const latest: RevisionRow[] = [];
    for (const chain of this.revisions.values()) {
      const row = chain.reduce<RevisionRow | undefined>(
        (best, item) => (!best || item.revision >= best.revision ? item : best),
        undefined,
      );
      if (row && row.caseId === caseId) {
        latest.push({
          ...row,
          hypothesisLinks: [...row.hypothesisLinks],
        });
      }
    }
    return latest.sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.contributionId.localeCompare(a.contributionId);
    });
  }

  async insertRevision(rev: RevisionRow): Promise<void> {
    const chain = this.revisions.get(rev.contributionId) ?? [];
    if (chain.some((row) => row.revision === rev.revision)) {
      throw new Error("contribution revision conflict");
    }
    chain.push({
      ...rev,
      hypothesisLinks: [...rev.hypothesisLinks],
    });
    this.revisions.set(rev.contributionId, chain);
  }

  async getArtifact(artifactId: string): Promise<ArtifactRow | null> {
    const row = this.artifacts.get(artifactId);
    return row ? { ...row } : null;
  }

  async getArtifactsByIds(artifactIds: readonly string[]): Promise<ArtifactRow[]> {
    return artifactIds.flatMap((id) => {
      const row = this.artifacts.get(id);
      return row ? [{ ...row }] : [];
    });
  }

  async listArtifactsByCase(caseId: string): Promise<ArtifactRow[]> {
    return [...this.artifacts.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async listArtifactAnnotationsByCase(caseId: string): Promise<ArtifactAnnotationRow[]> {
    return [...this.artifactAnnotations.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listReferencedContentHashes(): Promise<ReadonlySet<string>> {
    const hashes = new Set<string>();
    for (const row of this.artifacts.values()) {
      addReferencedHash(hashes, row.contentHash);
      addReferencedHash(hashes, row.expectedHash);
    }
    for (const snapshot of this.snapshots.values()) {
      for (const item of snapshot.evidence) {
        addReferencedHash(hashes, item.contentHash);
        addReferencedHash(hashes, item.expectedHash);
      }
    }
    return hashes;
  }

  async insertArtifact(row: ArtifactRow): Promise<void> {
    if (row.intakeBatchId) {
      const batch = this.intakeBatches.get(row.intakeBatchId);
      if (!batch || batch.caseId !== row.caseId) {
        throw new Error("artifact intake batch does not belong to the case");
      }
    }
    this.artifacts.set(row.id, { ...row });
  }

  async insertArtifactAnnotation(row: ArtifactAnnotationRow): Promise<void> {
    const artifact = this.artifacts.get(row.artifactId);
    if (!artifact || artifact.caseId !== row.caseId) {
      throw new Error("artifact annotation target does not belong to the case");
    }
    if (this.artifactAnnotations.has(row.id)) {
      throw new Error("artifact annotation already exists");
    }
    this.artifactAnnotations.set(row.id, { ...row });
  }

  async lockArtifactAnnotationIdempotency(_caseId: string, _actorId: string, _key: string): Promise<void> {
    // Memory transactions are serialized by atomicBoundary.
  }

  async getArtifactAnnotationIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationWriteIntent | null> {
    return this.artifactAnnotationIntents.get(artifactAnnotationIntentKey(caseId, actorId, key)) ?? null;
  }

  async insertArtifactAnnotationIdempotency(row: ArtifactAnnotationWriteIntent): Promise<void> {
    const key = artifactAnnotationIntentKey(row.caseId, row.actorId, row.idempotencyKey);
    if (this.artifactAnnotationIntents.has(key)) {
      throw new Error("artifact annotation idempotency key already exists");
    }
    this.artifactAnnotationIntents.set(key, { ...row });
  }

  async lockArtifactAnnotationBulkIdempotency(
    _caseId: string,
    _actorId: string,
    _key: string,
  ): Promise<void> {
    // Memory transactions are serialized by atomicBoundary.
  }

  async getArtifactAnnotationBulkIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationBulkWriteIntent | null> {
    const row = this.artifactAnnotationBulkIntents.get(artifactAnnotationIntentKey(caseId, actorId, key));
    return row ? { ...row } : null;
  }

  async insertArtifactAnnotationBulkIdempotency(row: ArtifactAnnotationBulkWriteIntent): Promise<void> {
    const key = artifactAnnotationIntentKey(row.caseId, row.actorId, row.idempotencyKey);
    if (this.artifactAnnotationBulkIntents.has(key)) {
      throw new Error("artifact annotation bulk idempotency key already exists");
    }
    this.artifactAnnotationBulkIntents.set(key, { ...row });
  }

  async getInvestigationCoordination(caseId: string): Promise<InvestigationCoordinationRow | null> {
    const row = this.investigationCoordinations.get(caseId);
    return row ? cloneInvestigationCoordinationRow(row) : null;
  }

  async saveInvestigationCoordination(row: InvestigationCoordinationRow): Promise<void> {
    if (!this.atomicContext.getStore()) {
      throw new Error("coordination write requires an atomic boundary");
    }
    this.investigationCoordinations.set(row.caseId, cloneInvestigationCoordinationRow(row));
  }

  async getInvestigationCoordinationSuccessIntent(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<InvestigationCoordinationSuccessIntent | null> {
    const row = this.investigationCoordinationSuccessIntents.get(
      investigationCoordinationIntentKey(caseId, actorId, key),
    );
    return row ? { ...row } : null;
  }

  async insertInvestigationCoordinationSuccessIntent(
    row: InvestigationCoordinationSuccessIntent,
  ): Promise<void> {
    if (!this.atomicContext.getStore()) {
      throw new Error("coordination success intent requires an atomic boundary");
    }
    const key = investigationCoordinationIntentKey(row.caseId, row.actorId, row.idempotencyKey);
    if (this.investigationCoordinationSuccessIntents.has(key)) {
      throw new Error("investigation coordination idempotency key already exists");
    }
    this.investigationCoordinationSuccessIntents.set(key, { ...row });
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = await Promise.resolve(this.capture());
      try {
        return await operation();
      } catch (error) {
        await Promise.resolve(this.restore(snapshot));
        if (audit instanceof MemoryAuditStore) {
          await Promise.resolve(audit.rollbackTracked());
        }
        throw error;
      }
    };
    return this.atomicBoundary(() =>
      this.atomicContext.run(
        true,
        () => (audit instanceof MemoryAuditStore ? audit.runTracked(run) : run()),
      ),
    );
  }

  async lockIntakeIdempotency(_caseId: string, _key: string): Promise<void> {
    // Memory transactions are serialized by atomicBoundary.
  }

  async lockEvidenceDigest(_digest: string): Promise<void> {
    // Memory transactions are serialized by atomicBoundary.
  }

  async getIntakeBatchByIdempotency(caseId: string, key: string): Promise<IntakeBatchRow | null> {
    return (
      [...this.intakeBatches.values()].find(
        (row) => row.caseId === caseId && row.idempotencyKey === key,
      ) ?? null
    );
  }

  async getIntakeBatch(caseId: string, batchId: string): Promise<IntakeBatchRow | null> {
    const row = this.intakeBatches.get(batchId);
    return row && row.caseId === caseId ? { ...row } : null;
  }

  async insertIntakeBatch(row: IntakeBatchRow): Promise<void> {
    this.intakeBatches.set(row.id, { ...row });
  }

  async lockContributionIdempotency(_caseId: string, _actorId: string, _key: string): Promise<void> {
    // Memory transactions are serialized by atomicBoundary.
  }

  async getContributionIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ContributionWriteIntent | null> {
    return this.contributionIntents.get(contributionIntentKey(caseId, actorId, key)) ?? null;
  }

  async insertContributionIdempotency(row: ContributionWriteIntent): Promise<void> {
    const key = contributionIntentKey(row.caseId, row.actorId, row.idempotencyKey);
    if (this.contributionIntents.has(key)) {
      throw new Error("contribution idempotency key already exists");
    }
    this.contributionIntents.set(key, { ...row });
  }

  async listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]> {
    return [...this.snapshots.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => persistedSnapshot(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async probeExistingIds(kind: CaseProbeKind, ids: readonly string[]): Promise<string[]> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return [];
    const keys =
      kind === "case"
        ? this.cases.keys()
        : kind === "contribution"
          ? this.revisions.keys()
          : kind === "artifact"
            ? this.artifacts.keys()
            : kind === "snapshot"
              ? this.snapshots.keys()
              : this.intakeBatches.keys();
    const hits: string[] = [];
    for (const key of keys) {
      if (wanted.has(key)) hits.push(key);
    }
    return hits.sort();
  }

  async probeParticipants(input: {
    scope: ParticipantVisibilityScope;
    identityIds?: readonly string[];
    usernames?: readonly string[];
  }): Promise<ParticipantIdentityRow[]> {
    const identityIds = new Set(input.identityIds ?? []);
    const usernames = new Set(input.usernames ?? []);
    if (identityIds.size === 0 && usernames.size === 0) return [];
    const found = new Map<string, ParticipantIdentityRow>();
    for (const row of this.cases.values()) {
      const visible =
        input.scope.isAdmin ||
        row.participants.some((item) => item.identityId === input.scope.actorId);
      if (!visible) continue;
      for (const participant of row.participants) {
        if (
          identityIds.has(participant.identityId) ||
          usernames.has(participant.username)
        ) {
          found.set(participant.identityId, {
            identityId: participant.identityId,
            username: participant.username,
          });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.identityId.localeCompare(b.identityId));
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRow | null> {
    const row = this.snapshots.get(snapshotId);
    return row ? persistedSnapshot(row) : null;
  }

  async insertSnapshot(row: SnapshotRow): Promise<void> {
    const snapshot = persistedSnapshot(row);
    if (this.snapshots.has(snapshot.id)) throw new Error("snapshot already exists");
    if (
      [...this.snapshots.values()].some(
        (existing) =>
          existing.caseId === snapshot.caseId && existing.fingerprint === snapshot.fingerprint,
      )
    ) {
      throw new Error("snapshot fingerprint already exists");
    }
    this.snapshots.set(snapshot.id, isolateSnapshot(snapshot));
  }
}

const pgCaseTx = new AsyncLocalStorage<Queryable>();

export function activeCaseQueryable(): Queryable | undefined {
  return pgCaseTx.getStore();
}

/** Bind case-store writes (timeline, last_seq) onto an already-open client. */
export function runWithCaseQueryable<T>(
  queryable: Queryable,
  operation: () => Promise<T>,
): Promise<T> {
  return pgCaseTx.run(queryable, operation);
}

/** Destination key column backing each probe kind. */
const CASE_PROBE_TABLES: Readonly<Record<CaseProbeKind, { table: string; column: string }>> =
  Object.freeze({
    case: { table: "cases", column: "id" },
    contribution: { table: "contributions", column: "id" },
    artifact: { table: "evidence_artifacts", column: "id" },
    snapshot: { table: "snapshots", column: "id" },
    intake_batch: { table: "evidence_intake_batches", column: "id" },
  });

export class PgCaseStore implements CaseStore {
  private readonly pool: Queryable;

  constructor(db: Queryable) {
    this.pool = db;
  }

  private get db(): Queryable {
    return pgCaseTx.getStore() ?? this.pool;
  }

  async listCases(): Promise<CaseRow[]> {
    const result = await this.db.query(`${CASE_SELECT} GROUP BY c.id`);
    return result.rows.map((row) => asCase(row as Record<string, unknown>));
  }

  async listCaseCoordinationSnapshot(
    scope: OverviewScope,
  ): Promise<CaseCoordinationSnapshotRow[]> {
    const result = await this.db.query(
      `${CASE_COORDINATION_SELECT}
       WHERE ${overviewVisiblePredicate("c.id", "$1", "$2")}
       GROUP BY c.id, ic.case_id, ic.coordinator_identity_id, ic.coordinator_username,
                ic.revision, ic.updated_at, ic.updated_by_identity_id, ic.updated_by_username`,
      [scope.isAdmin, scope.actorId],
    );
    return result.rows.map((row) =>
      asCaseCoordinationSnapshotRow(row as Record<string, unknown>));
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const result = await this.db.query(`${CASE_SELECT} WHERE c.id = $1 GROUP BY c.id`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asCase(row) : null;
  }

  async lockCase(id: string): Promise<CaseRow | null> {
    const transaction = pgCaseTx.getStore();
    if (!transaction) {
      throw new Error("case lock requires an atomic boundary");
    }
    const locked = await transaction.query(
      `SELECT id FROM cases WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (locked.rowCount === 0) return null;
    // Reload after acquiring the row lock. The decision must use values from
    // this transaction, never values observed before it waited for the lock.
    return getPgCase(transaction, id);
  }

  async insertCase(row: CaseRow): Promise<void> {
    await this.db.query(
      `INSERT INTO cases (
         id, title, problem_statement, affected_parties, impact, situation_scope, open_questions,
         situation_version, investigation_context, occurred_at, occurred_at_precision, occurred_at_zone,
         severity, status, legal_hold, retention_class,
         created_at, created_by, created_by_username, last_seq
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19, 0)`,
      [
        row.id,
        row.title,
        row.problemStatement ?? "",
        row.affectedParties ?? "",
        row.impact ?? "",
        row.scope ?? "",
        JSON.stringify(row.openQuestions ?? []),
        row.situationVersion ?? 0,
        row.investigationContext === undefined || row.investigationContext === null
          ? null
          : JSON.stringify(row.investigationContext),
        row.occurredAt ?? null,
        row.occurredAtPrecision ?? "unknown",
        row.occurredAtZone ?? "unspecified",
        row.severity,
        row.status,
        row.legalHold,
        row.retentionClass,
        row.createdAt,
        row.createdBy,
        row.createdByUsername,
      ],
    );
    for (const participant of row.participants) {
      await this.addParticipant(row.id, participant, row.createdBy);
    }
  }

  async updateCaseMeta(row: { id: string; status?: CaseRow["status"]; legalHold?: boolean }): Promise<void> {
    if (row.status !== undefined && row.legalHold !== undefined) {
      const result = await this.db.query(
        `UPDATE cases SET status = $2, legal_hold = $3 WHERE id = $1`,
        [row.id, row.status, row.legalHold],
      );
      if (result.rowCount === 0) throw new Error("case not found");
      return;
    }
    if (row.status !== undefined) {
      const result = await this.db.query(
        `UPDATE cases SET status = $2 WHERE id = $1`,
        [row.id, row.status],
      );
      if (result.rowCount === 0) throw new Error("case not found");
      return;
    }
    if (row.legalHold !== undefined) {
      const result = await this.db.query(
        `UPDATE cases SET legal_hold = $2 WHERE id = $1`,
        [row.id, row.legalHold],
      );
      if (result.rowCount === 0) throw new Error("case not found");
      return;
    }
    throw new Error("case meta update requires status or legalHold");
  }

  async updateOccurredAt(
    id: string,
    occurrence: {
      occurredAt: string | null;
      occurredAtPrecision: OccurredAtPrecision;
      occurredAtZone: OccurredAtZone;
    },
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE cases
       SET occurred_at = $2, occurred_at_precision = $3, occurred_at_zone = $4
       WHERE id = $1`,
      [id, occurrence.occurredAt, occurrence.occurredAtPrecision, occurrence.occurredAtZone],
    );
    if (result.rowCount === 0) throw new Error("case not found");
  }

  async updateSituationAtomic(
    input: AtomicSituationUpdate,
    audit: AuditStore,
  ): Promise<AtomicSituationUpdateResult> {
    if (!(audit instanceof PgAuditStore) || !audit.isBoundTo(this.pool)) {
      throw new Error("PostgreSQL case and audit stores must share one connection source");
    }
    return withPgTransaction(this.pool, async (transaction) => {
      return pgCaseTx.run(transaction, async () => {
      const locked = await transaction.query<{ situation_version: number }>(
        `SELECT situation_version FROM cases WHERE id = $1 FOR UPDATE`,
        [input.id],
      );
      const versionRaw = locked.rows[0]?.situation_version;
      if (versionRaw === undefined) return { status: "not_found" };
      const currentVersion = Number(versionRaw);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
        throw new Error("invalid cases.situation_version");
      }
      if (currentVersion !== input.expectedVersion) {
        return { status: "conflict", currentVersion };
      }
      if (input.changedFields.length === 0) {
        const row = await getPgCase(transaction, input.id);
        if (!row) return { status: "not_found" };
        return { status: "unchanged", row };
      }

      const updated = await transaction.query(
        `UPDATE cases
         SET problem_statement = $2, affected_parties = $3, impact = $4, situation_scope = $5,
             open_questions = $6::jsonb, investigation_context = $7::jsonb,
             situation_version = situation_version + 1
         WHERE id = $1 AND situation_version = $8`,
        [
          input.id,
          input.situation.problemStatement,
          input.situation.affectedParties,
          input.situation.impact,
          input.situation.scope,
          JSON.stringify(input.situation.openQuestions),
          input.situation.investigationContext === null
            ? null
            : JSON.stringify(input.situation.investigationContext),
          input.expectedVersion,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error("situation version changed while row lock was held");
      }
      await appendPgTimeline(transaction, input.id, input.timeline);
      await audit.appendUsing(transaction, input.audit);
      const row = await getPgCase(transaction, input.id);
      if (!row) return { status: "not_found" };
      return { status: "updated", row };
      });
    });
  }

  async addParticipant(
    caseId: string,
    participant: { identityId: string; username: string },
    addedBy: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO case_participants (case_id, identity_id, username, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (case_id, identity_id) DO NOTHING`,
      [caseId, participant.identityId, participant.username, addedBy],
    );
  }

  async listTimeline(caseId: string): Promise<TimelineRow[]> {
    const result = await this.db.query(
      `SELECT seq, kind, actor_id, actor_username, target_id, client_time, server_time, payload
       FROM timeline_events WHERE case_id = $1 ORDER BY seq ASC`,
      [caseId],
    );
    return result.rows.map((row) => asTimeline(row as Record<string, unknown>));
  }

  async listRecentTimeline(caseIds: string[], limit: number): Promise<CaseTimelineRow[]> {
    return this.listActivityPage({ caseIds, limit });
  }

  async listActivityPage(query: ActivityPageQuery & { caseIds?: string[] }): Promise<CaseTimelineRow[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (cap === 0) return [];
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.caseId) {
      params.push(query.caseId);
      where.push(`e.case_id = $${params.length}::uuid`);
    } else if (query.caseIds) {
      if (query.caseIds.length === 0) return [];
      params.push(query.caseIds);
      where.push(`e.case_id = ANY($${params.length}::uuid[])`);
    } else if (query.scope) {
      params.push(query.scope.isAdmin, query.scope.actorId);
      where.push(overviewVisiblePredicate("e.case_id", `$${params.length - 1}`, `$${params.length}`));
    } else {
      throw new Error("activity page requires a case, case list, or overview scope");
    }
    if (query.after) {
      params.push(query.after.serverTime, query.after.caseId, query.after.seq);
      const t = `$${params.length - 2}`;
      const c = `$${params.length - 1}`;
      const s = `$${params.length}`;
      where.push(`(
        e.server_time < ${t}::timestamptz
        OR (e.server_time = ${t}::timestamptz AND e.case_id > ${c}::uuid)
        OR (e.server_time = ${t}::timestamptz AND e.case_id = ${c}::uuid AND e.seq < ${s}::int)
      )`);
    }
    params.push(cap);
    const result = await this.db.query(
      `SELECT e.case_id, e.seq, e.kind, e.actor_id, e.actor_username, e.target_id,
              e.client_time, e.server_time, e.payload
       FROM timeline_events e
       WHERE ${where.join(" AND ")}
       ORDER BY e.server_time DESC, e.case_id ASC, e.seq DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({
      ...asTimeline(row as Record<string, unknown>),
      caseId: String((row as Record<string, unknown>).case_id),
    }));
  }

  async overviewVisibilityBoundary(_scope: OverviewScope): Promise<null> {
    // PostgreSQL Overview queries enforce visibility in their own joins.
    return null;
  }

  async overviewCounts(scope: OverviewScope): Promise<OverviewCounts> {
    const counts = emptyOverviewCounts();
    const result = await this.db.query(
      `SELECT c.status, c.severity, COUNT(*)::int AS n
       FROM cases c
       WHERE ${overviewVisiblePredicate("c.id", "$1", "$2")}
       GROUP BY c.status, c.severity`,
      [scope.isAdmin, scope.actorId],
    );
    for (const row of result.rows as { status: string; severity: string; n: number }[]) {
      if ((CASE_STATUSES as readonly string[]).includes(row.status)) {
        counts.status[row.status as CaseStatus] += Number(row.n);
      }
      if ((CASE_SEVERITIES as readonly string[]).includes(row.severity)) {
        counts.severity[row.severity as CaseSeverity] += Number(row.n);
      }
    }
    return counts;
  }

  async listOverviewOpenCases(scope: OverviewScope, limit: number): Promise<OverviewOpenCaseRow[]> {
    const cap = Math.max(0, Math.trunc(limit) || 0);
    if (cap === 0) return [];
    const result = await this.db.query(
      `SELECT c.id, c.title, c.status, c.severity, c.created_at
       FROM cases c
       WHERE c.status = ANY($3::text[])
         AND ${overviewVisiblePredicate("c.id", "$1", "$2")}
       ORDER BY c.created_at DESC, c.id ASC
       LIMIT $4`,
      [scope.isAdmin, scope.actorId, [...OVERVIEW_OPEN_STATUSES], cap],
    );
    return (result.rows as Record<string, unknown>[]).flatMap((row): OverviewOpenCaseRow[] => {
      const status = String(row.status);
      if (!isOverviewOpenStatus(status)) return [];
      return [{
        id: String(row.id),
        title: String(row.title),
        status,
        severity: row.severity as CaseSeverity,
        createdAt: asIso(row.created_at),
      }];
    });
  }

  async listOverviewActivity(scope: OverviewScope, limit: number): Promise<OverviewActivityRow[]> {
    const cap = Math.max(0, Math.trunc(limit) || 0);
    if (cap === 0) return [];
    const result = await this.db.query(
      `SELECT e.case_id, c.title, e.kind, e.actor_username, e.server_time, e.seq
       FROM timeline_events e
       INNER JOIN cases c ON c.id = e.case_id
       WHERE ${overviewVisiblePredicate("c.id", "$1", "$2")}
       ORDER BY e.server_time DESC, e.case_id ASC, e.seq DESC
       LIMIT $3`,
      [scope.isAdmin, scope.actorId, cap],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      caseId: String(row.case_id),
      title: String(row.title),
      kind: String(row.kind),
      actor: String(row.actor_username),
      serverTime: asIso(row.server_time),
      seq: Number(row.seq),
    }));
  }

  async appendTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow> {
    return appendPgTimeline(this.db, caseId, event);
  }

  async listRevisions(contributionId: string): Promise<RevisionRow[]> {
    const result = await this.db.query(
      `SELECT r.*, c.case_id, c.kind, c.privacy_class, c.source_id
       FROM contribution_revisions r
       JOIN contributions c ON c.id = r.contribution_id
       WHERE r.contribution_id = $1
       ORDER BY r.revision ASC`,
      [contributionId],
    );
    return result.rows.map((row) => asRevision(row as Record<string, unknown>));
  }

  async listLatestRevisions(caseId: string): Promise<RevisionRow[]> {
    const result = await this.db.query(
      `SELECT r.*, c.case_id, c.kind, c.privacy_class, c.source_id
       FROM contribution_revisions r
       JOIN contributions c ON c.id = r.contribution_id
       JOIN (
         SELECT contribution_id, MAX(revision) AS revision
         FROM contribution_revisions
         GROUP BY contribution_id
       ) latest
         ON latest.contribution_id = r.contribution_id
        AND latest.revision = r.revision
       WHERE c.case_id = $1
       ORDER BY r.created_at DESC, r.contribution_id DESC`,
      [caseId],
    );
    return result.rows.map((row) => asRevision(row as Record<string, unknown>));
  }

  async insertRevision(rev: RevisionRow): Promise<void> {
    if (rev.revision === 1) {
      await this.db.query(
        `INSERT INTO contributions (
           id, case_id, kind, privacy_class, created_at, created_by, created_by_username, source_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          rev.contributionId,
          rev.caseId,
          rev.kind,
          rev.privacyClass,
          rev.createdAt,
          rev.authorId,
          rev.authorUsername,
          rev.sourceId,
        ],
      );
    }
    await this.db.query(
      `INSERT INTO contribution_revisions (
         contribution_id, revision, predecessor_revision, author_id, author_username,
         body, content_hash, tombstone, hypothesis_status, hypothesis_links, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        rev.contributionId,
        rev.revision,
        rev.predecessorRevision,
        rev.authorId,
        rev.authorUsername,
        rev.body,
        rev.contentHash,
        rev.tombstone,
        rev.hypothesisStatus,
        JSON.stringify(rev.hypothesisLinks),
        rev.createdAt,
      ],
    );
  }

  async getArtifact(artifactId: string): Promise<ArtifactRow | null> {
    const result = await this.db.query(
      `SELECT * FROM evidence_artifacts WHERE id = $1`,
      [artifactId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asArtifact(row) : null;
  }

  async getArtifactsByIds(artifactIds: readonly string[]): Promise<ArtifactRow[]> {
    if (artifactIds.length === 0) return [];
    const result = await this.db.query(
      `SELECT * FROM evidence_artifacts WHERE id::text = ANY($1::text[])`,
      [artifactIds],
    );
    return result.rows.map((row) => asArtifact(row as Record<string, unknown>));
  }

  async listArtifactsByCase(caseId: string): Promise<ArtifactRow[]> {
    const result = await this.db.query(
      `SELECT * FROM evidence_artifacts WHERE case_id = $1 ORDER BY id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asArtifact(row as Record<string, unknown>));
  }

  async listArtifactAnnotationsByCase(caseId: string): Promise<ArtifactAnnotationRow[]> {
    const result = await this.db.query(
      `SELECT id, case_id, artifact_id, body, content_hash, privacy_class,
              author_id, author_username, created_at, source_id
       FROM artifact_annotations
       WHERE case_id = $1
       ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asArtifactAnnotation(row as Record<string, unknown>));
  }

  async listReferencedContentHashes(): Promise<ReadonlySet<string>> {
    const result = await this.db.query<{ hash: string | null }>(
      `SELECT hash FROM (
         SELECT content_hash AS hash FROM evidence_artifacts
         UNION
         SELECT expected_hash FROM evidence_artifacts
         UNION
         SELECT item->>'contentHash'
         FROM snapshots, LATERAL jsonb_array_elements(evidence) AS item
         UNION
         SELECT item->>'expectedHash'
         FROM snapshots, LATERAL jsonb_array_elements(evidence) AS item
       ) hashes
       WHERE hash ~ '^[0-9a-f]{64}$'`,
    );
    const hashes = new Set<string>();
    for (const row of result.rows) addReferencedHash(hashes, row.hash);
    return hashes;
  }

  async insertArtifact(row: ArtifactRow): Promise<void> {
    await this.db.query(
      `INSERT INTO evidence_artifacts (
         id, case_id, kind, filename, uri, media_type, byte_length, content_hash,
         expected_hash, verification_status, ref_id, privacy_class,
         summary_contribution_id, uploader_id, uploader_username, source_id,
         relative_path, intake_batch_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        row.id,
        row.caseId,
        row.kind,
        row.filename,
        row.uri,
        row.mediaType,
        row.byteLength,
        row.contentHash,
        row.expectedHash,
        row.verificationStatus,
        row.refId,
        row.privacyClass,
        row.summaryContributionId,
        row.uploaderId,
        row.uploaderUsername,
        row.sourceId,
        row.relativePath ?? row.filename,
        row.intakeBatchId ?? null,
      ],
    );
  }

  async insertArtifactAnnotation(row: ArtifactAnnotationRow): Promise<void> {
    await this.db.query(
      `INSERT INTO artifact_annotations (
         id, case_id, artifact_id, body, content_hash, privacy_class,
         author_id, author_username, created_at, source_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.caseId,
        row.artifactId,
        row.body,
        row.contentHash,
        row.privacyClass,
        row.authorId,
        row.authorUsername,
        row.createdAt,
        row.sourceId,
      ],
    );
  }

  async lockArtifactAnnotationIdempotency(caseId: string, actorId: string, key: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`artifact-annotation:${caseId}:${actorId}:${key}`],
    );
  }

  async getArtifactAnnotationIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationWriteIntent | null> {
    const result = await this.db.query(
      `SELECT case_id, actor_id, idempotency_key, request_digest, annotation_id, created_at
       FROM artifact_annotation_write_intents
       WHERE case_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [caseId, actorId, key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asArtifactAnnotationWriteIntent(row) : null;
  }

  async insertArtifactAnnotationIdempotency(row: ArtifactAnnotationWriteIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO artifact_annotation_write_intents (
         case_id, actor_id, idempotency_key, request_digest, annotation_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.caseId,
        row.actorId,
        row.idempotencyKey,
        row.requestDigest,
        row.annotationId,
        row.createdAt,
      ],
    );
  }

  async lockArtifactAnnotationBulkIdempotency(caseId: string, actorId: string, key: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`artifact-annotation-bulk:${caseId}:${actorId}:${key}`],
    );
  }

  async getArtifactAnnotationBulkIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ArtifactAnnotationBulkWriteIntent | null> {
    const result = await this.db.query(
      `SELECT case_id, actor_id, idempotency_key, request_digest, result_json, created_at
       FROM artifact_annotation_bulk_write_intents
       WHERE case_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [caseId, actorId, key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asArtifactAnnotationBulkWriteIntent(row) : null;
  }

  async insertArtifactAnnotationBulkIdempotency(row: ArtifactAnnotationBulkWriteIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO artifact_annotation_bulk_write_intents (
         case_id, actor_id, idempotency_key, request_digest, result_json, created_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [row.caseId, row.actorId, row.idempotencyKey, row.requestDigest, row.resultJson, row.createdAt],
    );
  }

  async getInvestigationCoordination(caseId: string): Promise<InvestigationCoordinationRow | null> {
    const result = await this.db.query(
      `SELECT case_id, coordinator_identity_id, coordinator_username, revision,
              updated_at, updated_by_identity_id, updated_by_username
       FROM investigation_coordination WHERE case_id = $1`,
      [caseId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asInvestigationCoordinationRow(row) : null;
  }

  async saveInvestigationCoordination(row: InvestigationCoordinationRow): Promise<void> {
    if (!pgCaseTx.getStore()) {
      throw new Error("coordination write requires an atomic boundary");
    }
    await this.db.query(
      `INSERT INTO investigation_coordination (
         case_id, coordinator_identity_id, coordinator_username, revision,
         updated_at, updated_by_identity_id, updated_by_username
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (case_id) DO UPDATE SET
         coordinator_identity_id = EXCLUDED.coordinator_identity_id,
         coordinator_username = EXCLUDED.coordinator_username,
         revision = EXCLUDED.revision,
         updated_at = EXCLUDED.updated_at,
         updated_by_identity_id = EXCLUDED.updated_by_identity_id,
         updated_by_username = EXCLUDED.updated_by_username`,
      [
        row.caseId,
        row.coordinator?.identityId ?? null,
        row.coordinator?.username ?? null,
        row.revision,
        row.updatedAt,
        row.updatedBy.identityId,
        row.updatedBy.username,
      ],
    );
  }

  async getInvestigationCoordinationSuccessIntent(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<InvestigationCoordinationSuccessIntent | null> {
    const result = await this.db.query(
      `SELECT case_id, actor_id, idempotency_key, action, target_identity_id,
              success_json, created_at
       FROM investigation_coordination_success_intents
       WHERE case_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [caseId, actorId, key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asInvestigationCoordinationSuccessIntent(row) : null;
  }

  async insertInvestigationCoordinationSuccessIntent(
    row: InvestigationCoordinationSuccessIntent,
  ): Promise<void> {
    if (!pgCaseTx.getStore()) {
      throw new Error("coordination success intent requires an atomic boundary");
    }
    await this.db.query(
      `INSERT INTO investigation_coordination_success_intents (
         case_id, actor_id, idempotency_key, action, target_identity_id,
         success_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.caseId,
        row.actorId,
        row.idempotencyKey,
        row.action,
        row.targetIdentityId,
        row.successJson,
        row.createdAt,
      ],
    );
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    if (audit && (!(audit instanceof PgAuditStore) || !audit.isBoundTo(this.pool))) {
      throw new Error("PostgreSQL case and audit stores must share one connection source");
    }
    return withPgTransaction(this.pool, (transaction) =>
      pgCaseTx.run(transaction, () =>
        audit instanceof PgAuditStore
          ? audit.withTransaction(transaction, operation)
          : operation(),
      ),
    );
  }

  async lockIntakeIdempotency(caseId: string, key: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${caseId}:${key}`],
    );
  }

  async lockEvidenceDigest(digest: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`evidence:${digest}`],
    );
  }

  async getIntakeBatchByIdempotency(caseId: string, key: string): Promise<IntakeBatchRow | null> {
    const result = await this.db.query(
      `SELECT * FROM evidence_intake_batches WHERE case_id = $1 AND idempotency_key = $2`,
      [caseId, key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asIntakeBatch(row) : null;
  }

  async getIntakeBatch(caseId: string, batchId: string): Promise<IntakeBatchRow | null> {
    const result = await this.db.query(
      `SELECT * FROM evidence_intake_batches WHERE case_id = $1 AND id = $2`,
      [caseId, batchId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asIntakeBatch(row) : null;
  }

  async insertIntakeBatch(row: IntakeBatchRow): Promise<void> {
    await this.db.query(
      `INSERT INTO evidence_intake_batches (
         id, case_id, idempotency_key, request_digest, origin, source_label, privacy_class,
         created_at, created_by, payload_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.caseId,
        row.idempotencyKey,
        row.requestDigest,
        row.origin,
        row.sourceLabel,
        row.privacyClass,
        row.createdAt,
        row.createdBy,
        row.payloadJson,
      ],
    );
  }

  async lockContributionIdempotency(caseId: string, actorId: string, key: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`contrib:${caseId}:${actorId}:${key}`],
    );
  }

  async getContributionIdempotency(
    caseId: string,
    actorId: string,
    key: string,
  ): Promise<ContributionWriteIntent | null> {
    const result = await this.db.query(
      `SELECT case_id, actor_id, idempotency_key, request_digest, contribution_id, created_at
       FROM contribution_write_intents
       WHERE case_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [caseId, actorId, key],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asContributionWriteIntent(row) : null;
  }

  async insertContributionIdempotency(row: ContributionWriteIntent): Promise<void> {
    await this.db.query(
      `INSERT INTO contribution_write_intents (
         case_id, actor_id, idempotency_key, request_digest, contribution_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.caseId,
        row.actorId,
        row.idempotencyKey,
        row.requestDigest,
        row.contributionId,
        row.createdAt,
      ],
    );
  }

  async listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]> {
    const result = await this.db.query(
      `SELECT id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
              protocol_version, fairness_class, status, created_at, created_by,
              normalization_revision
       FROM snapshots WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asSnapshot(row as Record<string, unknown>));
  }

  async probeExistingIds(kind: CaseProbeKind, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const probe = CASE_PROBE_TABLES[kind];
    const result = await this.db.query(
      `SELECT ${probe.column} AS id FROM ${probe.table} WHERE ${probe.column} = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return result.rows
      .map((row) => String((row as Record<string, unknown>).id))
      .sort();
  }

  async probeParticipants(input: {
    scope: ParticipantVisibilityScope;
    identityIds?: readonly string[];
    usernames?: readonly string[];
  }): Promise<ParticipantIdentityRow[]> {
    const identityIds = [...new Set(input.identityIds ?? [])];
    const usernames = [...new Set(input.usernames ?? [])];
    if (identityIds.length === 0 && usernames.length === 0) return [];
    const result = await this.db.query(
      `SELECT DISTINCT p.identity_id, p.username
         FROM case_participants p
        WHERE (p.identity_id = ANY($1::text[]) OR p.username = ANY($2::text[]))
          AND ($3::boolean OR EXISTS (
                SELECT 1 FROM case_participants viewer
                 WHERE viewer.case_id = p.case_id AND viewer.identity_id = $4))
        ORDER BY p.identity_id ASC`,
      [identityIds, usernames, input.scope.isAdmin, input.scope.actorId],
    );
    return result.rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        identityId: String(value.identity_id),
        username: String(value.username),
      };
    });
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
              protocol_version, fairness_class, status, created_at, created_by,
              normalization_revision
       FROM snapshots WHERE id = $1`,
      [snapshotId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asSnapshot(row) : null;
  }

  async insertSnapshot(row: SnapshotRow): Promise<void> {
    const snapshot = persistedSnapshot(row);
    await this.db.query(
      `INSERT INTO snapshots (
         id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
         protocol_version, fairness_class, status, created_at, created_by,
         normalization_revision
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [
        snapshot.id,
        snapshot.caseId,
        snapshot.fingerprint,
        snapshot.parentSnapshotId,
        JSON.stringify(snapshot.evidence),
        snapshot.visibility,
        snapshot.protocolVersion,
        snapshot.fairnessClass,
        snapshot.status,
        snapshot.createdAt,
        snapshot.createdBy,
        snapshot.normalizationRevision ?? null,
      ],
    );
  }
}

const CASE_SELECT = `
  SELECT c.id, c.title, c.problem_statement, c.affected_parties, c.impact, c.situation_scope,
         c.open_questions, c.situation_version, c.investigation_context,
         c.occurred_at, c.occurred_at_precision, c.occurred_at_zone,
         c.severity, c.status, c.legal_hold,
         c.retention_class,
         c.created_at, c.created_by, c.created_by_username,
         COALESCE(
           json_agg(
             json_build_object('identityId', p.identity_id, 'username', p.username)
           ) FILTER (WHERE p.identity_id IS NOT NULL),
           '[]'
         ) AS participants
  FROM cases c
  LEFT JOIN case_participants p ON p.case_id = c.id
`;

const CASE_COORDINATION_SELECT = `
  SELECT c.id, c.title, c.problem_statement, c.affected_parties, c.impact, c.situation_scope,
         c.open_questions, c.situation_version, c.investigation_context,
         c.occurred_at, c.occurred_at_precision, c.occurred_at_zone,
         c.severity, c.status, c.legal_hold,
         c.retention_class,
         c.created_at, c.created_by, c.created_by_username,
         COALESCE(
           json_agg(
             json_build_object('identityId', p.identity_id, 'username', p.username)
           ) FILTER (WHERE p.identity_id IS NOT NULL),
           '[]'
         ) AS participants,
         ic.case_id AS coordination_case_id,
         ic.coordinator_identity_id, ic.coordinator_username, ic.revision,
         ic.updated_at, ic.updated_by_identity_id, ic.updated_by_username
  FROM cases c
  LEFT JOIN case_participants p ON p.case_id = c.id
  LEFT JOIN investigation_coordination ic ON ic.case_id = c.id
`;

function cloneCase(row: CaseRow): CaseRow {
  return {
    ...row,
    problemStatement: row.problemStatement ?? "",
    affectedParties: row.affectedParties ?? "",
    impact: row.impact ?? "",
    scope: row.scope ?? "",
    openQuestions: caseOpenQuestions(row.openQuestions, "case.openQuestions"),
    situationVersion: caseSituationVersion(row.situationVersion),
    investigationContext: normalizeInvestigationContext(
      row.investigationContext,
      "case.investigationContext",
    ),
    occurredAt: row.occurredAt ?? null,
    occurredAtPrecision: row.occurredAtPrecision ?? "unknown",
    occurredAtZone: row.occurredAtZone ?? "unspecified",
    participants: row.participants.map((p) => ({ ...p })),
  };
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function contributionIntentKey(caseId: string, actorId: string, key: string): string {
  return `${caseId}\0${actorId}\0${key}`;
}

function artifactAnnotationIntentKey(caseId: string, actorId: string, key: string): string {
  return `${caseId}\0${actorId}\0${key}`;
}

function investigationCoordinationIntentKey(caseId: string, actorId: string, key: string): string {
  return `${caseId}\0${actorId}\0${key}`;
}

function cloneInvestigationCoordinationRow(
  row: InvestigationCoordinationRow,
): InvestigationCoordinationRow {
  return {
    ...row,
    coordinator: row.coordinator ? { ...row.coordinator } : null,
    updatedBy: { ...row.updatedBy },
  };
}

function asInvestigationCoordinationRow(row: Record<string, unknown>): InvestigationCoordinationRow {
  const coordinatorId = row.coordinator_identity_id;
  const coordinatorUsername = row.coordinator_username;
  return {
    caseId: String(row.case_id),
    coordinator: coordinatorId === null || coordinatorId === undefined
      ? null
      : { identityId: String(coordinatorId), username: String(coordinatorUsername) },
    revision: Number(row.revision),
    updatedAt: asIso(row.updated_at),
    updatedBy: {
      identityId: String(row.updated_by_identity_id),
      username: String(row.updated_by_username),
    },
  };
}

function asCaseCoordinationSnapshotRow(
  row: Record<string, unknown>,
): CaseCoordinationSnapshotRow {
  const coordinationCaseId = row.coordination_case_id;
  return {
    caseRow: asCase(row),
    coordination: coordinationCaseId === null || coordinationCaseId === undefined
      ? null
      : asInvestigationCoordinationRow({ ...row, case_id: coordinationCaseId }),
  };
}

function asInvestigationCoordinationSuccessIntent(
  row: Record<string, unknown>,
): InvestigationCoordinationSuccessIntent {
  return {
    caseId: String(row.case_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    action: row.action as InvestigationCoordinationSuccessIntent["action"],
    targetIdentityId: row.target_identity_id === null || row.target_identity_id === undefined
      ? null
      : String(row.target_identity_id),
    successJson: String(row.success_json),
    createdAt: asIso(row.created_at),
  };
}

function asContributionWriteIntent(row: Record<string, unknown>): ContributionWriteIntent {
  return {
    caseId: String(row.case_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    contributionId: String(row.contribution_id),
    createdAt: asIso(row.created_at),
  };
}

function asArtifactAnnotationWriteIntent(row: Record<string, unknown>): ArtifactAnnotationWriteIntent {
  return {
    caseId: String(row.case_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    annotationId: String(row.annotation_id),
    createdAt: asIso(row.created_at),
  };
}

function asArtifactAnnotationBulkWriteIntent(row: Record<string, unknown>): ArtifactAnnotationBulkWriteIntent {
  return {
    caseId: String(row.case_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    resultJson: typeof row.result_json === "string" ? row.result_json : JSON.stringify(row.result_json),
    createdAt: asIso(row.created_at),
  };
}

function asCase(row: Record<string, unknown>): CaseRow {
  const participantsRaw = row.participants;
  const participants = Array.isArray(participantsRaw)
    ? participantsRaw.map((p) => {
        const rec = p as Record<string, unknown>;
        return { identityId: String(rec.identityId), username: String(rec.username) };
      })
    : [];
  return {
    id: String(row.id),
    title: String(row.title),
    problemStatement: row.problem_statement === null || row.problem_statement === undefined
      ? ""
      : String(row.problem_statement),
    affectedParties: row.affected_parties === null || row.affected_parties === undefined
      ? ""
      : String(row.affected_parties),
    impact: row.impact === null || row.impact === undefined ? "" : String(row.impact),
    scope: row.situation_scope === null || row.situation_scope === undefined
      ? ""
      : String(row.situation_scope),
    openQuestions: caseOpenQuestions(row.open_questions, "cases.open_questions"),
    situationVersion: caseSituationVersion(row.situation_version),
    investigationContext: normalizeInvestigationContext(
      row.investigation_context,
      "cases.investigation_context",
    ),
    occurredAt:
      row.occurred_at === null || row.occurred_at === undefined ? null : String(row.occurred_at),
    occurredAtPrecision: (row.occurred_at_precision as OccurredAtPrecision | undefined) ?? "unknown",
    occurredAtZone: (row.occurred_at_zone as OccurredAtZone | undefined) ?? "unspecified",
    severity: row.severity as CaseSeverity,
    status: row.status as CaseStatus,
    legalHold: Boolean(row.legal_hold),
    retentionClass: String(row.retention_class),
    createdAt: asIso(row.created_at),
    createdBy: String(row.created_by),
    createdByUsername: String(row.created_by_username),
    participants,
  };
}

function caseOpenQuestions(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((question) => typeof question === "string")) {
    throw new Error(`invalid ${field}: expected an array of strings`);
  }
  return [...value];
}

function caseSituationVersion(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("invalid cases.situation_version");
  }
  return parsed;
}

async function getPgCase(db: Queryable, id: string): Promise<CaseRow | null> {
  const result = await db.query(`${CASE_SELECT} WHERE c.id = $1 GROUP BY c.id`, [id]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? asCase(row) : null;
}

async function appendPgTimeline(
  db: Queryable,
  caseId: string,
  event: TimelineInsert,
): Promise<TimelineRow> {
  const seqRes = await db.query<{ last_seq: string | number }>(
    `UPDATE cases SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
    [caseId],
  );
  const seqRaw = seqRes.rows[0]?.last_seq;
  if (seqRaw === undefined) throw new Error("case not found");
  const seq = Number(seqRaw);
  const serverTime = event.serverTime ?? new Date().toISOString();
  const payload = JSON.stringify(event.payload);
  await db.query(
    `INSERT INTO timeline_events (
       case_id, seq, kind, actor_id, actor_username, target_id, client_time, server_time, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      caseId,
      seq,
      event.kind,
      event.actor.id,
      event.actor.username,
      event.targetId,
      event.clientTime,
      serverTime,
      payload,
    ],
  );
  return {
    seq,
    kind: event.kind,
    actorId: event.actor.id,
    actorUsername: event.actor.username,
    targetId: event.targetId,
    clientTime: event.clientTime,
    serverTime,
    payload,
  };
}

async function withPgTransaction<T>(
  db: Queryable,
  operation: (transaction: Queryable) => Promise<T>,
): Promise<T> {
  let transaction: Queryable = db;
  let pooled: PoolClient | null = null;
  if (db instanceof Pool) {
    pooled = await db.connect();
    transaction = pooled;
  }
  await transaction.query("BEGIN");
  let commitAttempted = false;
  try {
    const result = await operation(transaction);
    commitAttempted = true;
    await transaction.query("COMMIT");
    return result;
  } catch (error) {
    if (commitAttempted) {
      if (pooled) {
        const client = pooled;
        pooled = null;
        try {
          client.release(new Error("case-store transaction commit outcome is unknown"));
        } catch {
          // The connection is already unsafe; keep the unknown COMMIT outcome.
        }
      }
      throw new CaseStoreCommitOutcomeUnknownError();
    }
    try {
      await transaction.query("ROLLBACK");
    } catch {
      // Preserve the mutation failure; the connection is released below.
    }
    throw error;
  } finally {
    pooled?.release();
  }
}

/** @internal Test-only access to the PostgreSQL case-store transaction wrapper. */
export const withPgTransactionForTests = withPgTransaction;

function asTimeline(row: Record<string, unknown>): TimelineRow {
  const payload = row.payload;
  return {
    seq: Number(row.seq),
    kind: String(row.kind),
    actorId: String(row.actor_id),
    actorUsername: String(row.actor_username),
    targetId: row.target_id === null || row.target_id === undefined ? null : String(row.target_id),
    clientTime:
      row.client_time === null || row.client_time === undefined ? null : asIso(row.client_time),
    serverTime: asIso(row.server_time),
    payload: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
  };
}

function asRevision(row: Record<string, unknown>): RevisionRow {
  const linksRaw = row.hypothesis_links;
  const links = Array.isArray(linksRaw)
    ? linksRaw.map((item) => {
        const rec = item as Record<string, unknown>;
        return {
          kind: rec.kind as "artifact" | "contribution",
          id: String(rec.id),
        };
      })
    : [];
  return {
    contributionId: String(row.contribution_id),
    caseId: String(row.case_id),
    kind: row.kind as ContributionKind,
    revision: Number(row.revision),
    predecessorRevision:
      row.predecessor_revision === null || row.predecessor_revision === undefined
        ? null
        : Number(row.predecessor_revision),
    body: row.body === null || row.body === undefined ? "" : String(row.body),
    contentHash: String(row.content_hash),
    privacyClass: row.privacy_class as PrivacyClass,
    tombstone: Boolean(row.tombstone),
    authorId: String(row.author_id),
    authorUsername: String(row.author_username),
    createdAt: asIso(row.created_at),
    hypothesisStatus:
      row.hypothesis_status === null || row.hypothesis_status === undefined
        ? null
        : (row.hypothesis_status as HypothesisStatus),
    hypothesisLinks: links,
    sourceId: row.source_id === null || row.source_id === undefined ? "" : String(row.source_id),
  };
}

function asArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    kind: row.kind as ArtifactKind,
    filename: row.filename === null || row.filename === undefined ? null : String(row.filename),
    uri: row.uri === null || row.uri === undefined ? null : String(row.uri),
    mediaType:
      row.media_type === null || row.media_type === undefined ? null : String(row.media_type),
    byteLength:
      row.byte_length === null || row.byte_length === undefined ? null : Number(row.byte_length),
    contentHash:
      row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    expectedHash:
      row.expected_hash === null || row.expected_hash === undefined
        ? null
        : String(row.expected_hash),
    verificationStatus:
      row.verification_status === null || row.verification_status === undefined
        ? null
        : String(row.verification_status),
    refId: row.ref_id === null || row.ref_id === undefined ? null : String(row.ref_id),
    privacyClass: row.privacy_class as PrivacyClass,
    summaryContributionId:
      row.summary_contribution_id === null || row.summary_contribution_id === undefined
        ? null
        : String(row.summary_contribution_id),
    uploaderId: String(row.uploader_id),
    uploaderUsername: String(row.uploader_username),
    sourceId: row.source_id === null || row.source_id === undefined ? "" : String(row.source_id),
    relativePath:
      row.relative_path === null || row.relative_path === undefined
        ? row.filename === null || row.filename === undefined
          ? null
          : String(row.filename)
        : String(row.relative_path),
    intakeBatchId:
      row.intake_batch_id === null || row.intake_batch_id === undefined
        ? null
        : String(row.intake_batch_id),
  };
}

function asArtifactAnnotation(row: Record<string, unknown>): ArtifactAnnotationRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    artifactId: String(row.artifact_id),
    body: String(row.body),
    contentHash: String(row.content_hash),
    privacyClass: row.privacy_class as PrivacyClass,
    authorId: String(row.author_id),
    authorUsername: String(row.author_username),
    createdAt: asIso(row.created_at),
    sourceId: String(row.source_id),
  };
}

function asIntakeBatch(row: Record<string, unknown>): IntakeBatchRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    origin: String(row.origin),
    sourceLabel: String(row.source_label),
    privacyClass: row.privacy_class as PrivacyClass,
    createdAt: asIso(row.created_at),
    createdBy: String(row.created_by),
    payloadJson: String(row.payload_json),
  };
}

function isolateSnapshot(row: SnapshotV1): SnapshotRow {
  return {
    schemaId: row.schemaId,
    id: row.id,
    caseId: row.caseId,
    fingerprint: row.fingerprint,
    parentSnapshotId: row.parentSnapshotId,
    evidence: row.evidence.map((item) => ({ ...item })),
    visibility: row.visibility,
    protocolVersion: row.protocolVersion,
    fairnessClass: row.fairnessClass,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    ...(typeof row.normalizationRevision === "number"
      ? { normalizationRevision: row.normalizationRevision }
      : row.normalizationRevision === null
        ? { normalizationRevision: null }
        : {}),
  };
}

function persistedSnapshot(input: unknown): SnapshotRow {
  return isolateSnapshot(parseSnapshot(input));
}

function timestampColumn(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function asSnapshot(row: Record<string, unknown>): SnapshotRow {
  return persistedSnapshot({
    schemaId: SNAPSHOT_SCHEMA_ID,
    id: row.id,
    caseId: row.case_id,
    fingerprint: row.fingerprint,
    parentSnapshotId: row.parent_snapshot_id,
    evidence: row.evidence,
    visibility: row.visibility,
    protocolVersion: row.protocol_version,
    fairnessClass: row.fairness_class,
    status: row.status,
    createdAt: timestampColumn(row.created_at),
    createdBy: row.created_by,
    // A NULL column means the freeze observed no corpus revision. That is the
    // same "unknown basis" the memory store represents by omitting the key, so
    // both backends must round-trip a snapshot to the same document rather
    // than one of them inventing an explicit null.
    ...(row.normalization_revision === null || row.normalization_revision === undefined
      ? {}
      : { normalizationRevision: Number(row.normalization_revision) }),
  });
}
