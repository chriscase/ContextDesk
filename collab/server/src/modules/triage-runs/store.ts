import type { Pool } from "pg";
import { parseTriageJob, type TriageJobV1 } from "@cd-collab/contracts";

export interface TriageJobIdempotencyAdmission {
  scopeDigest: string;
  bindingDigest: string;
}

export interface TriageJobCreateResult {
  job: TriageJobV1;
  created: boolean;
}

export class TriageJobIdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key is already bound to a different rerun");
    this.name = "TriageJobIdempotencyConflictError";
  }
}

export interface TriageJobStore {
  insert(job: TriageJobV1): Promise<void>;
  createOrReturn(
    job: TriageJobV1,
    idempotency: TriageJobIdempotencyAdmission | null,
  ): Promise<TriageJobCreateResult>;
  get(id: string): Promise<TriageJobV1 | null>;
  listByCase(caseId: string): Promise<TriageJobV1[]>;
  listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]>;
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
  return parseTriageJob({
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
  });
}

function requireDigest(name: string, value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

export class MemoryTriageJobStore implements TriageJobStore {
  private readonly jobs = new Map<string, TriageJobV1>();
  private readonly idempotencyScopes = new Map<
    string,
    { bindingDigest: string; jobId: string }
  >();

  async insert(job: TriageJobV1): Promise<void> {
    await this.createOrReturn(job, null);
  }

  async createOrReturn(
    job: TriageJobV1,
    idempotency: TriageJobIdempotencyAdmission | null,
  ): Promise<TriageJobCreateResult> {
    const validated = cloneJob(job);
    if (!idempotency) {
      if (this.jobs.has(job.id)) throw new Error("triage job already exists");
      this.jobs.set(job.id, validated);
      return { job: cloneJob(validated), created: true };
    }
    requireDigest("idempotency scope", idempotency.scopeDigest);
    requireDigest("idempotency binding", idempotency.bindingDigest);
    const admitted = this.idempotencyScopes.get(idempotency.scopeDigest);
    if (admitted) {
      if (admitted.bindingDigest !== idempotency.bindingDigest) {
        throw new TriageJobIdempotencyConflictError();
      }
      const existing = this.jobs.get(admitted.jobId);
      if (!existing) throw new Error("idempotent triage job is missing");
      return { job: cloneJob(existing), created: false };
    }
    if (this.jobs.has(job.id)) throw new Error("triage job already exists");
    this.jobs.set(job.id, validated);
    this.idempotencyScopes.set(idempotency.scopeDigest, {
      bindingDigest: idempotency.bindingDigest,
      jobId: job.id,
    });
    return { job: cloneJob(validated), created: true };
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
      || existing.caseId !== job.caseId
      || existing.snapshotId !== job.snapshotId
      || existing.snapshotFingerprint !== job.snapshotFingerprint
      || existing.requestFingerprint !== job.requestFingerprint
      || (existing.parentJobId ?? null) !== (job.parentJobId ?? null)
      || (existing.leaseExpiresAt && Date.parse(existing.leaseExpiresAt) > Date.parse(now))
    ) return false;
    this.jobs.set(job.id, cloneJob(job));
    return true;
  }

  async update(job: TriageJobV1): Promise<void> {
    const existing = this.jobs.get(job.id);
    if (!existing) throw new Error("triage job not found");
    if (existing.caseId !== job.caseId) throw new Error("triage job case cannot change");
    if (
      existing.snapshotId !== job.snapshotId
      || existing.snapshotFingerprint !== job.snapshotFingerprint
      || existing.requestFingerprint !== job.requestFingerprint
      || (existing.parentJobId ?? null) !== (job.parentJobId ?? null)
    ) throw new Error("triage job admission identity cannot change");
    this.jobs.set(job.id, cloneJob(job));
  }
}

export type Queryable = Pick<Pool, "query">;

type TriageJobRow = {
  id?: unknown;
  case_id?: unknown;
  snapshot_id?: unknown;
  snapshot_fingerprint?: unknown;
  request_fingerprint?: unknown;
  status?: unknown;
  payload?: unknown;
  lease_owner?: unknown;
  lease_expires_at?: unknown;
  parent_job_id?: unknown;
  idempotency_scope_digest?: unknown;
  idempotency_binding_digest?: unknown;
  created?: unknown;
};

const TRIAGE_JOB_SELECT = `id, case_id, snapshot_id, snapshot_fingerprint,
  request_fingerprint, status, payload, lease_owner, lease_expires_at,
  parent_job_id, idempotency_scope_digest, idempotency_binding_digest`;

export class PgTriageJobStore implements TriageJobStore {
  constructor(private readonly db: Queryable) {}

  private static withLease(row: TriageJobRow): TriageJobV1 {
    const job = parseTriageJob(row.payload);
    const expected = {
      id: String(row.id),
      caseId: String(row.case_id),
      snapshotId: String(row.snapshot_id),
      snapshotFingerprint: String(row.snapshot_fingerprint),
      requestFingerprint: String(row.request_fingerprint),
      status: String(row.status),
      parentJobId: row.parent_job_id === null || row.parent_job_id === undefined
        ? null
        : String(row.parent_job_id),
    };
    if (
      job.id !== expected.id
      || job.caseId !== expected.caseId
      || job.snapshotId !== expected.snapshotId
      || job.snapshotFingerprint !== expected.snapshotFingerprint
      || job.requestFingerprint !== expected.requestFingerprint
      || job.status !== expected.status
      || (job.parentJobId ?? null) !== expected.parentJobId
    ) {
      throw new Error("triage job payload does not match authoritative columns");
    }
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
    await this.createOrReturn(job, null);
  }

