import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  InvestigationResourceKindV1,
  OccurredAtPrecision,
  OccurredAtZone,
  ReferenceState,
} from "@cd-collab/contracts";

export interface ReferenceRow {
  id: string;
  fromCaseId: string;
  toCaseId: string;
  resourceKind: InvestigationResourceKindV1;
  resourceId: string;
  locator: string;
  note: string;
  /** Immutable: what the cited investigation was called when it was cited. */
  recordedTitle: string;
  state: ReferenceState;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  withdrawnAt: string | null;
}

export interface ReferenceStore {
  listOutbound(fromCaseId: string): Promise<ReferenceRow[]>;
  listInbound(toCaseId: string): Promise<ReferenceRow[]>;
  get(id: string): Promise<ReferenceRow | null>;
  findActive(
    fromCaseId: string,
    toCaseId: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<ReferenceRow | null>;
  insert(row: ReferenceRow): Promise<void>;
  withdraw(id: string, withdrawnAt: string): Promise<void>;
}

export type Queryable = Pick<Pool, "query">;

export function newReferenceId(): string {
  return randomUUID();
}

export class DuplicateReferenceError extends Error {
  constructor(readonly existingId: string) {
    super("reference already recorded");
    this.name = "DuplicateReferenceError";
  }
}

export class MemoryReferenceStore implements ReferenceStore {
  private readonly references = new Map<string, ReferenceRow>();

  capture(): unknown {
    return structuredClone({ references: [...this.references.entries()] });
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as { references: [string, ReferenceRow][] };
    this.references.clear();
    for (const [id, value] of dump.references ?? []) this.references.set(id, value);
  }

  async listOutbound(fromCaseId: string): Promise<ReferenceRow[]> {
    return [...this.references.values()]
      .filter((row) => row.fromCaseId === fromCaseId)
      .map((row) => ({ ...row }));
  }

  async listInbound(toCaseId: string): Promise<ReferenceRow[]> {
    return [...this.references.values()]
      .filter((row) => row.toCaseId === toCaseId)
      .map((row) => ({ ...row }));
  }

  async get(id: string): Promise<ReferenceRow | null> {
    const row = this.references.get(id);
    return row ? { ...row } : null;
  }

  async findActive(
    fromCaseId: string,
    toCaseId: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<ReferenceRow | null> {
    for (const row of this.references.values()) {
      if (
        row.fromCaseId === fromCaseId &&
        row.toCaseId === toCaseId &&
        row.resourceKind === resourceKind &&
        row.resourceId === resourceId &&
        row.state === "active"
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async insert(row: ReferenceRow): Promise<void> {
    const existing = await this.findActive(
      row.fromCaseId,
      row.toCaseId,
      row.resourceKind,
      row.resourceId,
    );
    if (existing) throw new DuplicateReferenceError(existing.id);
    this.references.set(row.id, { ...row });
  }

  async withdraw(id: string, withdrawnAt: string): Promise<void> {
    const row = this.references.get(id);
    if (!row) throw new Error("reference not found");
    row.state = "withdrawn";
    row.withdrawnAt = withdrawnAt;
  }
}

function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asReference(row: Record<string, unknown>): ReferenceRow {
  return {
    id: String(row.id),
    fromCaseId: String(row.from_case_id),
    toCaseId: String(row.to_case_id),
    resourceKind: row.resource_kind as InvestigationResourceKindV1,
    resourceId: String(row.resource_id),
    locator: String(row.locator),
    note: row.note === null || row.note === undefined ? "" : String(row.note),
    recordedTitle: String(row.recorded_title),
    state: row.state as ReferenceState,
    occurredAt:
      row.occurred_at === null || row.occurred_at === undefined ? null : String(row.occurred_at),
    occurredAtPrecision: row.occurred_at_precision as OccurredAtPrecision,
    occurredAtZone: row.occurred_at_zone as OccurredAtZone,
    recordedAt: instant(row.recorded_at),
    recordedBy: String(row.recorded_by),
    recordedByUsername: String(row.recorded_by_username),
    withdrawnAt: nullableInstant(row.withdrawn_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

export class PgReferenceStore implements ReferenceStore {
  constructor(private readonly db: Queryable) {}

  async listOutbound(fromCaseId: string): Promise<ReferenceRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_references
       WHERE from_case_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [fromCaseId],
    );
    return result.rows.map((row) => asReference(row as Record<string, unknown>));
  }

  async listInbound(toCaseId: string): Promise<ReferenceRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_references
       WHERE to_case_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [toCaseId],
    );
    return result.rows.map((row) => asReference(row as Record<string, unknown>));
  }

  async get(id: string): Promise<ReferenceRow | null> {
    const result = await this.db.query(`SELECT * FROM investigation_references WHERE id = $1`, [
      id,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asReference(row) : null;
  }

  async findActive(
    fromCaseId: string,
    toCaseId: string,
    resourceKind: string,
    resourceId: string,
  ): Promise<ReferenceRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_references
       WHERE from_case_id = $1 AND to_case_id = $2
         AND resource_kind = $3 AND resource_id = $4 AND state = 'active'`,
      [fromCaseId, toCaseId, resourceKind, resourceId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asReference(row) : null;
  }

  async insert(row: ReferenceRow): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO investigation_references (
           id, from_case_id, to_case_id, resource_kind, resource_id, locator, note,
           recorded_title, state, occurred_at, occurred_at_precision, occurred_at_zone,
           recorded_at, recorded_by, recorded_by_username, withdrawn_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          row.id,
          row.fromCaseId,
          row.toCaseId,
          row.resourceKind,
          row.resourceId,
          row.locator,
          row.note,
          row.recordedTitle,
          row.state,
          row.occurredAt,
          row.occurredAtPrecision,
          row.occurredAtZone,
          row.recordedAt,
          row.recordedBy,
          row.recordedByUsername,
          row.withdrawnAt,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findActive(
        row.fromCaseId,
        row.toCaseId,
        row.resourceKind,
        row.resourceId,
      );
      throw new DuplicateReferenceError(existing?.id ?? row.id);
    }
  }

  async withdraw(id: string, withdrawnAt: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE investigation_references
       SET state = 'withdrawn', withdrawn_at = $2
       WHERE id = $1 AND state = 'active'`,
      [id, withdrawnAt],
    );
    if (result.rowCount === 0) throw new Error("reference not found");
  }
}
