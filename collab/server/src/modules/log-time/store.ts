/**
 * Durable state for case-bound log corpora and their time declarations.
 *
 * Three things are persisted here that the host corpus cannot answer on its
 * own: which corpus belongs to which case, who declared each zone against
 * which preview fingerprint, and what each time change did to work that had
 * already been produced. Dependent dispositions are written once, at the moment
 * of the change, so the War Room reports what was true then rather than
 * re-deriving a guess later.
 */
import type { Pool, PoolClient } from "pg";
import type {
  LogTimeDependentDisposition,
  LogTimeDependentKind,
  LogTimeOperation,
} from "@cd-collab/contracts";

export interface LogCorpusRow {
  caseId: string;
  corpusId: string;
  corpusName: string;
  privacyClass: "owner_only" | "share_safe";
  corpusRevision: number;
  /** Revision whose content a one-step undo would restore, or null. */
  undoableRevision: number | null;
  builtAt: string;
  builtBy: string;
}

export interface LogTimeDeclarationRow {
  caseId: string;
  source: string;
  ianaTimezone: string;
  basis: "user_declared" | "configured_default";
  declaredAt: number;
  appliedRevision: number;
  declarationFingerprint: string;
  declaredBy: string;
}

export interface LogTimeDependentRow {
  caseId: string;
  operationId: string;
  kind: LogTimeDependentKind;
  dependentId: string;
  disposition: LogTimeDependentDisposition;
  reason: string;
  observedRevision: number | null;
}

export interface LogTimeOperationRow {
  id: string;
  caseId: string;
  operation: LogTimeOperation;
  source: string | null;
  previousRevision: number;
  appliedRevision: number;
  restoredRevision: number | null;
  changedRecords: number;
  idempotencyKey: string;
  requestDigest: string;
  createdAt: string;
  createdBy: string;
}

export interface LogTimeStore {
  getCorpus(caseId: string): Promise<LogCorpusRow | null>;
  insertCorpus(row: LogCorpusRow): Promise<void>;
  updateCorpusRevision(
    caseId: string,
    corpusRevision: number,
    undoableRevision: number | null,
  ): Promise<void>;

  listDeclarations(caseId: string): Promise<LogTimeDeclarationRow[]>;
  putDeclaration(row: LogTimeDeclarationRow): Promise<void>;
  deleteDeclaration(caseId: string, source: string): Promise<void>;
  replaceDeclarations(caseId: string, rows: LogTimeDeclarationRow[]): Promise<void>;

  getOperationByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<LogTimeOperationRow | null>;
  insertOperation(row: LogTimeOperationRow): Promise<void>;
  insertDependents(rows: LogTimeDependentRow[]): Promise<void>;
  listDependents(caseId: string, operationId: string): Promise<LogTimeDependentRow[]>;
  /** Latest recorded disposition per dependent, for the review surface. */
  listLatestDependents(caseId: string): Promise<LogTimeDependentRow[]>;

  /** Serialize concurrent review operations on one case. */
  withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** Process-local store used by tests and the single-process demo host. */
export class MemoryLogTimeStore implements LogTimeStore {
  private corpora = new Map<string, LogCorpusRow>();
  private declarations = new Map<string, LogTimeDeclarationRow[]>();
  private operations: LogTimeOperationRow[] = [];
  private dependents: LogTimeDependentRow[] = [];
  private locks = new Map<string, Promise<unknown>>();

  async getCorpus(caseId: string): Promise<LogCorpusRow | null> {
    return this.corpora.get(caseId) ?? null;
  }

  async insertCorpus(row: LogCorpusRow): Promise<void> {
    if (this.corpora.has(row.caseId)) {
      throw new Error("case already has a log corpus");
    }
    this.corpora.set(row.caseId, { ...row });
  }

  async updateCorpusRevision(
    caseId: string,
    corpusRevision: number,
    undoableRevision: number | null,
  ): Promise<void> {
    const row = this.corpora.get(caseId);
    if (!row) throw new Error("case has no log corpus");
    this.corpora.set(caseId, { ...row, corpusRevision, undoableRevision });
  }

  async listDeclarations(caseId: string): Promise<LogTimeDeclarationRow[]> {
    return [...(this.declarations.get(caseId) ?? [])].map((row) => ({ ...row }));
  }

  async putDeclaration(row: LogTimeDeclarationRow): Promise<void> {
    const existing = this.declarations.get(row.caseId) ?? [];
    this.declarations.set(row.caseId, [
      ...existing.filter((item) => item.source !== row.source),
      { ...row },
    ]);
  }

