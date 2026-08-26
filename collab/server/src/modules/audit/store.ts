import { AsyncLocalStorage } from "node:async_hooks";
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

export type AuditQueryable = Pick<Pool, "query">;

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
  private readonly tracked = new AsyncLocalStorage<{ ids: number[] }>();

  capture(): unknown {
    return { rows: this.rows.map((row) => ({ ...row })), nextId: this.nextId };
  }

  restore(snapshot: unknown): void {
    const state = snapshot as { rows: StoredAudit[]; nextId: number };
    this.rows.length = 0;
    this.rows.push(...state.rows.map((row) => ({ ...row, at: new Date(row.at) })));
    this.nextId = state.nextId;
  }

  runTracked<T>(operation: () => Promise<T>): Promise<T> {
    const existing = this.tracked.getStore();
    if (existing) return operation();
    return this.tracked.run({ ids: [] }, operation);
  }

  rollbackTracked(): void {
    const ids = this.tracked.getStore()?.ids;
    if (!ids || ids.length === 0) return;
    const remove = new Set(ids);
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (remove.has(this.rows[index]!.id)) this.rows.splice(index, 1);
    }
    ids.length = 0;
  }

  async append(record: AuditRecord): Promise<StoredAudit> {
    const stored: StoredAudit = { ...record, id: this.nextId, at: new Date() };
    this.nextId += 1;
    this.rows.push(stored);
    this.tracked.getStore()?.ids.push(stored.id);
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
  constructor(private readonly pool: AuditQueryable) {}

  private get db(): AuditQueryable {
    return pgAuditTx.getStore() ?? this.pool;
  }

  isBoundTo(queryable: AuditQueryable): boolean {
    return this.pool === queryable;
  }

  async appendUsing(queryable: AuditQueryable, record: AuditRecord): Promise<StoredAudit> {
    return appendPgAudit(queryable, record);
  }

  async append(record: AuditRecord): Promise<StoredAudit> {
    return appendPgAudit(this.db, record);
  }

  async withTransaction<T>(queryable: AuditQueryable, operation: () => Promise<T>): Promise<T> {
    return pgAuditTx.run(queryable, operation);
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

const pgAuditTx = new AsyncLocalStorage<AuditQueryable>();

async function appendPgAudit(
  queryable: AuditQueryable,
  record: AuditRecord,
): Promise<StoredAudit> {
  const result = await queryable.query(
    `INSERT INTO audit_events (identity, action, target, origin, outcome)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, at, identity, action, target, origin, outcome`,
    [record.identity, record.action, record.target, record.origin, record.outcome],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error("audit insert returned no row");
  return asRow(row);
}
