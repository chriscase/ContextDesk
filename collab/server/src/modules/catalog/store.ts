import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_MUTATION_ACTIONS,
  SOURCE_SCHEMA_ID,
  type SourceKind,
  type SourceLifecycle,
  type SourceMutationAction,
  type SourceV1,
} from "@cd-collab/contracts";
import { MemoryAuditStore, PgAuditStore, type AuditStore } from "../audit/index.js";
import { activeCaseQueryable } from "../cases/index.js";

export interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  description: string | null;
  lifecycle: SourceLifecycle;
  identityId: string | null;
  createdAt: string;
  createdBy: string;
  /** Present on mutation-applied rows; absent on legacy catalog rows. */
  revision?: number;
}

export interface SourceCatalogSuccessIntent {
  actorId: string;
  idempotencyKey: string;
  action: SourceMutationAction;
  requestDigest: string;
  sourceId: string;
  successJson: string;
  createdAt: string;
}

export class CatalogIdentityBoundError extends Error {
  constructor(readonly current: SourceRow) {
    super("identity_already_bound");
    this.name = "CatalogIdentityBoundError";
  }
}

/**
 * PostgreSQL COMMIT was attempted and its outcome is unknown.
 *
 * Callers must not ROLLBACK, must not report success, and must not retry the
 * same write as if it definitely failed.
 */
export class CatalogCommitOutcomeUnknownError extends Error {
  constructor() {
    super("catalog transaction commit outcome is unknown");
    this.name = "CatalogCommitOutcomeUnknownError";
  }
}

export class CatalogMutationBoundaryError extends Error {
  constructor() {
    super("source catalog mutation requires an active catalog or case transaction");
    this.name = "CatalogMutationBoundaryError";
  }
}

export interface CatalogStore {
  list(): Promise<SourceRow[]>;
  get(id: string): Promise<SourceRow | null>;
  findByIdentity(identityId: string): Promise<SourceRow | null>;
  insert(row: SourceRow): Promise<void>;
  remove(id: string): Promise<void>;
  updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void>;
  setLifecycle(id: string, lifecycle: SourceLifecycle): Promise<void>;
  saveLifecycle(id: string, lifecycle: SourceLifecycle, revision: number): Promise<void>;
  /**
   * Returns the subset of `ids` that already key a row here. Host-owned and
   * batched: cost follows the probed id count, never the corpus size.
   */
  probeExistingIds(ids: readonly string[]): Promise<string[]>;
  lockActorIdempotency(actorId: string, idempotencyKey: string): Promise<void>;
  lockIdentity(identityId: string): Promise<void>;
  lockSource(id: string): Promise<SourceRow | null>;
  getSuccessIntent(actorId: string, idempotencyKey: string): Promise<SourceCatalogSuccessIntent | null>;
  insertSuccessIntent(row: SourceCatalogSuccessIntent): Promise<void>;
  withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T>;
}

export type Queryable = Pick<Pool, "query">;

type AtomicBoundary = <T>(operation: () => Promise<T>) => Promise<T>;

const catalogTx = new AsyncLocalStorage<Queryable>();

function serializedBoundary(): AtomicBoundary {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}

function cloneRow(row: SourceRow): SourceRow {
  return row.revision === undefined ? { ...row } : { ...row, revision: row.revision };
}

function cloneIntent(row: SourceCatalogSuccessIntent): SourceCatalogSuccessIntent {
  return { ...row };
}

function intentMapKey(actorId: string, idempotencyKey: string): string {
  return `${actorId}\0${idempotencyKey}`;
}

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

function assertClosedIntentAction(action: string): asserts action is SourceMutationAction {
  if (!(SOURCE_MUTATION_ACTIONS as readonly string[]).includes(action)) {
    throw new Error("source catalog success intent action is invalid");
  }
}

function assertUnversionedMutable(row: SourceRow): void {
  if (row.id === PERMANENT_UNKNOWN_SOURCE_ID) {
    throw new Error("permanent_unknown_protected");
  }
  if (row.revision !== undefined) {
    throw new Error("versioned_source");
  }
}

export class MemoryCatalogStore implements CatalogStore {
  private readonly rows = new Map<string, SourceRow>();
  private readonly intents = new Map<string, SourceCatalogSuccessIntent>();
  private readonly boundary: AtomicBoundary;

  capture(): unknown {
    return structuredClone({
      rows: [...this.rows.entries()],
      intents: [...this.intents.entries()],
    });
  }