  async deleteDeclaration(caseId: string, source: string): Promise<void> {
    const existing = this.declarations.get(caseId) ?? [];
    this.declarations.set(
      caseId,
      existing.filter((item) => item.source !== source),
    );
  }

  async replaceDeclarations(
    caseId: string,
    rows: LogTimeDeclarationRow[],
  ): Promise<void> {
    this.declarations.set(caseId, rows.map((row) => ({ ...row })));
  }

  async getOperationByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<LogTimeOperationRow | null> {
    return (
      this.operations.find(
        (row) => row.caseId === caseId && row.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async insertOperation(row: LogTimeOperationRow): Promise<void> {
    this.operations.push({ ...row });
  }

  async insertDependents(rows: LogTimeDependentRow[]): Promise<void> {
    for (const row of rows) this.dependents.push({ ...row });
  }

  async listDependents(
    caseId: string,
    operationId: string,
  ): Promise<LogTimeDependentRow[]> {
    return this.dependents
      .filter((row) => row.caseId === caseId && row.operationId === operationId)
      .map((row) => ({ ...row }));
  }

  async listLatestDependents(caseId: string): Promise<LogTimeDependentRow[]> {
    const latest = new Map<string, LogTimeDependentRow>();
    for (const row of this.dependents) {
      if (row.caseId !== caseId) continue;
      latest.set(`${row.kind}:${row.dependentId}`, { ...row });
    }
    return [...latest.values()];
  }

  async withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(caseId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.locks.set(
      caseId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

type Queryable = Pool | PoolClient;

function corpusRow(row: Record<string, unknown>): LogCorpusRow {
  return {
    caseId: String(row.case_id),
    corpusId: String(row.corpus_id),
    corpusName: String(row.corpus_name),
    privacyClass: row.privacy_class as "owner_only" | "share_safe",
    corpusRevision: Number(row.corpus_revision),
    undoableRevision:
      row.undoable_revision === null ? null : Number(row.undoable_revision),
    builtAt: new Date(row.built_at as string).toISOString(),
    builtBy: String(row.built_by),
  };
}

function declarationRow(row: Record<string, unknown>): LogTimeDeclarationRow {
  return {
    caseId: String(row.case_id),
    source: String(row.source),
    ianaTimezone: String(row.iana_timezone),
    basis: row.basis as "user_declared" | "configured_default",
    declaredAt: Number(row.declared_at),
    appliedRevision: Number(row.applied_revision),
    declarationFingerprint: String(row.declaration_fingerprint),
    declaredBy: String(row.declared_by),
  };
}

function dependentRow(row: Record<string, unknown>): LogTimeDependentRow {
  return {
    caseId: String(row.case_id),
    operationId: String(row.operation_id),
    kind: row.kind as LogTimeDependentKind,
    dependentId: String(row.dependent_id),
    disposition: row.disposition as LogTimeDependentDisposition,
    reason: String(row.reason),
    observedRevision:
      row.observed_revision === null ? null : Number(row.observed_revision),
  };
}

export class PgLogTimeStore implements LogTimeStore {
  constructor(private readonly db: Queryable) {}

  async getCorpus(caseId: string): Promise<LogCorpusRow | null> {
    const result = await this.db.query(
      `SELECT case_id, corpus_id, corpus_name, privacy_class, corpus_revision,
              undoable_revision, built_at, built_by
         FROM log_corpora WHERE case_id = $1`,
      [caseId],
    );
    return result.rows[0] ? corpusRow(result.rows[0]) : null;
  }

  async insertCorpus(row: LogCorpusRow): Promise<void> {
    await this.db.query(
      `INSERT INTO log_corpora
         (case_id, corpus_id, corpus_name, privacy_class, corpus_revision,
          undoable_revision, built_at, built_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.caseId,
        row.corpusId,
        row.corpusName,
        row.privacyClass,
        row.corpusRevision,
        row.undoableRevision,
        row.builtAt,
        row.builtBy,
      ],
    );
  }

  async updateCorpusRevision(
    caseId: string,
    corpusRevision: number,
    undoableRevision: number | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE log_corpora
          SET corpus_revision = $2, undoable_revision = $3
        WHERE case_id = $1`,
      [caseId, corpusRevision, undoableRevision],
    );
  }

  async listDeclarations(caseId: string): Promise<LogTimeDeclarationRow[]> {
    const result = await this.db.query(
      `SELECT case_id, source, iana_timezone, basis, declared_at,
              applied_revision, declaration_fingerprint, declared_by
         FROM log_time_declarations WHERE case_id = $1 ORDER BY source`,
      [caseId],
    );
    return result.rows.map(declarationRow);
  }

  async putDeclaration(row: LogTimeDeclarationRow): Promise<void> {
    await this.db.query(
      `INSERT INTO log_time_declarations
         (case_id, source, iana_timezone, basis, declared_at, applied_revision,
          declaration_fingerprint, declared_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (case_id, source) DO UPDATE SET
         iana_timezone = EXCLUDED.iana_timezone,
         basis = EXCLUDED.basis,
         declared_at = EXCLUDED.declared_at,
         applied_revision = EXCLUDED.applied_revision,
         declaration_fingerprint = EXCLUDED.declaration_fingerprint,
         declared_by = EXCLUDED.declared_by`,
      [
        row.caseId,
        row.source,
        row.ianaTimezone,
        row.basis,
        row.declaredAt,
        row.appliedRevision,
        row.declarationFingerprint,
        row.declaredBy,
      ],
    );
  }

  async deleteDeclaration(caseId: string, source: string): Promise<void> {
    await this.db.query(
      `DELETE FROM log_time_declarations WHERE case_id = $1 AND source = $2`,
      [caseId, source],
    );
  }

  async replaceDeclarations(
    caseId: string,
    rows: LogTimeDeclarationRow[],
  ): Promise<void> {
    await this.db.query(`DELETE FROM log_time_declarations WHERE case_id = $1`, [
      caseId,
    ]);
    for (const row of rows) await this.putDeclaration(row);
  }

  async getOperationByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<LogTimeOperationRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, operation, source, previous_revision, applied_revision,
              restored_revision, changed_records, idempotency_key, request_digest,
              created_at, created_by
         FROM log_time_operations
        WHERE case_id = $1 AND idempotency_key = $2`,
      [caseId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      caseId: String(row.case_id),
      operation: row.operation as LogTimeOperation,
      source: row.source === null ? null : String(row.source),
      previousRevision: Number(row.previous_revision),
      appliedRevision: Number(row.applied_revision),
      restoredRevision:
        row.restored_revision === null ? null : Number(row.restored_revision),
      changedRecords: Number(row.changed_records),
      idempotencyKey: String(row.idempotency_key),
      requestDigest: String(row.request_digest),
      createdAt: new Date(row.created_at as string).toISOString(),
      createdBy: String(row.created_by),
    };
  }

  async insertOperation(row: LogTimeOperationRow): Promise<void> {
    await this.db.query(
      `INSERT INTO log_time_operations
         (id, case_id, operation, source, previous_revision, applied_revision,
          restored_revision, changed_records, idempotency_key, request_digest,
          created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.id,
        row.caseId,
        row.operation,
        row.source,
        row.previousRevision,
        row.appliedRevision,
        row.restoredRevision,
        row.changedRecords,
        row.idempotencyKey,
        row.requestDigest,
        row.createdAt,
        row.createdBy,
      ],
    );
  }

  async insertDependents(rows: LogTimeDependentRow[]): Promise<void> {
    for (const row of rows) {
      await this.db.query(
        `INSERT INTO log_time_dependents
           (case_id, operation_id, kind, dependent_id, disposition, reason,
            observed_revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.caseId,
          row.operationId,
          row.kind,
          row.dependentId,
          row.disposition,
          row.reason,
          row.observedRevision,
        ],
      );
    }
  }

  async listDependents(
    caseId: string,
    operationId: string,
  ): Promise<LogTimeDependentRow[]> {
    const result = await this.db.query(
      `SELECT case_id, operation_id, kind, dependent_id, disposition, reason,
              observed_revision
         FROM log_time_dependents
        WHERE case_id = $1 AND operation_id = $2
        ORDER BY kind, dependent_id`,
      [caseId, operationId],
    );
    return result.rows.map(dependentRow);
  }

  async listLatestDependents(caseId: string): Promise<LogTimeDependentRow[]> {
    const result = await this.db.query(
      `SELECT DISTINCT ON (d.kind, d.dependent_id)
              d.case_id, d.operation_id, d.kind, d.dependent_id, d.disposition,
              d.reason, d.observed_revision
         FROM log_time_dependents d
         JOIN log_time_operations o ON o.id = d.operation_id
        WHERE d.case_id = $1
        ORDER BY d.kind, d.dependent_id, o.applied_revision DESC, o.created_at DESC`,
      [caseId],
    );
    return result.rows.map(dependentRow);
  }

  async withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    // Advisory lock keyed by case so two reviewers cannot publish overlapping
    // revisions. The host also fails closed on a stale revision; this keeps the
    // durable record from interleaving in the first place.
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `log_time:${caseId}`,
    ]);
    return operation();
  }
}
