import type { Pool } from "pg";
import {
  parseSnapshot,
  SNAPSHOT_SCHEMA_ID,
  CASE_SEVERITIES,
  CASE_STATUSES,
  OVERVIEW_OPEN_STATUSES,
  type ArtifactKind,
  type CaseSeverity,
  type CaseStatus,
  type ContributionKind,
  type HypothesisStatus,
  type OverviewOpenStatus,
  type OverviewSeverityCountsV1,
  type OverviewStatusCountsV1,
  type PrivacyClass,
  type SnapshotV1,
} from "@cd-collab/contracts";
export interface Actor {
  id: string;
  username: string;
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
}

export type SnapshotRow = SnapshotV1;

export interface TimelineInsert {
  kind: string;
  actor: Actor;
  targetId: string | null;
  clientTime: string | null;
  payload: unknown;
}

export interface OverviewScope {
  actorId: string;
  isAdmin: boolean;
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

export interface CaseStore {
  listCases(): Promise<CaseRow[]>;
  getCase(id: string): Promise<CaseRow | null>;
  insertCase(row: CaseRow): Promise<void>;
  updateCaseMeta(row: Pick<CaseRow, "id" | "status" | "legalHold">): Promise<void>;
  updateCaseSituation(
    row: {
      id: string;
      problemStatement: string;
      affectedParties: string;
      impact: string;
      scope: string;
      openQuestions: string[];
    },
  ): Promise<void>;
  addParticipant(
    caseId: string,
    participant: { identityId: string; username: string },
    addedBy: string,
  ): Promise<void>;
  listTimeline(caseId: string): Promise<TimelineRow[]>;
  listRecentTimeline(caseIds: string[], limit: number): Promise<CaseTimelineRow[]>;
  overviewVisibilityBoundary(scope: OverviewScope): Promise<OverviewVisibilityBoundary | null>;
  overviewCounts(scope: OverviewScope): Promise<OverviewCounts>;
  listOverviewOpenCases(scope: OverviewScope, limit: number): Promise<OverviewOpenCaseRow[]>;
  listOverviewActivity(scope: OverviewScope, limit: number): Promise<OverviewActivityRow[]>;
  appendTimeline(caseId: string, event: TimelineInsert): Promise<TimelineRow>;
  listRevisions(contributionId: string): Promise<RevisionRow[]>;
  listLatestRevisions(caseId: string): Promise<RevisionRow[]>;
  insertRevision(rev: RevisionRow): Promise<void>;
  getArtifact(artifactId: string): Promise<ArtifactRow | null>;
  listArtifactsByCase(caseId: string): Promise<ArtifactRow[]>;
  insertArtifact(row: ArtifactRow): Promise<void>;
  listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]>;
  getSnapshot(snapshotId: string): Promise<SnapshotRow | null>;
  insertSnapshot(row: SnapshotRow): Promise<void>;
}

export type Queryable = Pick<Pool, "query">;

export class MemoryCaseStore implements CaseStore {
  private readonly cases = new Map<string, CaseRow>();
  private readonly timeline = new Map<string, TimelineRow[]>();
  private readonly revisions = new Map<string, RevisionRow[]>();
  private readonly artifacts = new Map<string, ArtifactRow>();
  private readonly snapshots = new Map<string, SnapshotRow>();

  async listCases(): Promise<CaseRow[]> {
    return [...this.cases.values()].map((row) => cloneCase(row));
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const row = this.cases.get(id);
    return row ? cloneCase(row) : null;
  }

  async insertCase(row: CaseRow): Promise<void> {
    this.cases.set(row.id, cloneCase(row));
    this.timeline.set(row.id, []);
  }

  async updateCaseMeta(row: Pick<CaseRow, "id" | "status" | "legalHold">): Promise<void> {
    const existing = this.cases.get(row.id);
    if (!existing) throw new Error("case not found");
    existing.status = row.status;
    existing.legalHold = row.legalHold;
  }