  restore(snapshot: unknown): void {
    const dump = structuredClone(snapshot) as {
      rows: [string, SourceRow][];
      intents?: [string, SourceCatalogSuccessIntent][];
    };
    this.rows.clear();
    this.intents.clear();
    for (const [id, value] of dump.rows) this.rows.set(id, cloneRow(value));
    for (const [key, value] of dump.intents ?? []) this.intents.set(key, cloneIntent(value));
  }

  constructor(boundary: AtomicBoundary = serializedBoundary()) {
    this.boundary = boundary;
    const unknown = permanentUnknownSource();
    this.rows.set(unknown.id, unknown);
  }

  async list(): Promise<SourceRow[]> {
    return [...this.rows.values()].map(cloneRow);
  }

  async get(id: string): Promise<SourceRow | null> {
    const row = this.rows.get(id);
    return row ? cloneRow(row) : null;
  }

  async findByIdentity(identityId: string): Promise<SourceRow | null> {
    for (const row of this.rows.values()) {
      if (row.identityId === identityId) return cloneRow(row);
    }
    return null;
  }

  async insert(row: SourceRow): Promise<void> {
    if (row.identityId !== null) {
      const existing = await this.findByIdentity(row.identityId);
      if (existing && existing.id !== row.id) {
        throw new CatalogIdentityBoundError(existing);
      }
    }
    this.rows.set(row.id, cloneRow(row));
  }

  async remove(id: string): Promise<void> {
    if (id === PERMANENT_UNKNOWN_SOURCE_ID) return;
    this.rows.delete(id);
  }

  async updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("source not found");
    assertUnversionedMutable(row);
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
    assertUnversionedMutable(row);
    row.lifecycle = lifecycle;
  }

  async saveLifecycle(id: string, lifecycle: SourceLifecycle, revision: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error("source not found");
    if (row.id === PERMANENT_UNKNOWN_SOURCE_ID) {
      throw new Error("permanent_unknown_protected");
    }
    row.lifecycle = lifecycle;
    row.revision = revision;
  }

  async lockActorIdempotency(_actorId: string, _idempotencyKey: string): Promise<void> {
    // The serialized atomic boundary is the single-node lock.
  }

  async lockIdentity(_identityId: string): Promise<void> {
    // The serialized atomic boundary is the single-node lock.
  }

  async lockSource(id: string): Promise<SourceRow | null> {
    return this.get(id);
  }

  async getSuccessIntent(
    actorId: string,
    idempotencyKey: string,
  ): Promise<SourceCatalogSuccessIntent | null> {
    const row = this.intents.get(intentMapKey(actorId, idempotencyKey));
    return row ? cloneIntent(row) : null;
  }

  async insertSuccessIntent(row: SourceCatalogSuccessIntent): Promise<void> {
    const key = intentMapKey(row.actorId, row.idempotencyKey);
    if (this.intents.has(key)) {
      throw new Error("source catalog idempotency key already exists");
    }
    this.intents.set(key, cloneIntent(row));
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    return this.boundary(async () => {
      const snapshot = await Promise.resolve(this.capture());
      const run = async () => {
        try {
          return await operation();
        } catch (error) {
          await Promise.resolve(this.restore(snapshot));
          if (audit instanceof MemoryAuditStore) audit.rollbackTracked();
          throw error;
        }
      };
      return audit instanceof MemoryAuditStore ? audit.runTracked(run) : run();
    });
  }
}

export class PgCatalogStore implements CatalogStore {
  constructor(private readonly db: Queryable) {}

  private get queryable(): Queryable {
    return catalogTx.getStore() ?? activeCaseQueryable() ?? this.db;
  }

  private get mutationQueryable(): Queryable {
    const queryable = catalogTx.getStore() ?? activeCaseQueryable();
    if (!queryable) throw new CatalogMutationBoundaryError();
    return queryable;
  }

  async list(): Promise<SourceRow[]> {
    const result = await this.queryable.query(`SELECT * FROM catalog_sources ORDER BY created_at ASC`);
    return result.rows.map((row) => asSource(row as Record<string, unknown>));
  }

