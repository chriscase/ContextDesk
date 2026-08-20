import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";

export const JOB_KINDS = ["host_triage_lane"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  "queued",
  "leased",
  "completed",
  "failed",
  "cancelled",
  "deadline",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  leaseOwner: string | null;
  leaseUntil: string | null;
  payloadHash: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
}

export interface JobStore {
  insert(row: Omit<JobRow, "createdAt" | "updatedAt" | "attempts" | "status"> & {
    status?: JobStatus;
  }): Promise<JobRow>;
  get(id: string): Promise<JobRow | null>;
  listByHash(payloadHash: string): Promise<JobRow[]>;
  acquire(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null>;
  renew(id: string, owner: string, leaseMs: number, now?: Date): Promise<JobRow | null>;
  complete(id: string, owner: string, result: Record<string, unknown>): Promise<JobRow>;
  fail(id: string, owner: string, result: Record<string, unknown>): Promise<JobRow>;
  requestCancel(id: string): Promise<JobRow | null>;
  stealStale(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null>;
}

export function payloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function clone(row: JobRow): JobRow {
  return {
    ...row,
    payload: { ...row.payload },
    result: row.result ? { ...row.result } : null,
  };
}

export class MemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRow>();

  async insert(
    input: Omit<JobRow, "createdAt" | "updatedAt" | "attempts" | "status"> & {
      status?: JobStatus;
    },
  ): Promise<JobRow> {
    const existing = [...this.rows.values()].find((row) => row.payloadHash === input.payloadHash);
    if (existing) return clone(existing);
    const stamp = nowIso();
    const row: JobRow = {
      ...input,
      status: input.status ?? "queued",
      attempts: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.rows.set(row.id, row);
    return clone(row);
  }

  async get(id: string): Promise<JobRow | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }

  async listByHash(hash: string): Promise<JobRow[]> {
    return [...this.rows.values()].filter((row) => row.payloadHash === hash).map(clone);
  }

  async acquire(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    for (const row of this.rows.values()) {
      if (row.status !== "queued") continue;
      if (row.cancelRequested) {
        row.status = "cancelled";
        row.updatedAt = stamp.toISOString();
        continue;
      }
      row.status = "leased";
      row.leaseOwner = owner;
      row.leaseUntil = new Date(stamp.getTime() + leaseMs).toISOString();
      row.attempts += 1;
      row.updatedAt = stamp.toISOString();
      return clone(row);
    }
    return this.stealStale(owner, leaseMs, stamp);
  }

  async renew(id: string, owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const row = this.rows.get(id);
    const stamp = now ?? new Date();
    if (!row || row.leaseOwner !== owner || row.status !== "leased") return null;
    row.leaseUntil = new Date(stamp.getTime() + leaseMs).toISOString();
    row.updatedAt = stamp.toISOString();
    return clone(row);
  }

  async complete(
    id: string,
    owner: string,
    result: Record<string, unknown>,
  ): Promise<JobRow> {
    return this.finish(id, owner, "completed", result);
  }

  async fail(id: string, owner: string, result: Record<string, unknown>): Promise<JobRow> {
    return this.finish(id, owner, "failed", result);
  }

  async requestCancel(id: string): Promise<JobRow | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    row.cancelRequested = true;
    if (row.status === "queued") row.status = "cancelled";
    row.updatedAt = nowIso();
    return clone(row);
  }

  async stealStale(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    for (const row of this.rows.values()) {
      if (row.status !== "leased" || !row.leaseUntil) continue;
      if (Date.parse(row.leaseUntil) > stamp.getTime()) continue;
      if (row.cancelRequested) {
        row.status = "cancelled";
        row.leaseOwner = null;
        row.leaseUntil = null;
        row.updatedAt = stamp.toISOString();
        continue;
      }
      row.leaseOwner = owner;
      row.leaseUntil = new Date(stamp.getTime() + leaseMs).toISOString();
      row.attempts += 1;
      row.updatedAt = stamp.toISOString();
      return clone(row);
    }
    return null;
  }

  private finish(
    id: string,
    owner: string,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ): JobRow {
    const row = this.rows.get(id);
    if (!row || row.leaseOwner !== owner) {
      throw new Error("job lease is not held by this worker");
    }
    row.status = row.cancelRequested && status === "failed" ? "cancelled" : status;
    row.result = { ...result };
    row.leaseOwner = null;
    row.leaseUntil = null;
    row.updatedAt = nowIso();
    return clone(row);
  }
}

export class PgJobStore implements JobStore {
  constructor(private readonly client: Pick<Client, "query">) {}