  async updateCaseSituation(
    row: {
      id: string;
      problemStatement: string;
      affectedParties: string;
      impact: string;
      scope: string;
      openQuestions: string[];
    },
  ): Promise<void> {
    const existing = this.cases.get(row.id);
    if (!existing) throw new Error("case not found");
    existing.problemStatement = row.problemStatement;
    existing.affectedParties = row.affectedParties;
    existing.impact = row.impact;
    existing.scope = row.scope;
    existing.openQuestions = [...row.openQuestions];
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
    return caseIds
      .flatMap((caseId) =>
        (this.timeline.get(caseId) ?? []).map((row) => ({ ...row, caseId })),
      )
      .sort((left, right) => {
        const byTime = right.serverTime.localeCompare(left.serverTime);
        if (byTime !== 0) return byTime;
        const byCase = left.caseId.localeCompare(right.caseId);
        return byCase !== 0 ? byCase : right.seq - left.seq;
      })
      .slice(0, limit);
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
    const list = this.timeline.get(caseId) ?? [];
    const row: TimelineRow = {
      seq: list.length + 1,
      kind: event.kind,
      actorId: event.actor.id,
      actorUsername: event.actor.username,
      targetId: event.targetId,
      clientTime: event.clientTime,
      serverTime: new Date().toISOString(),
      payload: JSON.stringify(event.payload),
    };
    list.push(row);
    this.timeline.set(caseId, list);
    return row;
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
      const row = chain[chain.length - 1];
      if (row && row.caseId === caseId) {
        latest.push({
          ...row,
          hypothesisLinks: [...row.hypothesisLinks],
        });
      }
    }
    return latest.sort((a, b) => a.contributionId.localeCompare(b.contributionId));
  }

  async insertRevision(rev: RevisionRow): Promise<void> {
    const chain = this.revisions.get(rev.contributionId) ?? [];
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

  async listArtifactsByCase(caseId: string): Promise<ArtifactRow[]> {
    return [...this.artifacts.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async insertArtifact(row: ArtifactRow): Promise<void> {
    this.artifacts.set(row.id, { ...row });
  }

  async listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]> {
    return [...this.snapshots.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => persistedSnapshot(row))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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

export class PgCaseStore implements CaseStore {
  constructor(private readonly db: Queryable) {}

  async listCases(): Promise<CaseRow[]> {
    const result = await this.db.query(`${CASE_SELECT} GROUP BY c.id`);
    return result.rows.map((row) => asCase(row as Record<string, unknown>));
  }

  async getCase(id: string): Promise<CaseRow | null> {
    const result = await this.db.query(`${CASE_SELECT} WHERE c.id = $1 GROUP BY c.id`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asCase(row) : null;
  }

  async insertCase(row: CaseRow): Promise<void> {
    await this.db.query(
      `INSERT INTO cases (
         id, title, problem_statement, affected_parties, impact, situation_scope, open_questions,
         severity, status, legal_hold, retention_class,
         created_at, created_by, created_by_username, last_seq
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, 0)`,
      [
        row.id,
        row.title,
        row.problemStatement ?? "",
        row.affectedParties ?? "",
        row.impact ?? "",
        row.scope ?? "",
        JSON.stringify(row.openQuestions ?? []),
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

  async updateCaseMeta(row: Pick<CaseRow, "id" | "status" | "legalHold">): Promise<void> {
    const result = await this.db.query(
      `UPDATE cases SET status = $2, legal_hold = $3 WHERE id = $1`,
      [row.id, row.status, row.legalHold],
    );
    if (result.rowCount === 0) throw new Error("case not found");
  }

  async updateCaseSituation(
    row: {
      id: string;
      problemStatement: string;
      affectedParties: string;
      impact: string;
      scope: string;
      openQuestions: string[];
    },
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE cases
       SET problem_statement = $2, affected_parties = $3, impact = $4, situation_scope = $5,
           open_questions = $6::jsonb
       WHERE id = $1`,
      [
        row.id,
        row.problemStatement,
        row.affectedParties,
        row.impact,
        row.scope,
        JSON.stringify(row.openQuestions),
      ],
    );
    if (result.rowCount === 0) throw new Error("case not found");
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
    if (caseIds.length === 0) return [];
    const result = await this.db.query(
      `SELECT case_id, seq, kind, actor_id, actor_username, target_id,
              client_time, server_time, payload
       FROM timeline_events
       WHERE case_id = ANY($1::uuid[])
       ORDER BY server_time DESC, case_id ASC, seq DESC
       LIMIT $2`,
      [caseIds, limit],
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
    const seqRes = await this.db.query<{ last_seq: string | number }>(
      `UPDATE cases SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
      [caseId],
    );
    const seqRaw = seqRes.rows[0]?.last_seq;
    if (seqRaw === undefined) throw new Error("case not found");
    const seq = Number(seqRaw);
    const serverTime = new Date().toISOString();
    const payload = JSON.stringify(event.payload);
    await this.db.query(
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
       ORDER BY r.contribution_id ASC`,
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

  async listArtifactsByCase(caseId: string): Promise<ArtifactRow[]> {
    const result = await this.db.query(
      `SELECT * FROM evidence_artifacts WHERE case_id = $1 ORDER BY id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asArtifact(row as Record<string, unknown>));
  }

  async insertArtifact(row: ArtifactRow): Promise<void> {
    await this.db.query(
      `INSERT INTO evidence_artifacts (
         id, case_id, kind, filename, uri, media_type, byte_length, content_hash,
         expected_hash, verification_status, ref_id, privacy_class,
         summary_contribution_id, uploader_id, uploader_username, source_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
      ],
    );
  }

  async listSnapshotsByCase(caseId: string): Promise<SnapshotRow[]> {
    const result = await this.db.query(
      `SELECT id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
              protocol_version, fairness_class, status, created_at, created_by
       FROM snapshots WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => asSnapshot(row as Record<string, unknown>));
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
              protocol_version, fairness_class, status, created_at, created_by
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
         protocol_version, fairness_class, status, created_at, created_by
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
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
      ],
    );
  }
}

const CASE_SELECT = `
  SELECT c.id, c.title, c.problem_statement, c.affected_parties, c.impact, c.situation_scope,
         c.open_questions, c.severity, c.status, c.legal_hold, c.retention_class,
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

function cloneCase(row: CaseRow): CaseRow {
  return {
    ...row,
    problemStatement: row.problemStatement ?? "",
    affectedParties: row.affectedParties ?? "",
    impact: row.impact ?? "",
    scope: row.scope ?? "",
    openQuestions: Array.isArray(row.openQuestions) ? [...row.openQuestions] : [],
    participants: row.participants.map((p) => ({ ...p })),
  };
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
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
    openQuestions: Array.isArray(row.open_questions)
      ? row.open_questions.map((question) => String(question))
      : [],
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
  });
}
