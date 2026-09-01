import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import {
  UI_STRATEGY_IDS,
  parseUiStrategyGovernancePolicy,
  type UiStrategyGovernancePolicyV1,
  type UiStrategyId,
} from "@cd-collab/contracts";
import { MemoryAuditStore, PgAuditStore, type AuditStore } from "../audit/index.js";

export interface UiStrategyPreferenceRecord {
  userId: string;
  strategyId: UiStrategyId;
  revision: number;
  updatedAt: string;
}

function parsePreferenceRecord(raw: unknown): UiStrategyPreferenceRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("strategy preference record must be an object");
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["revision", "strategyId", "updatedAt", "userId"].join("\0")) {
    throw new Error("strategy preference record fields are invalid");
  }
  if (typeof value.userId !== "string" || value.userId.trim().length === 0) {
    throw new Error("strategy preference userId must be non-empty");
  }
  if (typeof value.strategyId !== "string" || !UI_STRATEGY_IDS.includes(value.strategyId as UiStrategyId)) {
    throw new Error("strategy preference strategyId is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) {
    throw new Error("strategy preference revision must be a positive safe integer");
  }
  if (
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) {
    throw new Error("strategy preference updatedAt must be a canonical ISO timestamp");
  }
  return {
    userId: value.userId,
    strategyId: value.strategyId as UiStrategyId,
    revision: value.revision as number,
    updatedAt: value.updatedAt,
  };
}

export interface StrategyGovernanceStore {
  loadPolicy(): Promise<UiStrategyGovernancePolicyV1 | null>;
  loadPreference(userId: string): Promise<UiStrategyPreferenceRecord | null>;
  savePolicy(policy: UiStrategyGovernancePolicyV1, expectedRevision: number): Promise<boolean>;
  savePreference(record: UiStrategyPreferenceRecord, expectedRevision: number): Promise<boolean>;
  lockPolicy(): Promise<void>;
  withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T>;
}

type AtomicBoundary = <T>(operation: () => Promise<T>) => Promise<T>;

function serializedBoundary(): AtomicBoundary {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}

export class MemoryStrategyGovernanceStore implements StrategyGovernanceStore {
  private policy: UiStrategyGovernancePolicyV1 | null = null;
  private readonly preferences = new Map<string, UiStrategyPreferenceRecord>();
  private readonly boundary: AtomicBoundary;

  constructor(boundary: AtomicBoundary = serializedBoundary()) {
    this.boundary = boundary;
  }

  capture(): unknown {
    return structuredClone({ policy: this.policy, preferences: [...this.preferences.entries()] });
  }