  async createOrReturn(
    job: TriageJobV1,
    idempotency: TriageJobIdempotencyAdmission | null,
  ): Promise<TriageJobCreateResult> {
    const validated = parseTriageJob(job);
    if (idempotency) {
      requireDigest("idempotency scope", idempotency.scopeDigest);
      requireDigest("idempotency binding", idempotency.bindingDigest);
    }
    const values = [
      validated.id,
      validated.caseId,
      validated.snapshotId,
      validated.snapshotFingerprint,
      validated.requestFingerprint,
      validated.status,
      JSON.stringify(validated),
      validated.createdAt,
      validated.updatedAt,
      validated.workerId ?? null,
      validated.leaseExpiresAt ?? null,
      validated.parentJobId ?? null,
      idempotency?.scopeDigest ?? null,
      idempotency?.bindingDigest ?? null,
    ];
    if (!idempotency) {
      await this.db.query(
        `INSERT INTO triage_jobs (
           id, case_id, snapshot_id, snapshot_fingerprint, request_fingerprint,
           status, payload, created_at, updated_at, lease_owner, lease_expires_at,
           parent_job_id, idempotency_scope_digest, idempotency_binding_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
        values,
      );
      return { job: parseTriageJob(validated), created: true };
    }
    const result = await this.db.query(
      `WITH inserted AS (
         INSERT INTO triage_jobs (
           id, case_id, snapshot_id, snapshot_fingerprint, request_fingerprint,
           status, payload, created_at, updated_at, lease_owner, lease_expires_at,
           parent_job_id, idempotency_scope_digest, idempotency_binding_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (idempotency_scope_digest)
           WHERE idempotency_scope_digest IS NOT NULL
           DO NOTHING
         RETURNING ${TRIAGE_JOB_SELECT}
       )
       SELECT ${TRIAGE_JOB_SELECT}, TRUE AS created FROM inserted
       UNION ALL
       SELECT ${TRIAGE_JOB_SELECT}, FALSE AS created FROM triage_jobs
       WHERE idempotency_scope_digest = $13
         AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      values,
    );
    const row = result.rows[0] as TriageJobRow | undefined;
    if (!row) throw new Error("idempotent triage job admission returned no row");
    if (String(row.idempotency_binding_digest) !== idempotency.bindingDigest) {
      throw new TriageJobIdempotencyConflictError();
    }
    return { job: PgTriageJobStore.withLease(row), created: row.created === true };
  }

  async get(id: string): Promise<TriageJobV1 | null> {
    const result = await this.db.query(
      `SELECT ${TRIAGE_JOB_SELECT} FROM triage_jobs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0] as TriageJobRow | undefined;
    return row ? PgTriageJobStore.withLease(row) : null;
  }

  async listByCase(caseId: string): Promise<TriageJobV1[]> {
    const result = await this.db.query(
      `SELECT ${TRIAGE_JOB_SELECT}
       FROM triage_jobs WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as TriageJobRow));
  }

  async listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]> {
    if (statuses.length === 0) return [];
    const result = await this.db.query(
      `SELECT ${TRIAGE_JOB_SELECT} FROM triage_jobs
       WHERE status = ANY($1::text[]) ORDER BY created_at ASC, id ASC`,
      [statuses],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as TriageJobRow));
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
       RETURNING ${TRIAGE_JOB_SELECT}`,
      [id, startedAt, workerId, leaseExpiresAt],
    );
    const row = result.rows[0] as TriageJobRow | undefined;
    return row ? PgTriageJobStore.withLease(row) : null;
  }

  async listStaleRunning(now: string): Promise<TriageJobV1[]> {
    const result = await this.db.query(
      `SELECT ${TRIAGE_JOB_SELECT} FROM triage_jobs
       WHERE status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
       ORDER BY created_at ASC, id ASC`,
      [now],
    );
    return result.rows.map((row) => PgTriageJobStore.withLease(row as TriageJobRow));
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
    const validated = parseTriageJob(job);
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = $2, payload = $3::jsonb, updated_at = $4,
           lease_owner = $6, lease_expires_at = NULL
       WHERE id = $1 AND case_id = $5 AND status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at <= $4::timestamptz)
         AND lease_owner IS NOT DISTINCT FROM $6
         AND parent_job_id IS NOT DISTINCT FROM $7
         AND snapshot_id = $8
         AND snapshot_fingerprint = $9
         AND request_fingerprint = $10`,
      [
        validated.id,
        validated.status,
        JSON.stringify(validated),
        validated.updatedAt,
        validated.caseId,
        validated.workerId ?? null,
        validated.parentJobId ?? null,
        validated.snapshotId,
        validated.snapshotFingerprint,
        validated.requestFingerprint,
      ],
    );
    return result.rowCount === 1;
  }

  async update(job: TriageJobV1): Promise<void> {
    const validated = parseTriageJob(job);
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = $2, payload = $3::jsonb, updated_at = $4,
           lease_owner = $6, lease_expires_at = $7::timestamptz
       WHERE id = $1 AND case_id = $5
         AND lease_owner IS NOT DISTINCT FROM $6
         AND parent_job_id IS NOT DISTINCT FROM $8
         AND snapshot_id = $9
         AND snapshot_fingerprint = $10
         AND request_fingerprint = $11`,
      [
        validated.id,
        validated.status,
        JSON.stringify(validated),
        validated.updatedAt,
        validated.caseId,
        validated.workerId ?? null,
        validated.leaseExpiresAt ?? null,
        validated.parentJobId ?? null,
        validated.snapshotId,
        validated.snapshotFingerprint,
        validated.requestFingerprint,
      ],
    );
    if (result.rowCount !== 1) throw new Error("triage job not found");
  }
}
