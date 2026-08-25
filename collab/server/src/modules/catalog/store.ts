import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_SCHEMA_ID,
  type SourceKind,
  type SourceLifecycle,
  type SourceV1,
} from "@cd-collab/contracts";

export interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  description: string | null;
  lifecycle: SourceLifecycle;
  identityId: string | null;
  createdAt: string;
  createdBy: string;
}

export interface CatalogStore {
  list(): Promise<SourceRow[]>;
  get(id: string): Promise<SourceRow | null>;
  findByIdentity(identityId: string): Promise<SourceRow | null>;
  insert(row: SourceRow): Promise<void>;
  updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void>;
  setLifecycle(id: string, lifecycle: SourceLifecycle): Promise<void>;
  /**
   * Returns the subset of `ids` that already key a row here. Host-owned and
   * batched: cost follows the probed id count, never the corpus size.
   */
  probeExistingIds(ids: readonly string[]): Promise<string[]>;
}

export type Queryable = Pick<Pool, "query">;

export function permanentUnknownSource(): SourceRow {
  return {
    id: PERMANENT_UNKNOWN_SOURCE_ID,
    name: "Unknown",
    kind: "unknown",
    description: "Permanent unknown source. Never auto-upgraded.",
    lifecycle: "active",
    identityId: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    createdBy: "system",
  };
}

export class MemoryCatalogStore implements CatalogStore {
  private readonly rows = new Map<string, SourceRow>();

  capture(): unknown {
    return structuredClone({ rows: [...this.rows.entries()] });
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as { rows: [string, SourceRow][] };
    this.rows.clear();
    for (const [id, value] of dump.rows) this.rows.set(id, value);
  }

  constructor() {
    const unknown = permanentUnknownSource();
    this.rows.set(unknown.id, unknown);
  }

  async list(): Promise<SourceRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async get(id: string): Promise<SourceRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByIdentity(identityId: string): Promise<SourceRow | null> {
    for (const row of this.rows.values()) {
      if (row.identityId === identityId) return { ...row };
    }
    return null;
  }

  async insert(row: SourceRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }

  async updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("source not found");
    row.name = patch.name;
    row.description = patch.description;
  }

  async probeExistingIds(ids: readonly string[]): Promise<string[]> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return [];
    return [...this.rows.keys()].filter((id) => wanted.has(id)).sort();
  }

  async setLifecycle(id: string, lifecycle: SourceLifecycle): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("source not found");
    row.lifecycle = lifecycle;
  }
}

export class PgCatalogStore implements CatalogStore {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<SourceRow[]> {
    const result = await this.db.query(`SELECT * FROM catalog_sources ORDER BY created_at ASC`);
    return result.rows.map((row) => asSource(row as Record<string, unknown>));
  }

  async get(id: string): Promise<SourceRow | null> {
    const result = await this.db.query(`SELECT * FROM catalog_sources WHERE id = $1`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asSource(row) : null;
  }

  async findByIdentity(identityId: string): Promise<SourceRow | null> {
    const result = await this.db.query(
      `SELECT * FROM catalog_sources WHERE identity_id = $1`,
      [identityId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asSource(row) : null;
  }

  async probeExistingIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query(
      `SELECT id FROM catalog_sources WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return result.rows.map((row) => String((row as Record<string, unknown>).id)).sort();
  }

  async insert(row: SourceRow): Promise<void> {
    await this.db.query(
      `INSERT INTO catalog_sources (
         id, name, kind, description, lifecycle, identity_id, created_at, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        row.name,
        row.kind,
        row.description,
        row.lifecycle,
        row.identityId,
        row.createdAt,
        row.createdBy,
      ],
    );
  }

  async updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void> {
    const result = await this.db.query(
      `UPDATE catalog_sources SET name = $2, description = $3 WHERE id = $1`,
      [id, patch.name, patch.description],
    );
    if (result.rowCount === 0) throw new Error("source not found");
  }

  async setLifecycle(id: string, lifecycle: SourceLifecycle): Promise<void> {
    const result = await this.db.query(
      `UPDATE catalog_sources SET lifecycle = $2 WHERE id = $1`,
      [id, lifecycle],
    );
    if (result.rowCount === 0) throw new Error("source not found");
  }
}

export function newSourceId(): string {
  return randomUUID();
}

export function toSourceV1(row: SourceRow): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    lifecycle: row.lifecycle,
    identityId: row.identityId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

function asSource(row: Record<string, unknown>): SourceRow {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as SourceKind,
    description:
      row.description === null || row.description === undefined ? null : String(row.description),
    lifecycle: row.lifecycle as SourceLifecycle,
    identityId:
      row.identity_id === null || row.identity_id === undefined ? null : String(row.identity_id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
  };
}