  restore(snapshot: unknown): void {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new Error("strategy governance snapshot must be an object");
    }
    const candidate = structuredClone(snapshot) as Record<string, unknown>;
    if (candidate.policy !== null && candidate.policy === undefined) {
      throw new Error("strategy governance snapshot must include policy");
    }
    if (!Array.isArray(candidate.preferences)) {
      throw new Error("strategy governance snapshot preferences must be an array");
    }
    const policy = candidate.policy === null ? null : parseUiStrategyGovernancePolicy(candidate.policy);
    const preferences = new Map<string, UiStrategyPreferenceRecord>();
    for (const entry of candidate.preferences) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error("strategy governance snapshot preference entry is invalid");
      }
      const preference = parsePreferenceRecord(entry[1]);
      if (entry[0] !== preference.userId) throw new Error("strategy preference key must match userId");
      if (preferences.has(entry[0])) throw new Error("strategy preference userId is duplicated");
      preferences.set(entry[0], preference);
    }
    this.policy = policy;
    this.preferences.clear();
    for (const [id, preference] of preferences) this.preferences.set(id, preference);
  }

  async loadPolicy(): Promise<UiStrategyGovernancePolicyV1 | null> {
    // SQLite rehydrates the in-memory mirror through its generic state
    // adapter. Re-parse on every publication so a corrupted or drifted JSON
    // document can never bypass the policy fingerprint and rule invariants.
    return this.policy ? parseUiStrategyGovernancePolicy(structuredClone(this.policy)) : null;
  }

  async loadPreference(userId: string): Promise<UiStrategyPreferenceRecord | null> {
    const row = this.preferences.get(userId);
    return row ? parsePreferenceRecord(structuredClone(row)) : null;
  }

  async savePolicy(policy: UiStrategyGovernancePolicyV1, expectedRevision: number): Promise<boolean> {
    const currentRevision = this.policy?.revision ?? 0;
    if (currentRevision !== expectedRevision) return false;
    this.policy = parseUiStrategyGovernancePolicy(policy);
    return true;
  }

  async savePreference(record: UiStrategyPreferenceRecord, expectedRevision: number): Promise<boolean> {
    const parsed = parsePreferenceRecord(record);
    const currentRevision = this.preferences.get(parsed.userId)?.revision ?? 0;
    if (currentRevision !== expectedRevision) return false;
    this.preferences.set(parsed.userId, structuredClone(parsed));
    return true;
  }

  async lockPolicy(): Promise<void> {
    // The serialized atomic boundary is the single-node lock.
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    return this.boundary(async () => {
      // SQLite wraps every store method in an async persistence adapter. Keep
      // this boundary correct for both that adapter and the plain in-memory
      // store instead of accidentally snapshotting a Promise on rollback.
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

type Queryable = Pick<Pool, "query">;
const pgStrategyTx = new AsyncLocalStorage<Queryable>();

export class StrategyGovernanceCommitOutcomeUnknownError extends Error {
  constructor() {
    super("strategy-governance transaction commit outcome is unknown");
    this.name = "StrategyGovernanceCommitOutcomeUnknownError";
  }
}

export class PgStrategyGovernanceStore implements StrategyGovernanceStore {
  constructor(private readonly pool: Pool) {}

  private get db(): Queryable {
    return pgStrategyTx.getStore() ?? this.pool;
  }

  async loadPolicy(): Promise<UiStrategyGovernancePolicyV1 | null> {
    const result = await this.db.query("SELECT policy FROM ui_strategy_policy_state WHERE id = TRUE");
    const row = result.rows[0] as { policy?: unknown } | undefined;
    return row?.policy ? parseUiStrategyGovernancePolicy(row.policy) : null;
  }

  async loadPreference(userId: string): Promise<UiStrategyPreferenceRecord | null> {
    const result = await this.db.query(
      `SELECT user_id, strategy_id, revision, updated_at
       FROM ui_strategy_preferences WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parsePreferenceRecord({
      userId: String(row.user_id),
      strategyId: String(row.strategy_id),
      revision: Number(row.revision),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }) : null;
  }

  async savePolicy(policy: UiStrategyGovernancePolicyV1, expectedRevision: number): Promise<boolean> {
    const parsed = parseUiStrategyGovernancePolicy(policy);
    const result = expectedRevision === 0
      ? await this.db.query(
          `INSERT INTO ui_strategy_policy_state (id, revision, policy, updated_at, updated_by)
           VALUES (TRUE, $1, $2::jsonb, $3, $4)
           ON CONFLICT (id) DO NOTHING RETURNING revision`,
          [parsed.revision, JSON.stringify(parsed), parsed.updatedAt, parsed.updatedBy],
        )
      : await this.db.query(
          `UPDATE ui_strategy_policy_state
           SET revision = $1, policy = $2::jsonb, updated_at = $3, updated_by = $4
           WHERE id = TRUE AND revision = $5 RETURNING revision`,
          [parsed.revision, JSON.stringify(parsed), parsed.updatedAt, parsed.updatedBy, expectedRevision],
        );
    if (result.rowCount !== 1) return false;
    await this.db.query(
      `INSERT INTO ui_strategy_policy_history (revision, policy, updated_at, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [parsed.revision, JSON.stringify(parsed), parsed.updatedAt, parsed.updatedBy],
    );
    return true;
  }

  async savePreference(record: UiStrategyPreferenceRecord, expectedRevision: number): Promise<boolean> {
    const parsed = parsePreferenceRecord(record);
    const result = expectedRevision === 0
      ? await this.db.query(
          `INSERT INTO ui_strategy_preferences (user_id, strategy_id, revision, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO NOTHING RETURNING revision`,
          [parsed.userId, parsed.strategyId, parsed.revision, parsed.updatedAt],
        )
      : await this.db.query(
          `UPDATE ui_strategy_preferences
           SET strategy_id = $1, revision = $2, updated_at = $3
           WHERE user_id = $4 AND revision = $5 RETURNING revision`,
          [parsed.strategyId, parsed.revision, parsed.updatedAt, parsed.userId, expectedRevision],
        );
    return result.rowCount === 1;
  }

  async lockPolicy(): Promise<void> {
    await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended('ui-strategy-policy', 0))");
  }

  async withAtomic<T>(operation: () => Promise<T>, audit?: AuditStore): Promise<T> {
    if (audit && (!(audit instanceof PgAuditStore) || !audit.isBoundTo(this.pool))) {
      throw new Error("PostgreSQL strategy-governance and audit stores must share one pool");
    }
    const client = await this.pool.connect();
    let transactionStarted = false;
    let commitAttempted = false;
    let released = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const result = await pgStrategyTx.run(client, () =>
        audit instanceof PgAuditStore ? audit.withTransaction(client, operation) : operation());
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted) {
        client.release(new Error("strategy-governance commit outcome is unknown"));
        released = true;
        throw new StrategyGovernanceCommitOutcomeUnknownError();
      }
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A client that cannot confirm rollback is not safe to return to the
          // pool. Preserve the mutation error while discarding the connection.
          client.release(new Error("strategy-governance rollback failed"));
          released = true;
        }
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
}
