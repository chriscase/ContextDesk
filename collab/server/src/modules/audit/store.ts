import type { Pool } from "pg";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditRecord {
  identity: string | null;
  action: string;
  target: string | null;
  origin: string | null;
  outcome: AuditOutcome;
}

export interface StoredAudit extends AuditRecord {
  id: number;
  at: Date;
}

export interface AuditStore {
  append(record: AuditRecord): Promise<StoredAudit>;
  list(filter?: { action?: string; identity?: string }): Promise<StoredAudit[]>;
}

function asRow(row: Record<string, unknown>): StoredAudit {
  return {
    id: Number(row.id),
    at: row.at instanceof Date ? row.at : new Date(String(row.at)),
    identity: (row.identity as string | null) ?? null,
    action: String(row.action),
    target: (row.target as string | null) ?? null,
    origin: (row.origin as string | null) ?? null,
    outcome: row.outcome as AuditOutcome,
  };
}

export class MemoryAuditStore implements AuditStore {
  private readonly rows: StoredAudit[] = [];
  private nextId = 1;

  async append(record: AuditRecord): Promise<StoredAudit> {
    const stored: StoredAudit = { ...record, id: this.nextId, at: new Date() };
    this.nextId += 1;
    this.rows.push(stored);
    return stored;
  }

  async list(filter?: { action?: string; identity?: string }): Promise<StoredAudit[]> {
    return this.rows.filter((r) => {
      if (filter?.action && r.action !== filter.action) return false;
      if (filter?.identity && r.identity !== filter.identity) return false;
      return true;
    });
  }
}

export class PgAuditStore implements AuditStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async append(record: AuditRecord): Promise<StoredAudit> {
    const result = await this.pool.query(
      `INSERT INTO audit_events (identity, action, target, origin, outcome)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, at, identity, action, target, origin, outcome`,
      [record.identity, record.action, record.target, record.origin, record.outcome],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("audit insert returned no row");
    return asRow(row);
  }

  async list(filter?: { action?: string; identity?: string }): Promise<StoredAudit[]> {
    const result = await this.pool.query(
      `SELECT id, at, identity, action, target, origin, outcome
       FROM audit_events
       WHERE ($1::text IS NULL OR action = $1)
         AND ($2::text IS NULL OR identity = $2)
       ORDER BY id ASC`,
      [filter?.action ?? null, filter?.identity ?? null],
    );
    return result.rows.map((r) => asRow(r as Record<string, unknown>));
  }
}