  async insert(
    input: Omit<JobRow, "createdAt" | "updatedAt" | "attempts" | "status"> & {
      status?: JobStatus;
    },
  ): Promise<JobRow> {
    const existing = await this.listByHash(input.payloadHash);
    if (existing[0]) return existing[0];
    const stamp = nowIso();
    const status = input.status ?? "queued";
    await this.client.query(
      `INSERT INTO collab_jobs (
         id, kind, status, lease_owner, lease_until, payload_hash, payload_json,
         result_json, attempts, created_at, updated_at, cancel_requested
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
      [
        input.id,
        input.kind,
        status,
        input.leaseOwner,
        input.leaseUntil,
        input.payloadHash,
        JSON.stringify(input.payload),
        input.result ? JSON.stringify(input.result) : null,
        0,
        stamp,
        stamp,
        input.cancelRequested,
      ],
    );
    const row = await this.get(input.id);
    if (!row) throw new Error("job insert did not persist");
    return row;
  }

  async get(id: string): Promise<JobRow | null> {
    const result = await this.client.query("SELECT * FROM collab_jobs WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapPg(row as Record<string, unknown>) : null;
  }

  async listByHash(hash: string): Promise<JobRow[]> {
    const result = await this.client.query(
      "SELECT * FROM collab_jobs WHERE payload_hash = $1 ORDER BY created_at",
      [hash],
    );
    return result.rows.map((row) => mapPg(row as Record<string, unknown>));
  }

  async acquire(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const queued = await this.client.query(
      `UPDATE collab_jobs
         SET status = 'leased',
             lease_owner = $1,
             lease_until = $2,
             attempts = attempts + 1,
             updated_at = $3
       WHERE id = (
         SELECT id FROM collab_jobs
          WHERE status = 'queued' AND cancel_requested = false
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING *`,
      [owner, until, stamp.toISOString()],
    );
    if (queued.rows[0]) return mapPg(queued.rows[0] as Record<string, unknown>);
    await this.client.query(
      `UPDATE collab_jobs
          SET status = 'cancelled', updated_at = $1
        WHERE status = 'queued' AND cancel_requested = true`,
      [stamp.toISOString()],
    );
    return this.stealStale(owner, leaseMs, stamp);
  }

  async renew(id: string, owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const result = await this.client.query(
      `UPDATE collab_jobs
          SET lease_until = $3, updated_at = $4
        WHERE id = $1 AND lease_owner = $2 AND status = 'leased'
        RETURNING *`,
      [id, owner, until, stamp.toISOString()],
    );
    return result.rows[0] ? mapPg(result.rows[0] as Record<string, unknown>) : null;
  }

  async complete(
    id: string,
    owner: string,
    result: Record<string, unknown>,
  ): Promise<JobRow> {
    return this.finish(id, owner, "completed", result);
  }

  async fail(id: string, owner: string, result: Record<string, unknown>): Promise<JobRow> {
    return this.finish(id, owner, "failed", result);
  }

  async requestCancel(id: string): Promise<JobRow | null> {
    const result = await this.client.query(
      `UPDATE collab_jobs
          SET cancel_requested = true,
              status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              updated_at = $2
        WHERE id = $1
        RETURNING *`,
      [id, nowIso()],
    );
    return result.rows[0] ? mapPg(result.rows[0] as Record<string, unknown>) : null;
  }

  async stealStale(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const result = await this.client.query(
      `UPDATE collab_jobs
          SET lease_owner = $1,
              lease_until = $2,
              attempts = attempts + 1,
              updated_at = $3
        WHERE id = (
          SELECT id FROM collab_jobs
           WHERE status = 'leased'
             AND lease_until IS NOT NULL
             AND lease_until < $3
             AND cancel_requested = false
           ORDER BY lease_until
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      [owner, until, stamp.toISOString()],
    );
    if (result.rows[0]) return mapPg(result.rows[0] as Record<string, unknown>);
    await this.client.query(
      `UPDATE collab_jobs
          SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = $1
        WHERE status = 'leased' AND cancel_requested = true AND lease_until < $1`,
      [stamp.toISOString()],
    );
    return null;
  }

  private async finish(
    id: string,
    owner: string,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ): Promise<JobRow> {
    const updated = await this.client.query(
      `UPDATE collab_jobs
          SET status = CASE WHEN cancel_requested AND $3 = 'failed' THEN 'cancelled' ELSE $3 END,
              result_json = $4::jsonb,
              lease_owner = NULL,
              lease_until = NULL,
              updated_at = $5
        WHERE id = $1 AND lease_owner = $2
        RETURNING *`,
      [id, owner, status, JSON.stringify(result), nowIso()],
    );
    if (!updated.rows[0]) throw new Error("job lease is not held by this worker");
    return mapPg(updated.rows[0] as Record<string, unknown>);
  }
}

function mapPg(row: Record<string, unknown>): JobRow {
  return {
    id: String(row.id),
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseUntil: row.lease_until ? new Date(String(row.lease_until)).toISOString() : null,
    payloadHash: String(row.payload_hash),
    payload: (row.payload_json ?? {}) as Record<string, unknown>,
    result: (row.result_json as Record<string, unknown> | null) ?? null,
    attempts: Number(row.attempts),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    cancelRequested: Boolean(row.cancel_requested),
  };
}

export function newJobId(): string {
  return randomUUID();
}
