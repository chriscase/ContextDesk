/**
 * Investigation-scoped software-impact persistence.
 *
 * Memory is the local/demo store. SQLite wraps this object. PostgreSQL uses
 * the same row shape and keeps active-identity uniqueness in the database so
 * two hosted writers cannot record the same claim concurrently.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  SoftwareImpactIdentityV1,
  SoftwareImpactState,
  SoftwareImpactStatus,
  SoftwareImpactV1,
} from "@cd-collab/contracts";
import { SOFTWARE_IMPACT_SCHEMA_ID, softwareImpactIdentityKey } from "@cd-collab/contracts";

export interface SoftwareImpactRow {
  id: string;
  caseId: string;
  productName: string;
  version: string;
  build: string;
  component: string;
  environment: string;
  status: SoftwareImpactStatus;
  note: string;
  state: SoftwareImpactState;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface SoftwareImpactStore {
  list(caseId: string): Promise<SoftwareImpactRow[]>;
  listAll(): Promise<SoftwareImpactRow[]>;
  get(id: string): Promise<SoftwareImpactRow | null>;
  findActiveIdentity(caseId: string, identity: SoftwareImpactIdentityV1): Promise<SoftwareImpactRow | null>;
  insert(row: SoftwareImpactRow): Promise<void>;
  updateStatus(id: string, status: SoftwareImpactStatus, note: string, updatedAt: string): Promise<void>;
  release(id: string, releasedAt: string): Promise<void>;
}

export type Queryable = Pick<Pool, "query">;

export function newSoftwareImpactId(): string {
  return randomUUID();
}

export function toSoftwareImpactV1(row: SoftwareImpactRow): SoftwareImpactV1 {
  return {
    schemaId: SOFTWARE_IMPACT_SCHEMA_ID,
    id: row.id,
    investigationId: row.caseId,
    productName: row.productName,
    version: row.version,
    build: row.build,
    component: row.component,
    environment: row.environment,
    status: row.status,
    note: row.note,
    state: row.state,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    recordedByUsername: row.recordedByUsername,
    updatedAt: row.updatedAt,
    releasedAt: row.releasedAt,
  };
}

export class DuplicateSoftwareImpactError extends Error {
  constructor(readonly existingId: string) {
    super("software impact already recorded");
    this.name = "DuplicateSoftwareImpactError";
  }
}

export class SoftwareImpactNotFoundError extends Error {
  constructor() {
    super("software impact not found");
    this.name = "SoftwareImpactNotFoundError";
  }
}

export class SoftwareImpactReleasedError extends Error {
  constructor() {
    super("software impact is released");
    this.name = "SoftwareImpactReleasedError";
  }
}

export class InvestigationNotVisibleError extends Error {
  constructor() {
    super("investigation not found");
    this.name = "InvestigationNotVisibleError";
  }
}

export class MemorySoftwareImpactStore implements SoftwareImpactStore {
  private readonly rows = new Map<string, SoftwareImpactRow>();

  capture(): unknown {
    return structuredClone([...this.rows.entries()]);
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as [string, SoftwareImpactRow][];
    this.rows.clear();
    for (const [id, value] of dump ?? []) this.rows.set(id, value);
  }

  async list(caseId: string): Promise<SoftwareImpactRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.caseId === caseId)
      .map((row) => ({ ...row }));
  }

  async listAll(): Promise<SoftwareImpactRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async get(id: string): Promise<SoftwareImpactRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findActiveIdentity(
    caseId: string,
    identity: SoftwareImpactIdentityV1,
  ): Promise<SoftwareImpactRow | null> {
    const key = softwareImpactIdentityKey(identity);
    for (const row of this.rows.values()) {
      if (row.caseId !== caseId || row.state !== "active") continue;
      if (softwareImpactIdentityKey(row) === key) return { ...row };
    }
    return null;
  }

  async insert(row: SoftwareImpactRow): Promise<void> {
    const existing = await this.findActiveIdentity(row.caseId, row);
    if (existing) throw new DuplicateSoftwareImpactError(existing.id);
    this.rows.set(row.id, { ...row });
  }

  async updateStatus(
    id: string,
    status: SoftwareImpactStatus,
    note: string,
    updatedAt: string,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new SoftwareImpactNotFoundError();
    if (row.state !== "active") throw new SoftwareImpactReleasedError();
    this.rows.set(id, { ...row, status, note, updatedAt });
  }

  async release(id: string, releasedAt: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new SoftwareImpactNotFoundError();
    if (row.state !== "active") throw new SoftwareImpactReleasedError();
    this.rows.set(id, { ...row, state: "released", releasedAt, updatedAt: releasedAt });
  }
}

function instant(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function fromPg(row: Record<string, unknown>): SoftwareImpactRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    productName: String(row.product_name),
    version: String(row.version),
    build: String(row.build),
    component: String(row.component),
    environment: String(row.environment),
    status: row.status as SoftwareImpactStatus,
    note: String(row.note),
    state: row.state as SoftwareImpactState,
    recordedAt: instant(row.recorded_at),
    recordedBy: String(row.recorded_by),
    recordedByUsername: String(row.recorded_by_username),
    updatedAt: instant(row.updated_at),
    releasedAt: nullableInstant(row.released_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

/** PostgreSQL implementation used by the hosted Linux/server deployment. */
export class PgSoftwareImpactStore implements SoftwareImpactStore {
  constructor(private readonly db: Queryable) {}

