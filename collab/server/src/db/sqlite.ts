/**
 * SQLite local/single-node runtime.
 *
 * The domain modules already expose memory stores behind narrow interfaces.
 * This adapter persists those stores as a versioned JSON document inside a
 * SQLite file. It is intentionally not presented as a PostgreSQL-compatible
 * or multi-worker backend: filesystem ownership is the boundary, while
 * PostgreSQL remains the production/HA backend.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryAuditStore, type AuditStore } from "../modules/audit/index.js";
import { MemorySessionStore, type SessionStore } from "../modules/auth/index.js";
import {
  emptyMapping,
  isAppRole,
  MemoryGroupRoleStore,
  type GroupRoleMapping,
  type GroupRoleStore,
} from "../modules/authz/index.js";
import { MemoryCatalogStore, type CatalogStore } from "../modules/catalog/index.js";
import { MemoryCaseStore, type CaseStore } from "../modules/cases/index.js";
import { MemoryRunStore, type RunStore } from "../modules/import/index.js";
import { MemoryExperimentStore, type ExperimentStore } from "../modules/experiments/index.js";
import { MemoryTriageJobStore, type TriageJobStore } from "../modules/triage-runs/index.js";

const SQLITE_SCHEMA_VERSION = "sqlite-current-v1";
const TAG = "__cd_collab_state_type";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function encode(value: unknown): JsonValue {
  if (value === undefined) return { [TAG]: "undefined" };
  if (value instanceof Date) return { [TAG]: "date", value: value.toISOString() };
  if (value instanceof Map) {
    return {
      [TAG]: "map",
      entries: [...value.entries()].map(([key, item]) => [encode(key), encode(item)]),
    };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]),
    );
  }
  return value as JsonValue;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record[TAG] === "undefined") return undefined;
  if (record[TAG] === "date" && typeof record.value === "string") {
    return new Date(record.value);
  }
  if (record[TAG] === "map" && Array.isArray(record.entries)) {
    return new Map(
      record.entries.map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid SQLite state map");
        return [decode(entry[0]), decode(entry[1])] as const;
      }),
    );
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
}

function restoreStore(store: object, state: unknown): void {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("invalid persisted SQLite store state");
  }
  for (const [key, value] of Object.entries(state)) {
    // SqliteState.read has already revived dates and maps.
    Reflect.set(store, key, value);
  }
}

function storeState(store: object): JsonValue {
  return Object.fromEntries(Object.entries(store)) as JsonValue;
}

function methodNames(store: object): string[] {
  const names = new Set<string>();
  let prototype = Object.getPrototypeOf(store) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== "constructor") names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...names];
}

export class SqliteState {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS collab_state (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)",
    ).run(SQLITE_SCHEMA_VERSION);
  }

  ping(): void {
    this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(SQLITE_SCHEMA_VERSION);
  }

  read(key: string): unknown | null {
    const row = this.db.prepare("SELECT payload FROM collab_state WHERE key = ?").get(key) as
      | { payload?: unknown }
      | undefined;
    if (!row || typeof row.payload !== "string") return null;
    return decode(JSON.parse(row.payload));
  }

  write(key: string, value: unknown): void {
    this.db.prepare(
      `INSERT INTO collab_state (key, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(encode(value)), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

function persistentMemoryStore<T extends object>(
  state: SqliteState,
  key: string,
  store: T,
  mutatingMethods: ReadonlySet<string>,
): T {
  const saved = state.read(key);
  if (saved !== null) restoreStore(store, saved);
  for (const name of methodNames(store)) {
    const original = Reflect.get(store, name);
    if (typeof original !== "function") continue;
    Reflect.set(store, name, async (...args: unknown[]) => {
      const result = await Reflect.apply(original, store, args);
      if (mutatingMethods.has(name)) state.write(key, storeState(store));
      return result;
    });
  }
  return store;
}

class SqliteGroupRoleStore implements GroupRoleStore {
  private readonly memory: MemoryGroupRoleStore;

  constructor(private readonly state: SqliteState, bootstrap: GroupRoleMapping = emptyMapping()) {
    const mapping = { entries: new Map(bootstrap.entries) };
    const saved = state.read("authz_roles");
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          isAppRole(entry[1])
        ) {
          mapping.entries.set(entry[0], entry[1]);
        }
      }
    }
    this.memory = new MemoryGroupRoleStore(mapping);
  }

  async load(): Promise<GroupRoleMapping> {
    return this.memory.load();
  }

  async set(groupDn: string, role: Parameters<GroupRoleStore["set"]>[1], updatedBy: string): Promise<void> {
    await this.memory.set(groupDn, role, updatedBy);
    await this.persist();
  }

  async delete(groupDn: string): Promise<boolean> {
    const deleted = await this.memory.delete(groupDn);
    if (deleted) await this.persist();
    return deleted;
  }

  private async persist(): Promise<void> {
    const mapping = await this.memory.load();
    this.state.write("authz_roles", [...mapping.entries.entries()]);
  }
}

export interface SqliteRuntime {
  state: SqliteState;
  databaseProbe: { ping(): void };
  audit: AuditStore;
  sessions: SessionStore;
  roleStore: GroupRoleStore;
  catalog: CatalogStore;
  cases: CaseStore;
  runs: RunStore;
  experiments: ExperimentStore;
  jobs: TriageJobStore;
}

export function createSqliteRuntime(
  path: string,
  bootstrap: GroupRoleMapping = emptyMapping(),
): SqliteRuntime {
  const state = new SqliteState(path);
  return {
    state,
    databaseProbe: state,
    audit: persistentMemoryStore(state, "audit", new MemoryAuditStore(), new Set(["append"])),
    sessions: persistentMemoryStore(
      state,
      "sessions",
      new MemorySessionStore(),
      new Set(["create", "touch", "revoke"]),
    ),
    roleStore: new SqliteGroupRoleStore(state, bootstrap),
    catalog: persistentMemoryStore(
      state,
      "catalog",
      new MemoryCatalogStore(),
      new Set(["insert", "updateMeta", "setLifecycle"]),
    ),
    cases: persistentMemoryStore(
      state,
      "cases",
      new MemoryCaseStore(),
      new Set([
        "insertCase",
        "updateCaseMeta",
        "addParticipant",
        "appendTimeline",
        "insertRevision",
        "insertArtifact",
        "insertSnapshot",
      ]),
    ),
    runs: persistentMemoryStore(
      state,
      "runs",
      new MemoryRunStore(),
      new Set(["insert", "appendCorroboration"]),
    ),
    experiments: persistentMemoryStore(
      state,
      "experiments",
      new MemoryExperimentStore(),
      new Set([
        "insert",
        "insertObservation",
        "insertDecision",
        "insertGold",
        "insertTrace",
        "insertAnnotation",
      ]),
    ),
    jobs: persistentMemoryStore(
      state,
      "jobs",
      new MemoryTriageJobStore(),
      new Set(["insert", "claimQueued", "renewLease", "recoverStale", "update"]),
    ),
  };
}
