import type { Pool } from "pg";
import { parseTriageJob, type TriageJobV1 } from "@cd-collab/contracts";
import {
  overviewVisiblePredicate,
  type OverviewScope,
  type OverviewVisibilityBoundary,
} from "../cases/index.js";

export interface OverviewListedJob {
  job: TriageJobV1;
  caseTitle: string;
}

export interface OverviewJobQuery extends OverviewScope {
  statuses: TriageJobV1["status"][];
  limit: number;
  visibility: OverviewVisibilityBoundary | null;
}

export interface TriageJobStore {
  insert(job: TriageJobV1): Promise<void>;
  get(id: string): Promise<TriageJobV1 | null>;
  listByCase(caseId: string): Promise<TriageJobV1[]>;
  listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]>;
  listOverviewJobs(query: OverviewJobQuery): Promise<OverviewListedJob[]>;
  /** Atomically claims a queued job for one worker. */
  claimQueued(
    id: string,
    startedAt: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<TriageJobV1 | null>;
  /** Returns only running jobs whose lease is absent or expired. */
  listStaleRunning(now: string): Promise<TriageJobV1[]>;
  /** Renews ownership only for the current worker and an unexpired lease. */
  renewLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean>;
  /** Atomically converts one expired running job to its recovered terminal state. */
  recoverStale(job: TriageJobV1, now: string): Promise<boolean>;
  update(job: TriageJobV1): Promise<void>;
}

function cloneJob(job: TriageJobV1): TriageJobV1 {
  return {
    ...job,
    request: {
      ...job.request,
      candidates: job.request.candidates.map((candidate) => ({ ...candidate })),
    },
    candidates: job.candidates.map((candidate) => ({
      ...candidate,
      evidenceRefs: [...candidate.evidenceRefs],
      unknowns: [...candidate.unknowns],
    })),
  };
}

export class MemoryTriageJobStore implements TriageJobStore {
  private readonly jobs = new Map<string, TriageJobV1>();

  capture(): unknown {
    return structuredClone({ jobs: [...this.jobs.entries()] });
  }

  restore(snapshot: unknown): void {
    const row = structuredClone(snapshot) as { jobs: [string, TriageJobV1][] };
    this.jobs.clear();
    for (const [id, value] of row.jobs) this.jobs.set(id, value);
  }

  async insert(job: TriageJobV1): Promise<void> {
    if (this.jobs.has(job.id)) throw new Error("triage job already exists");
    this.jobs.set(job.id, cloneJob(job));
  }