  async list(caseId: string): Promise<SoftwareImpactRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_software_impact
       WHERE case_id = $1 ORDER BY recorded_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => fromPg(row as Record<string, unknown>));
  }

  async listAll(): Promise<SoftwareImpactRow[]> {
    const result = await this.db.query(
      `SELECT * FROM investigation_software_impact
       ORDER BY recorded_at ASC, id ASC`,
    );
    return result.rows.map((row) => fromPg(row as Record<string, unknown>));
  }

  async get(id: string): Promise<SoftwareImpactRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_software_impact WHERE id = $1`,
      [id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? fromPg(row) : null;
  }

  async findActiveIdentity(
    caseId: string,
    identity: SoftwareImpactIdentityV1,
  ): Promise<SoftwareImpactRow | null> {
    const result = await this.db.query(
      `SELECT * FROM investigation_software_impact
       WHERE case_id = $1 AND state = 'active'
         AND lower(product_name) = lower($2)
         AND lower(version) = lower($3)
         AND lower(build) = lower($4)
         AND lower(component) = lower($5)
         AND lower(environment) = lower($6)
       LIMIT 1`,
      [
        caseId,
        identity.productName,
        identity.version,
        identity.build,
        identity.component,
        identity.environment,
      ],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? fromPg(row) : null;
  }

  async insert(row: SoftwareImpactRow): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO investigation_software_impact (
           id, case_id, product_name, version, build, component, environment,
           status, note, state, recorded_at, recorded_by, recorded_by_username,
           updated_at, released_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          row.id,
          row.caseId,
          row.productName,
          row.version,
          row.build,
          row.component,
          row.environment,
          row.status,
          row.note,
          row.state,
          row.recordedAt,
          row.recordedBy,
          row.recordedByUsername,
          row.updatedAt,
          row.releasedAt,
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findActiveIdentity(row.caseId, row);
      throw new DuplicateSoftwareImpactError(existing?.id ?? row.id);
    }
  }

  async updateStatus(
    id: string,
    status: SoftwareImpactStatus,
    note: string,
    updatedAt: string,
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE investigation_software_impact
       SET status = $2, note = $3, updated_at = $4
       WHERE id = $1 AND state = 'active'`,
      [id, status, note, updatedAt],
    );
    if (result.rowCount !== 0) return;
    const existing = await this.get(id);
    if (!existing) throw new SoftwareImpactNotFoundError();
    throw new SoftwareImpactReleasedError();
  }

  async release(id: string, releasedAt: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE investigation_software_impact
       SET state = 'released', released_at = $2, updated_at = $2
       WHERE id = $1 AND state = 'active'`,
      [id, releasedAt],
    );
    if (result.rowCount !== 0) return;
    const existing = await this.get(id);
    if (!existing) throw new SoftwareImpactNotFoundError();
    throw new SoftwareImpactReleasedError();
  }
}
