import { Client, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
} from "@cd-collab/contracts";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, appRoleUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { runWithCaseQueryable } from "../cases/index.js";
import {
  CatalogCommitOutcomeUnknownError,
  CatalogMutationRefusedError,
  CatalogService,
} from "./service.js";
import { CatalogMutationBoundaryError, PgCatalogStore } from "./store.js";

const ALICE = { id: "alice", username: "alice" };

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
    name: "PG assistant",
    kind: "external-tool" as const,
    description: null,
    identityId: null,
    expectedRevision: 0 as const,
    idempotencyKey: "src-pg-create-0001",
    ...overrides,
  };
}

describe("PgCatalogStore transaction faults", () => {
  it("discards the client and reports unknown outcome when COMMIT fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "COMMIT") throw new Error("connection lost");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = Object.create(Pool.prototype) as Pool;
    pool.connect = vi.fn(async () => client) as Pool["connect"];
    const store = new PgCatalogStore(pool);
    await expect(store.withAtomic(async () => "written")).rejects.toBeInstanceOf(
      CatalogCommitOutcomeUnknownError,
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("does not roll back after a COMMIT attempt", async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        if (statement === "COMMIT") throw new Error("connection lost");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = Object.create(Pool.prototype) as Pool;
    pool.connect = vi.fn(async () => client) as Pool["connect"];
    const store = new PgCatalogStore(pool);
    await expect(store.withAtomic(async () => "written")).rejects.toBeInstanceOf(
      CatalogCommitOutcomeUnknownError,
    );
    expect(sql).toEqual(["BEGIN", "COMMIT"]);
    expect(sql).not.toContain("ROLLBACK");
    expect(client.query.mock.calls.filter((call) => call[0] === "COMMIT")).toHaveLength(1);
  });

  it("fails closed instead of SELECT FOR UPDATE in autocommit", async () => {
    const sql: string[] = [];
    const pool = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement);
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;
    const store = new PgCatalogStore(pool);
    await expect(store.lockSource("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(
      CatalogMutationBoundaryError,
    );
    await expect(store.lockActorIdempotency("alice", "src-lock")).rejects.toBeInstanceOf(
      CatalogMutationBoundaryError,
    );
    await expect(store.lockIdentity("alice")).rejects.toBeInstanceOf(CatalogMutationBoundaryError);
    await expect(store.saveLifecycle("11111111-1111-4111-8111-111111111111", "retired", 2)).rejects.toBeInstanceOf(
      CatalogMutationBoundaryError,
    );
    await expect(
      store.insertSuccessIntent({
        actorId: "alice",
        idempotencyKey: "src-lock",
        action: "create",
        requestDigest: "a".repeat(64),
        sourceId: "11111111-1111-4111-8111-111111111111",
        successJson: "{}",
        createdAt: "2026-09-05T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(CatalogMutationBoundaryError);
    expect(sql.some((statement) => /FOR UPDATE/i.test(statement))).toBe(false);
    expect(sql.some((statement) => /pg_advisory_xact_lock/i.test(statement))).toBe(false);
  });

  it("joins an active case transaction instead of opening a second pool transaction", async () => {
    const sql: string[] = [];
    const caseClient = {
      query: vi.fn(async (statement: string) => {
        sql.push(typeof statement === "string" ? statement : String(statement));
        return { rows: [], rowCount: 0 };
      }),
    };
    const pool = Object.create(Pool.prototype) as Pool;
    pool.connect = vi.fn(async () => {
      throw new Error("must not open an independent catalog transaction");
    }) as Pool["connect"];
    const store = new PgCatalogStore(pool);
    const joined = await runWithCaseQueryable(caseClient, () =>
      store.withAtomic(async () => "joined"),
    );
    expect(joined).toBe("joined");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it("uses the active catalog transaction queryable for probeExistingIds", async () => {
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(typeof statement === "string" ? statement : String(statement));
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = Object.create(Pool.prototype) as Pool;
    pool.query = vi.fn(async () => {
      throw new Error("probeExistingIds must not use the pool while a catalog transaction is active");
    }) as Pool["query"];
    pool.connect = vi.fn(async () => client) as Pool["connect"];
    const store = new PgCatalogStore(pool);
    await store.withAtomic(async () => {
      await store.probeExistingIds(["11111111-1111-4111-8111-111111111111"]);
      return "ok";
    });
    expect(sql.some((statement) => statement.includes("WHERE id = ANY"))).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a PostgreSQL audit store from a different connection source", async () => {
    const queryable = {
      query: vi.fn(async (statement: string) => {
        if (statement === "BEGIN" || statement === "ROLLBACK" || statement === "COMMIT") {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const other = {
      query: vi.fn(),
    };
    const store = new PgCatalogStore(queryable);
    const audit = new PgAuditStore(other);
    await expect(store.withAtomic(async () => "nope", audit)).rejects.toThrow(
      /must share one connection source/,
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });
});

describe.skipIf(!adminUrl())("postgres source catalog mutations", () => {
  it("matches memory create/replay/CAS and uses advisory plus row locks", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const queries: string[] = [];
      pool.on("connect", (connected) => {
        const originalQuery = connected.query.bind(connected);
        connected.query = ((...args: Parameters<typeof connected.query>) => {
          const sql = typeof args[0] === "string" ? args[0] : String(args[0]);
          queries.push(sql);
          return originalQuery(...args);
        }) as typeof connected.query;
      });
      const audit = new PgAuditStore(pool);
      const store = new PgCatalogStore(pool);
      const catalog = new CatalogService(store, audit);
      try {
        const created = parseSourceMutationSuccess(
          await catalog.applyCreate(ALICE, createRequest({ idempotencyKey: "src-pg-lock" }), "test"),
        );
        expect(created.applied.revision).toBe(1);
        const replay = parseSourceMutationSuccess(
          await catalog.applyCreate(
            ALICE,
            createRequest({ idempotencyKey: "src-pg-lock", expectedRevision: 99 }),
            "test",
          ),
        );
        expect(replay.replayed).toBe(true);
        expect(replay.sourceId).toBe(created.sourceId);
        expect((await audit.list({ action: "catalog_create" })).filter((row) => row.target === created.sourceId)).toHaveLength(1);

        const retired = parseSourceMutationSuccess(
          await catalog.applyRetire(
            ALICE,
            {
              schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
              sourceId: created.sourceId,
              expectedRevision: 1,
              idempotencyKey: "src-pg-retire",
            },
            "test",
          ),
        );
        expect(retired.appliedRevision).toBe(2);
        expect(queries.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
        expect(queries.some((sql) => /FOR UPDATE/i.test(sql))).toBe(true);

        const bound = parseSourceMutationSuccess(
          await catalog.applyCreate(
            ALICE,
            createRequest({
              idempotencyKey: "src-pg-identity-a",
              name: "Alice human",
              kind: "human",
              identityId: "alice",
            }),
            "test",
          ),
        );
        await expect(
          catalog.applyCreate(
            ALICE,
            createRequest({
              idempotencyKey: "src-pg-identity-b",
              name: "Also Alice",
              kind: "human",
              identityId: "alice",
            }),
            "test",
          ),
        ).rejects.toBeInstanceOf(CatalogMutationRefusedError);
        try {
          await catalog.applyCreate(
            ALICE,
            createRequest({
              idempotencyKey: "src-pg-identity-b",
              name: "Also Alice",
              kind: "human",
              identityId: "alice",
            }),
            "test",
          );
        } catch (error) {
          expect(parseSourceMutationRefused((error as CatalogMutationRefusedError).body).reason).toBe(
            "identity_already_bound",
          );
          expect((error as CatalogMutationRefusedError).body.current?.id).toBe(bound.sourceId);
        }
      } finally {
        await pool.end();
      }
    });
  });

  it("serializes concurrent same-key and same-identity creates", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const catalog = new CatalogService(new PgCatalogStore(pool), new PgAuditStore(pool));
      try {
        const [left, right] = await Promise.all([
          catalog.applyCreate(ALICE, createRequest({ idempotencyKey: "src-pg-same-key" }), "test"),
          catalog.applyCreate(ALICE, createRequest({ idempotencyKey: "src-pg-same-key" }), "test"),
        ]);
        expect([left, right].filter((row) => row.replayed)).toHaveLength(1);
        expect([left, right].filter((row) => !row.replayed)).toHaveLength(1);
        expect(left.sourceId).toBe(right.sourceId);

        const first = catalog.applyCreate(
          ALICE,
          createRequest({
            idempotencyKey: "src-pg-id-a",
            name: "One",
            kind: "human",
            identityId: "shared-identity",
          }),
          "test",
        );
        const second = catalog.applyCreate(
          { id: "bob", username: "bob" },
          createRequest({
            idempotencyKey: "src-pg-id-b",
            name: "Two",
            kind: "human",
            identityId: "shared-identity",
          }),
          "test",
        );
        const results = await Promise.allSettled([first, second]);
        const fulfilled = results.filter((row) => row.status === "fulfilled");
        const refused = results.filter(
          (row) =>
            row.status === "rejected" && row.reason instanceof CatalogMutationRefusedError,
        );
        expect(fulfilled).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(
          ((refused[0] as PromiseRejectedResult).reason as CatalogMutationRefusedError).body.reason,
        ).toBe("identity_already_bound");
      } finally {
        await pool.end();
      }
    });
  });

  it("rolls PostgreSQL catalog mutations back on pre-commit failure", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const store = new PgCatalogStore(pool);
      const audit = new PgAuditStore(pool);
      store.insertSuccessIntent = async () => {
        throw new Error("injected pg intent failure");
      };
      const catalog = new CatalogService(store, audit);
      try {
        await expect(
          catalog.applyCreate(ALICE, createRequest({ idempotencyKey: "src-pg-rollback" }), "test"),
        ).rejects.toThrow(/injected pg intent failure/);
        expect((await catalog.list()).some((source) => source.name === "PG assistant")).toBe(false);
        expect(await store.getSuccessIntent(ALICE.id, "src-pg-rollback")).toBeNull();
        expect(await audit.list({ action: "catalog_create" })).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });

  it("keeps memory/Postgres create revision parity for human mint", async () => {
    const memory = new CatalogService(undefined, new MemoryAuditStore());
    const minted = await memory.ensureHumanSource(ALICE);
    expect(minted.revision).toBe(1);
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const catalog = new CatalogService(new PgCatalogStore(pool), new PgAuditStore(pool));
      try {
        const pgMinted = await catalog.ensureHumanSource(ALICE);
        expect(pgMinted.revision).toBe(1);
        expect(pgMinted.identityId).toBe(ALICE.id);
      } finally {
        await pool.end();
      }
    });
  });

  it("uses conflict-safe identity insert and holds attribution locks only inside the callback", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const queries: string[] = [];
      pool.on("connect", (connected) => {
        const originalQuery = connected.query.bind(connected);
        connected.query = ((...args: Parameters<typeof connected.query>) => {
          const sql = typeof args[0] === "string" ? args[0] : String(args[0]);
          queries.push(sql);
          return originalQuery(...args);
        }) as typeof connected.query;
      });
      const store = new PgCatalogStore(pool);
      const catalog = new CatalogService(store, new PgAuditStore(pool));
      try {
        const created = await catalog.applyCreate(
          ALICE,
          createRequest({
            idempotencyKey: "src-pg-on-conflict",
            name: "Bound",
            kind: "human",
            identityId: "shared-identity",
          }),
          "test",
        );
        expect(queries.some((sql) => /ON CONFLICT \(identity_id\)/i.test(sql))).toBe(true);
        await expect(
          catalog.applyCreate(
            ALICE,
            createRequest({
              idempotencyKey: "src-pg-on-conflict-b",
              name: "Also Bound",
              kind: "human",
              identityId: "shared-identity",
            }),
            "test",
          ),
        ).rejects.toBeInstanceOf(CatalogMutationRefusedError);

        let observedLock = false;
        const locked = await catalog.lockSourceForAttribution(created.sourceId, async (source) => {
          observedLock = queries.some((sql) => /FOR UPDATE/i.test(sql));
          return source;
        });
        expect(locked.id).toBe(created.sourceId);
        expect(observedLock).toBe(true);

        const mismatch = await catalog
          .applyCreate(
            ALICE,
            createRequest({
              idempotencyKey: "src-pg-on-conflict",
              name: "Different",
            }),
            "test",
          )
          .catch((error) => error);
        expect(mismatch).toBeInstanceOf(CatalogMutationRefusedError);
        expect((mismatch as CatalogMutationRefusedError).body.current).toBeNull();
      } finally {
        await pool.end();
      }
    });
  });

  it("caps revision at MAX_SAFE_INTEGER and withholds kind/identity/created_by UPDATE from collab_app", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);
      await expect(
        admin.query(`
          UPDATE catalog_sources
          SET revision = 9007199254740992
          WHERE id = $1
        `, [PERMANENT_UNKNOWN_SOURCE_ID]),
      ).rejects.toThrow(/catalog_sources_revision_check/);
      await admin.query(`
        INSERT INTO catalog_sources (
          id, name, kind, description, lifecycle, identity_id, created_at, created_by, revision
        ) VALUES (
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cap', 'external-tool', NULL, 'active',
          NULL, CURRENT_TIMESTAMP, 'alice', 9007199254740991
        )
      `);
      await expect(
        admin.query(`
          INSERT INTO catalog_sources (
            id, name, kind, description, lifecycle, identity_id, created_at, created_by, revision
          ) VALUES (
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'over', 'external-tool', NULL, 'active',
            NULL, CURRENT_TIMESTAMP, 'alice', 9007199254740992
          )
        `),
      ).rejects.toThrow(/catalog_sources_revision_check/);

      const app = new Client({ connectionString: appRoleUrl(url) });
      await app.connect();
      try {
        const privileges = await app.query<{
          table_update: boolean;
          id_update: boolean;
          name_update: boolean;
          lifecycle_update: boolean;
          revision_update: boolean;
          kind_update: boolean;
          created_by_update: boolean;
          identity_update: boolean;
        }>(`
          SELECT
            has_table_privilege(current_user, 'catalog_sources', 'UPDATE') AS table_update,
            has_column_privilege(current_user, 'catalog_sources', 'id', 'UPDATE') AS id_update,
            has_column_privilege(current_user, 'catalog_sources', 'name', 'UPDATE') AS name_update,
            has_column_privilege(current_user, 'catalog_sources', 'lifecycle', 'UPDATE') AS lifecycle_update,
            has_column_privilege(current_user, 'catalog_sources', 'revision', 'UPDATE') AS revision_update,
            has_column_privilege(current_user, 'catalog_sources', 'kind', 'UPDATE') AS kind_update,
            has_column_privilege(current_user, 'catalog_sources', 'created_by', 'UPDATE') AS created_by_update,
            has_column_privilege(current_user, 'catalog_sources', 'identity_id', 'UPDATE') AS identity_update
        `);
        expect(privileges.rows[0]).toEqual({
          table_update: false,
          id_update: false,
          name_update: true,
          lifecycle_update: true,
          revision_update: true,
          kind_update: false,
          created_by_update: false,
          identity_update: false,
        });
        await expect(
          app.query(`UPDATE catalog_sources SET id = $2 WHERE id = $1`, [
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.query(`UPDATE catalog_sources SET kind = 'human' WHERE id = $1`, [
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.query(`UPDATE catalog_sources SET created_by = 'tamper' WHERE id = $1`, [
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          app.query(`UPDATE catalog_sources SET identity_id = 'tamper' WHERE id = $1`, [
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ]),
        ).rejects.toThrow(/permission denied/);
        await app.query(`SELECT id FROM catalog_sources WHERE id = $1 FOR UPDATE`, [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ]);
        await app.query(
          `UPDATE catalog_sources SET name = 'renamed', lifecycle = 'retired', revision = 9007199254740991
           WHERE id = $1`,
          ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        );
        await expect(
          app.query(`UPDATE source_catalog_success_intents SET success_json = '{}'`),
        ).rejects.toThrow(/insert-only|permission denied/);
      } finally {
        await app.end();
      }
    });
  });
});
