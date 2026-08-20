import { DatabaseSync } from "node:sqlite";
import {
  type JobKind,
  type JobRow,
  type JobStatus,
  type JobStore,
} from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collab_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS collab_jobs_hash_idx ON collab_jobs (payload_hash);
CREATE INDEX IF NOT EXISTS collab_jobs_status_idx ON collab_jobs (status, lease_until);
`;

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export class SqliteJobStore implements JobStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async insert(
    input: Omit<JobRow, "createdAt" | "updatedAt" | "attempts" | "status"> & {
      status?: JobStatus;
    },
  ): Promise<JobRow> {
    const existing = await this.listByHash(input.payloadHash);
    if (existing[0]) return existing[0];
    const stamp = nowIso();
    const status = input.status ?? "queued";
    this.db
      .prepare(
        `INSERT INTO collab_jobs (
           id, kind, status, lease_owner, lease_until, payload_hash, payload_json,
           result_json, attempts, created_at, updated_at, cancel_requested
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        status,
        input.leaseOwner,
        input.leaseUntil,
        input.payloadHash,
        JSON.stringify(input.payload),
        input.result ? JSON.stringify(input.result) : null,
        stamp,
        stamp,
        input.cancelRequested ? 1 : 0,
      );
    const row = await this.get(input.id);
    if (!row) throw new Error("sqlite job insert did not persist");
    return row;
  }

  async get(id: string): Promise<JobRow | null> {
    const row = this.db.prepare("SELECT * FROM collab_jobs WHERE id = ?").get(id);
    return row ? mapSqlite(row as Record<string, unknown>) : null;
  }

  async listByHash(hash: string): Promise<JobRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM collab_jobs WHERE payload_hash = ? ORDER BY created_at")
      .all(hash);
    return rows.map((row) => mapSqlite(row as Record<string, unknown>));
  }

  async acquire(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const queued = this.db
      .prepare(
        `SELECT id FROM collab_jobs
          WHERE status = 'queued' AND cancel_requested = 0
          ORDER BY created_at LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (queued) {
      this.db
        .prepare(
          `UPDATE collab_jobs
              SET status = 'leased', lease_owner = ?, lease_until = ?,
                  attempts = attempts + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(owner, until, stamp.toISOString(), queued.id);
      return this.get(queued.id);
    }
    this.db
      .prepare(
        `UPDATE collab_jobs SET status = 'cancelled', updated_at = ?
          WHERE status = 'queued' AND cancel_requested = 1`,
      )
      .run(stamp.toISOString());
    return this.stealStale(owner, leaseMs, stamp);
  }

  async renew(id: string, owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE collab_jobs
            SET lease_until = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND status = 'leased'`,
      )
      .run(until, stamp.toISOString(), id, owner);
    if (!result.changes) return null;
    return this.get(id);
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
    this.db
      .prepare(
        `UPDATE collab_jobs
            SET cancel_requested = 1,
                status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(nowIso(), id);
    return this.get(id);
  }

  async stealStale(owner: string, leaseMs: number, now?: Date): Promise<JobRow | null> {
    const stamp = now ?? new Date();
    const until = new Date(stamp.getTime() + leaseMs).toISOString();
    const stale = this.db
      .prepare(
        `SELECT id FROM collab_jobs
          WHERE status = 'leased'
            AND lease_until IS NOT NULL
            AND lease_until < ?
            AND cancel_requested = 0
          ORDER BY lease_until LIMIT 1`,
      )
      .get(stamp.toISOString()) as { id: string } | undefined;
    if (stale) {
      this.db
        .prepare(
          `UPDATE collab_jobs
              SET lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(owner, until, stamp.toISOString(), stale.id);
      return this.get(stale.id);
    }
    this.db
      .prepare(
        `UPDATE collab_jobs
            SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'leased' AND cancel_requested = 1 AND lease_until < ?`,
      )
      .run(stamp.toISOString(), stamp.toISOString());
    return null;
  }

  private async finish(
    id: string,
    owner: string,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ): Promise<JobRow> {
    const resultStatus =
      status === "failed"
        ? this.db
            .prepare("SELECT cancel_requested FROM collab_jobs WHERE id = ? AND lease_owner = ?")
            .get(id, owner) as { cancel_requested: number } | undefined
        : undefined;
    const next =
      resultStatus?.cancel_requested ? "cancelled" : status;
    const updated = this.db
      .prepare(
        `UPDATE collab_jobs
            SET status = ?, result_json = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND lease_owner = ?`,
      )
      .run(next, JSON.stringify(result), nowIso(), id, owner);
    if (!updated.changes) throw new Error("job lease is not held by this worker");
    const row = await this.get(id);
    if (!row) throw new Error("job missing after finish");
    return row;
  }
}

function mapSqlite(row: Record<string, unknown>): JobRow {
  return {
    id: String(row.id),
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseUntil: row.lease_until ? String(row.lease_until) : null,
    payloadHash: String(row.payload_hash),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    result: row.result_json ? (JSON.parse(String(row.result_json)) as Record<string, unknown>) : null,
    attempts: Number(row.attempts),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    cancelRequested: Boolean(row.cancel_requested),
  };
}

export function sqliteAvailable(): boolean {
  try {
    const probe = new DatabaseSync(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
}
