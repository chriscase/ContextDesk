/**
 * Durable investigation-scoped Log workbench records.
 *
 * Search and chronology are computed over intake bytes; these tables own the
 * saved views, bookmarks, and share-safe locator tokens the host cannot
 * persist for a War Room investigation.
 */
import type { Pool, PoolClient } from "pg";
import type { PrivacyClass } from "@cd-collab/contracts";

export interface WorkbenchViewRow {
  id: string;
  caseId: string;
  name: string;
  payloadJson: string;
  idempotencyKey: string;
  requestDigest: string;
  privacyClass: PrivacyClass;
  createdAt: string;
  createdBy: string;
}

export interface WorkbenchBookmarkRow {
  id: string;
  caseId: string;
  evidenceId: string;
  payloadJson: string;
  shareSafeToken: string;
  idempotencyKey: string;
  requestDigest: string;
  privacyClass: PrivacyClass;
  createdAt: string;
  createdBy: string;
}

export interface WorkbenchStore {
  listViews(caseId: string): Promise<WorkbenchViewRow[]>;
  getViewByIdempotency(caseId: string, idempotencyKey: string): Promise<WorkbenchViewRow | null>;
  insertView(row: WorkbenchViewRow): Promise<void>;
  listBookmarks(caseId: string): Promise<WorkbenchBookmarkRow[]>;
  getBookmarkByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<WorkbenchBookmarkRow | null>;
  getBookmarkByToken(token: string): Promise<WorkbenchBookmarkRow | null>;
  insertBookmark(row: WorkbenchBookmarkRow): Promise<void>;
  withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T>;
}

export class MemoryWorkbenchStore implements WorkbenchStore {
  private views: WorkbenchViewRow[] = [];
  private bookmarks: WorkbenchBookmarkRow[] = [];
  private locks = new Map<string, Promise<unknown>>();
  failNextWrite: Error | null = null;

  async listViews(caseId: string): Promise<WorkbenchViewRow[]> {
    return this.views.filter((row) => row.caseId === caseId).map((row) => ({ ...row }));
  }

  async getViewByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<WorkbenchViewRow | null> {
    return this.views.find(
      (row) => row.caseId === caseId && row.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async insertView(row: WorkbenchViewRow): Promise<void> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    if (this.views.some((item) => item.id === row.id)) {
      throw new Error("workbench view already exists");
    }
    this.views.push({ ...row });
  }

  async listBookmarks(caseId: string): Promise<WorkbenchBookmarkRow[]> {
    return this.bookmarks.filter((row) => row.caseId === caseId).map((row) => ({ ...row }));
  }

  async getBookmarkByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<WorkbenchBookmarkRow | null> {
    return this.bookmarks.find(
      (row) => row.caseId === caseId && row.idempotencyKey === idempotencyKey,
    ) ?? null;
  }

  async getBookmarkByToken(token: string): Promise<WorkbenchBookmarkRow | null> {
    return this.bookmarks.find((row) => row.shareSafeToken === token) ?? null;
  }

  async insertBookmark(row: WorkbenchBookmarkRow): Promise<void> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }
    if (this.bookmarks.some((item) => item.id === row.id || item.shareSafeToken === row.shareSafeToken)) {
      throw new Error("workbench bookmark already exists");
    }
    this.bookmarks.push({ ...row });
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

type Queryable = Pool | PoolClient;

function viewRow(row: Record<string, unknown>): WorkbenchViewRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    name: String(row.name),
    payloadJson: String(row.payload_json),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    privacyClass: row.privacy_class as PrivacyClass,
    createdAt: new Date(row.created_at as string).toISOString(),
    createdBy: String(row.created_by),
  };
}

function bookmarkRow(row: Record<string, unknown>): WorkbenchBookmarkRow {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    evidenceId: String(row.evidence_id),
    payloadJson: String(row.payload_json),
    shareSafeToken: String(row.share_safe_token),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    privacyClass: row.privacy_class as PrivacyClass,
    createdAt: new Date(row.created_at as string).toISOString(),
    createdBy: String(row.created_by),
  };
}

export class PgWorkbenchStore implements WorkbenchStore {
  constructor(private readonly db: Queryable) {}

  async listViews(caseId: string): Promise<WorkbenchViewRow[]> {
    const result = await this.db.query(
      `SELECT id, case_id, name, payload_json, idempotency_key, request_digest,
              privacy_class, created_at, created_by
         FROM log_workbench_views WHERE case_id = $1
         ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => viewRow(row as Record<string, unknown>));
  }

  async getViewByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<WorkbenchViewRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, name, payload_json, idempotency_key, request_digest,
              privacy_class, created_at, created_by
         FROM log_workbench_views WHERE case_id = $1 AND idempotency_key = $2`,
      [caseId, idempotencyKey],
    );
    return result.rows[0] ? viewRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async insertView(row: WorkbenchViewRow): Promise<void> {
    await this.db.query(
      `INSERT INTO log_workbench_views
         (id, case_id, name, payload_json, idempotency_key, request_digest,
          privacy_class, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id,
        row.caseId,
        row.name,
        row.payloadJson,
        row.idempotencyKey,
        row.requestDigest,
        row.privacyClass,
        row.createdAt,
        row.createdBy,
      ],
    );
  }

  async listBookmarks(caseId: string): Promise<WorkbenchBookmarkRow[]> {
    const result = await this.db.query(
      `SELECT id, case_id, evidence_id, payload_json, share_safe_token,
              idempotency_key, request_digest, privacy_class, created_at, created_by
         FROM log_workbench_bookmarks WHERE case_id = $1
         ORDER BY created_at ASC, id ASC`,
      [caseId],
    );
    return result.rows.map((row) => bookmarkRow(row as Record<string, unknown>));
  }

  async getBookmarkByIdempotency(
    caseId: string,
    idempotencyKey: string,
  ): Promise<WorkbenchBookmarkRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, evidence_id, payload_json, share_safe_token,
              idempotency_key, request_digest, privacy_class, created_at, created_by
         FROM log_workbench_bookmarks WHERE case_id = $1 AND idempotency_key = $2`,
      [caseId, idempotencyKey],
    );
    return result.rows[0] ? bookmarkRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async getBookmarkByToken(token: string): Promise<WorkbenchBookmarkRow | null> {
    const result = await this.db.query(
      `SELECT id, case_id, evidence_id, payload_json, share_safe_token,
              idempotency_key, request_digest, privacy_class, created_at, created_by
         FROM log_workbench_bookmarks WHERE share_safe_token = $1`,
      [token],
    );
    return result.rows[0] ? bookmarkRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async insertBookmark(row: WorkbenchBookmarkRow): Promise<void> {
    await this.db.query(
      `INSERT INTO log_workbench_bookmarks
         (id, case_id, evidence_id, payload_json, share_safe_token, idempotency_key,
          request_digest, privacy_class, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id,
        row.caseId,
        row.evidenceId,
        row.payloadJson,
        row.shareSafeToken,
        row.idempotencyKey,
        row.requestDigest,
        row.privacyClass,
        row.createdAt,
        row.createdBy,
      ],
    );
  }

  async withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    await this.db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `workbench:${caseId}`,
    ]);
    return operation();
  }
}
