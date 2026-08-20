import type { Pool } from "pg";
import { parseTriageJob, type TriageJobV1 } from "@cd-collab/contracts";

export interface TriageJobStore {
  insert(job: TriageJobV1): Promise<void>;
  get(id: string): Promise<TriageJobV1 | null>;
  listByCase(caseId: string): Promise<TriageJobV1[]>;
  listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]>;
  /** Atomically claims a queued job for one worker. */
  claimQueued(id: string, startedAt: string): Promise<TriageJobV1 | null>;
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

  async claimQueued(id: string, startedAt: string): Promise<TriageJobV1 | null> {
    const existing = this.jobs.get(id);
    if (!existing || existing.status !== "queued") return null;
    const claimed: TriageJobV1 = {
      ...existing,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    this.jobs.set(id, cloneJob(claimed));
    return cloneJob(claimed);
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

  async insert(job: TriageJobV1): Promise<void> {
    await this.db.query(
      `INSERT INTO triage_jobs (
         id, case_id, snapshot_id, snapshot_fingerprint, request_fingerprint,
         status, payload, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
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
      ],
    );
  }

  async get(id: string): Promise<TriageJobV1 | null> {
    const result = await this.db.query(`SELECT payload FROM triage_jobs WHERE id = $1`, [id]);
    const row = result.rows[0] as { payload?: unknown } | undefined;
    return row ? parseTriageJob(row.payload) : null;
  }

  async listByCase(caseId: string): Promise<TriageJobV1[]> {
    const result = await this.db.query(
      `SELECT payload FROM triage_jobs WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => parseTriageJob((row as { payload: unknown }).payload));
  }

  async listByStatuses(statuses: TriageJobV1["status"][]): Promise<TriageJobV1[]> {
    if (statuses.length === 0) return [];
    const result = await this.db.query(
      `SELECT payload FROM triage_jobs WHERE status = ANY($1::text[]) ORDER BY created_at ASC, id ASC`,
      [statuses],
    );
    return result.rows.map((row) => parseTriageJob((row as { payload: unknown }).payload));
  }

  async claimQueued(id: string, startedAt: string): Promise<TriageJobV1 | null> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = 'running',
           payload = jsonb_set(
             jsonb_set(
               jsonb_set(payload, '{status}', '"running"'::jsonb),
               '{startedAt}', to_jsonb($2::text), true
             ),
             '{updatedAt}', to_jsonb($2::text), true
           ),
           updated_at = $2
       WHERE id = $1 AND status = 'queued'
       RETURNING payload`,
      [id, startedAt],
    );
    const row = result.rows[0] as { payload?: unknown } | undefined;
    return row ? parseTriageJob(row.payload) : null;
  }

  async update(job: TriageJobV1): Promise<void> {
    const result = await this.db.query(
      `UPDATE triage_jobs
       SET status = $2, payload = $3::jsonb, updated_at = $4
       WHERE id = $1 AND case_id = $5`,
      [job.id, job.status, JSON.stringify(job), job.updatedAt, job.caseId],
    );
    if (result.rowCount !== 1) throw new Error("triage job not found");
  }
}