  async get(id: string): Promise<SourceRow | null> {
    const result = await this.queryable.query(`SELECT * FROM catalog_sources WHERE id = $1`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asSource(row) : null;
  }

  async findByIdentity(identityId: string): Promise<SourceRow | null> {
    const result = await this.queryable.query(
      `SELECT * FROM catalog_sources WHERE identity_id = $1`,
      [identityId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asSource(row) : null;
  }

  async probeExistingIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const result = await this.queryable.query(
      `SELECT id FROM catalog_sources WHERE id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return result.rows.map((row) => String((row as Record<string, unknown>).id)).sort();
  }

  async insert(row: SourceRow): Promise<void> {
    if (row.identityId === null) {
      await this.queryable.query(
        `INSERT INTO catalog_sources (
           id, name, kind, description, lifecycle, identity_id, created_at, created_by, revision
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id,
          row.name,
          row.kind,
          row.description,
          row.lifecycle,
          row.identityId,
          row.createdAt,
          row.createdBy,
          row.revision ?? null,
        ],
      );
      return;
    }
    const inserted = await this.queryable.query(
      `INSERT INTO catalog_sources (
         id, name, kind, description, lifecycle, identity_id, created_at, created_by, revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (identity_id) WHERE identity_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        row.id,
        row.name,
        row.kind,
        row.description,
        row.lifecycle,
        row.identityId,
        row.createdAt,
        row.createdBy,
        row.revision ?? null,
      ],
    );
    if ((inserted.rowCount ?? inserted.rows.length) > 0) return;
    const inTx = catalogTx.getStore() ?? activeCaseQueryable();
    const current = inTx
      ? await this.lockIdentityRow(row.identityId)
      : await this.findByIdentity(row.identityId);
    if (current) throw new CatalogIdentityBoundError(current);
    throw new Error("identity insert conflict without bound source");
  }

  async remove(id: string): Promise<void> {
    if (id === PERMANENT_UNKNOWN_SOURCE_ID) return;
    await this.queryable.query(
      `DELETE FROM catalog_sources WHERE id = $1 AND id <> $2`,
      [id, PERMANENT_UNKNOWN_SOURCE_ID],
    );
  }

  async updateMeta(id: string, patch: { name: string; description: string | null }): Promise<void> {
    const result = await this.queryable.query(
      `UPDATE catalog_sources SET name = $2, description = $3
       WHERE id = $1 AND revision IS NULL AND id <> $4`,
      [id, patch.name, patch.description, PERMANENT_UNKNOWN_SOURCE_ID],
    );
    if (result.rowCount === 0) {
      throw await this.legacyMutationRefusal(id);
    }
  }

  async setLifecycle(id: string, lifecycle: SourceLifecycle): Promise<void> {
    const result = await this.queryable.query(
      `UPDATE catalog_sources SET lifecycle = $2
       WHERE id = $1 AND revision IS NULL AND id <> $3`,
      [id, lifecycle, PERMANENT_UNKNOWN_SOURCE_ID],
    );
    if (result.rowCount === 0) {
      throw await this.legacyMutationRefusal(id);
    }
  }

  async saveLifecycle(id: string, lifecycle: SourceLifecycle, revision: number): Promise<void> {
    const result = await this.mutationQueryable.query(
      `UPDATE catalog_sources SET lifecycle = $2, revision = $3 WHERE id = $1 AND id <> $4`,
      [id, lifecycle, revision, PERMANENT_UNKNOWN_SOURCE_ID],
    );
    if (result.rowCount === 0) {
      const existing = await this.get(id);
      if (!existing) throw new Error("source not found");
      if (existing.id === PERMANENT_UNKNOWN_SOURCE_ID) {
        throw new Error("permanent_unknown_protected");
      }
      throw new Error("source not found");
    }
  }

  async lockActorIdempotency(actorId: string, idempotencyKey: string): Promise<void> {
    await this.mutationQueryable.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `catalog:intent:${actorId}:${idempotencyKey}`,
    ]);
  }

  async lockIdentity(identityId: string): Promise<void> {
    await this.mutationQueryable.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `catalog:identity:${identityId}`,
    ]);
  }

  async lockSource(id: string): Promise<SourceRow | null> {
    const locked = await this.mutationQueryable.query(
      `SELECT id FROM catalog_sources WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (locked.rowCount === 0) return null;
    return this.get(id);
  }

  async getSuccessIntent(
    actorId: string,
    idempotencyKey: string,
  ): Promise<SourceCatalogSuccessIntent | null> {
    const result = await this.queryable.query(
      `SELECT actor_id, idempotency_key, action, request_digest, source_id, success_json, created_at
       FROM source_catalog_success_intents
       WHERE actor_id = $1 AND idempotency_key = $2`,
      [actorId, idempotencyKey],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? asIntent(row) : null;
  }

  async insertSuccessIntent(row: SourceCatalogSuccessIntent): Promise<void> {
    await this.mutationQueryable.query(
      `INSERT INTO source_catalog_success_intents (
         actor_id, idempotency_key, action, request_digest, source_id, success_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.actorId,
        row.idempotencyKey,
        row.action,
        row.requestDigest,
        row.sourceId,
        row.successJson,
        row.createdAt,
      ],
    );
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    const existing = catalogTx.getStore() ?? activeCaseQueryable();
    if (existing) {
      this.assertSharedAudit(audit, existing);
      const run = () =>
        audit instanceof PgAuditStore ? audit.withTransaction(existing, operation) : operation();
      if (catalogTx.getStore()) return run();
      return catalogTx.run(existing, run);
    }
    if (this.db instanceof Pool) {
      return this.withPooledTransaction(this.db, operation, audit);
    }
    return this.withQueryableTransaction(this.db, operation, audit);
  }

  private async lockIdentityRow(identityId: string): Promise<SourceRow | null> {
    const locked = await this.mutationQueryable.query(
      `SELECT id FROM catalog_sources WHERE identity_id = $1 FOR UPDATE`,
      [identityId],
    );
    const id = locked.rows[0] ? String((locked.rows[0] as Record<string, unknown>).id) : null;
    if (!id) return this.findByIdentity(identityId);
    return this.get(id);
  }

  private async legacyMutationRefusal(id: string): Promise<Error> {
    const existing = await this.get(id);
    if (!existing) return new Error("source not found");
    if (existing.id === PERMANENT_UNKNOWN_SOURCE_ID) {
      return new Error("permanent_unknown_protected");
    }
    if (existing.revision !== undefined) return new Error("versioned_source");
    return new Error("source not found");
  }

  private assertSharedAudit(audit: AuditStore | undefined, queryable: Queryable): void {
    if (!audit) return;
    if (!(audit instanceof PgAuditStore)) {
      throw new Error("PostgreSQL catalog and audit stores must share one connection source");
    }
    if (this.db instanceof Pool) {
      if (!audit.isBoundTo(this.db)) {
        throw new Error("PostgreSQL catalog and audit stores must share one pool");
      }
      return;
    }
    if (!audit.isBoundTo(this.db) && !audit.isBoundTo(queryable)) {
      throw new Error("PostgreSQL catalog and audit stores must share one connection source");
    }
  }

  private async withPooledTransaction<T>(
    pool: Pool,
    operation: () => Promise<T>,
    audit?: AuditStore,
  ): Promise<T> {
    this.assertSharedAudit(audit, pool);
    const client = await pool.connect();
    let transactionStarted = false;
    let commitAttempted = false;
    let released = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const result = await catalogTx.run(client, () =>
        audit instanceof PgAuditStore ? audit.withTransaction(client, operation) : operation(),
      );
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted) {
        try {
          client.release(new Error("catalog commit outcome is unknown"));
        } catch {
          // The connection is already unsafe; keep the unknown COMMIT outcome.
        }
        released = true;
        throw new CatalogCommitOutcomeUnknownError();
      }
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          client.release(new Error("catalog rollback failed"));
          released = true;
        }
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  private async withQueryableTransaction<T>(
    queryable: Queryable,
    operation: () => Promise<T>,
    audit?: AuditStore,
  ): Promise<T> {
    this.assertSharedAudit(audit, queryable);
    let transactionStarted = false;
    let commitAttempted = false;
    try {
      await queryable.query("BEGIN");
      transactionStarted = true;
      const result = await catalogTx.run(queryable, () =>
        audit instanceof PgAuditStore ? audit.withTransaction(queryable, operation) : operation(),
      );
      commitAttempted = true;
      await queryable.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted) {
        throw new CatalogCommitOutcomeUnknownError();
      }
      if (transactionStarted) {
        try {
          await queryable.query("ROLLBACK");
        } catch {
          // Preserve the mutation failure; the queryable is caller-owned.
        }
      }
      throw error;
    }
  }
}

export function newSourceId(): string {
  return randomUUID();
}

export function toSourceV1(row: SourceRow): SourceV1 {
  const source: SourceV1 = {
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
  if (row.revision !== undefined) source.revision = row.revision;
  return source;
}

function asSource(row: Record<string, unknown>): SourceRow {
  const source: SourceRow = {
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
  const revision = optionalRevisionFromDb(row.revision);
  if (revision !== undefined) source.revision = revision;
  return source;
}

function asIntent(row: Record<string, unknown>): SourceCatalogSuccessIntent {
  const action = String(row.action);
  assertClosedIntentAction(action);
  return {
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    action,
    requestDigest: String(row.request_digest),
    sourceId: String(row.source_id),
    successJson: String(row.success_json),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function optionalRevisionFromDb(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid catalog source revision");
  }
  return revision;
}