  async get(id: string): Promise<TriageJobV1 | null> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  async listByCase(caseId: string): Promise<TriageJobV1[]> {
    return [...this.jobs.values()]
      .filter((job) => job.caseId === caseId)
      .map((job) => cloneJob(job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]> {
    const allowed = new Set(statuses);
    return [...this.jobs.values()]
      .filter((job) => allowed.has(job.status))
      .map((job) => cloneJob(job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listOverviewJobs(query: OverviewJobQuery): Promise<OverviewListedJob[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (query.statuses.length === 0 || cap === 0) return [];
    const allowed = new Set(query.statuses);
    const titles = new Map<string, string | null>();
    const listed: OverviewListedJob[] = [];
    for (const job of this.jobs.values()) {
      if (!allowed.has(job.status)) continue;
      if (!titles.has(job.caseId)) {
        titles.set(job.caseId, query.visibility?.caseTitle(job.caseId) ?? null);
      }
      const caseTitle = titles.get(job.caseId);
      if (!caseTitle) continue;
      listed.push({ job: cloneJob(job), caseTitle });
    }
    return listed
      .sort((left, right) => {
        const byUpdated = right.job.updatedAt.localeCompare(left.job.updatedAt);
        return byUpdated !== 0 ? byUpdated : left.job.id.localeCompare(right.job.id);
      })
      .slice(0, cap);
  }

  async claimQueued(
    id: string,
    startedAt: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<TriageJobV1 | null> {
    const existing = this.jobs.get(id);
    if (!existing || existing.status !== "queued") return null;
    const claimed: TriageJobV1 = {
      ...existing,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      workerId,
      leaseExpiresAt,
    };
    this.jobs.set(id, cloneJob(claimed));
    return cloneJob(claimed);
  }

  async listStaleRunning(now: string): Promise<TriageJobV1[]> {
    const at = Date.parse(now);
    return [...this.jobs.values()]
      .filter((job) =>
        job.status === "running"
        && (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= at),
      )
      .map(cloneJob);
  }

  async renewLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean> {
    const existing = this.jobs.get(id);
    if (
      !existing
      || existing.status !== "running"
      || existing.workerId !== workerId
      || !existing.leaseExpiresAt
      || Date.parse(existing.leaseExpiresAt) <= Date.now()
    ) return false;
    this.jobs.set(id, cloneJob({ ...existing, leaseExpiresAt, updatedAt: new Date().toISOString() }));
    return true;
  }

  async recoverStale(job: TriageJobV1, now: string): Promise<boolean> {
    const existing = this.jobs.get(job.id);
    if (
      !existing
      || existing.status !== "running"
      || (existing.workerId ?? null) !== (job.workerId ?? null)
      || (existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > Date.parse(now))
    ) return false;
    this.jobs.set(job.id, cloneJob(job));
    return true;
  }

  async update(job: TriageJobV1): Promise<void> {
    const existing = this.jobs.get(job.id);
    if (!existing) throw new Error("triage job not found");
    if (existing.caseId !== job.caseId) throw new Error("triage job case cannot change");
    this.jobs.set(job.id, cloneJob(job));
  }
}

export type Queryable = Pick<Pool, "query">;

export class PgTriageJobStore implements TriageJobStore {
  constructor(private readonly db: Queryable) {}

  private static withLease(
    row: { payload?: unknown; lease_owner?: unknown; lease_expires_at?: unknown },
  ): TriageJobV1 {
    const job = parseTriageJob(row.payload);
    const workerId = row.lease_owner;
    const leaseExpiresAt = row.lease_expires_at;
    return {
      ...job,
      workerId: workerId === null || workerId === undefined ? null : String(workerId),
      leaseExpiresAt:
        leaseExpiresAt === null || leaseExpiresAt === undefined
          ? null
          : leaseExpiresAt instanceof Date
            ? leaseExpiresAt.toISOString()
            : String(leaseExpiresAt),
    };
  }

  async insert(job: TriageJobV1): Promise<void> {
    await this.db.query(
      `INSERT INTO triage_jobs (
         id, case_id, snapshot_id, snapshot_fingerprint, request_fingerprint,
         status, payload, created_at, updated_at, lease_owner, lease_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [
        job.id,
        job.caseId,
        job.snapshotId,
        job.snapshotFingerprint,
        job.requestFingerprint,
        job.status,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
        job.workerId ?? null,
        job.leaseExpiresAt ?? null,
      ],
    );
  }

  async get(id: string): Promise<TriageJobV1 | null> {
    const result = await this.db.query(
      `SELECT payload, lease_owner, lease_expires_at FROM triage_jobs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0] as
      | { payload?: unknown; lease_owner?: unknown; lease_expires_at?: unknown }
      | undefined;
    return row ? PgTriageJobStore.withLease(row) : null;
  }

  async listByCase(caseId: string): Promise<TriageJobV1[]> {
    const result = await this.db.query(
      `SELECT payload, lease_owner, lease_expires_at
       FROM triage_jobs WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as {
      payload?: unknown;
      lease_owner?: unknown;
      lease_expires_at?: unknown;
    }));
  }

  async listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]> {
    if (statuses.length === 0) return [];
    const result = await this.db.query(
      `SELECT payload, lease_owner, lease_expires_at FROM triage_jobs
       WHERE status = ANY($1::text[]) ORDER BY created_at ASC, id ASC`,
      [statuses],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as {
      payload?: unknown;
      lease_owner?: unknown;
      lease_expires_at?: unknown;
    }));
  }

  async listOverviewJobs(query: OverviewJobQuery): Promise<OverviewListedJob[]> {
    const cap = Math.max(0, Math.trunc(query.limit) || 0);
    if (query.statuses.length === 0 || cap === 0) return [];
    const result = await this.db.query(
      `SELECT j.payload, j.lease_owner, j.lease_expires_at, c.title AS case_title
       FROM triage_jobs j
       INNER JOIN cases c ON c.id = j.case_id
       WHERE j.status = ANY($3::text[])
         AND ${overviewVisiblePredicate("j.case_id", "$1", "$2")}
       ORDER BY j.updated_at DESC, j.id ASC
       LIMIT $4`,
      [query.isAdmin, query.actorId, query.statuses, cap],
    );
    return result.rows.map((row) => ({
      job: PgTriageJobStore.withLease(row as {
        payload?: unknown;
        lease_owner?: unknown;
        lease_expires_at?: unknown;
      }),
      caseTitle: String((row as { case_title?: unknown }).case_title ?? ""),
    })).filter((row) => row.caseTitle.length > 0);
  }

  async claimQueued(
    id: string,
    startedAt: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<TriageJobV1 | null> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = 'running',
           payload = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(payload, '{status}', '"running"'::jsonb),
                 '{workerId}', to_jsonb($3::text), true
               ),
               '{startedAt}', to_jsonb($2::text), true
             ),
             '{updatedAt}', to_jsonb($2::text), true
           ),
           updated_at = $2,
           lease_owner = $3,
           lease_expires_at = $4::timestamptz
       WHERE id = $1 AND status = 'queued'
       RETURNING payload, lease_owner, lease_expires_at`,
      [id, startedAt, workerId, leaseExpiresAt],
    );
    const row = result.rows[0] as
      | { payload?: unknown; lease_owner?: unknown; lease_expires_at?: unknown }
      | undefined;
    return row ? PgTriageJobStore.withLease(row) : null;
  }

  async listStaleRunning(now: string): Promise<TriageJobV1[]> {
    const result = await this.db.query(
      `SELECT payload, lease_owner, lease_expires_at FROM triage_jobs
       WHERE status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
       ORDER BY created_at ASC, id ASC`,
      [now],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as {
      payload?: unknown;
      lease_owner?: unknown;
      lease_expires_at?: unknown;
    }));
  }

  async renewLease(id: string, workerId: string, leaseExpiresAt: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET payload = jsonb_set(payload, '{leaseExpiresAt}', to_jsonb($3::text), true),
           lease_expires_at = $3::timestamptz,
           updated_at = now()
       WHERE id = $1 AND status = 'running' AND lease_owner = $2
         AND lease_expires_at > now()`,
      [id, workerId, leaseExpiresAt],
    );
    return result.rowCount === 1;
  }

  async recoverStale(job: TriageJobV1, _now: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = $2, payload = $3::jsonb, updated_at = $4,
           lease_owner = $6, lease_expires_at = NULL
       WHERE id = $1 AND case_id = $5 AND status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= $4::timestamptz)
         AND lease_owner IS NOT DISTINCT FROM $6`,
      [job.id, job.status, JSON.stringify(job), job.updatedAt, job.caseId, job.workerId ?? null],
    );
    return result.rowCount === 1;
  }

  async update(job: TriageJobV1): Promise<void> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = $2, payload = $3::jsonb, updated_at = $4,
           lease_owner = $6, lease_expires_at = $7::timestamptz
       WHERE id = $1 AND case_id = $5
         AND lease_owner IS NOT DISTINCT FROM $6`,
      [job.id, job.status, JSON.stringify(job), job.updatedAt, job.caseId, job.workerId ?? null, job.leaseExpiresAt ?? null],
    );
    if (result.rowCount !== 1) throw new Error("triage job not found");
  }
}
