/**
 * PostgreSQL-backed proof for the log-time durable record.
 *
 * The memory store carries the service tests; this file proves the SQL those
 * tests stand in for, including the constraints that exist so an impossible
 * record cannot be written even by a caller that bypasses the service.
 *
 * Skipped unless `COLLAB_TEST_ADMIN_URL` names a reachable PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgCaseStore, type CaseRow } from "../cases/store.js";
import { PgLogTimeStore, type LogTimeDeclarationRow } from "./store.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREATED_AT = "2026-08-20T00:00:00.000Z";
const FINGERPRINT = "a".repeat(64);
const SOURCE = "worker/batch.log";

function caseRow(id = CASE_ID): CaseRow {
  return {
    id,
    title: "fixture",
    problemStatement: "",
    affectedParties: "",
    impact: "",
    scope: "",
    openQuestions: [],
    situationVersion: 0,
    severity: "low",
    status: "open",
    legalHold: false,
    retentionClass: "standard",
    createdAt: CREATED_AT,
    createdBy: "analyst-synthetic-01",
    createdByUsername: "analyst-synthetic-01",
    participants: [],
  };
}

function declaration(
  overrides: Partial<LogTimeDeclarationRow> = {},
): LogTimeDeclarationRow {
  return {
    caseId: CASE_ID,
    source: SOURCE,
    ianaTimezone: "America/Chicago",
    basis: "user_declared",
    declaredAt: 1_710_093_600,
    appliedRevision: 2,
    declarationFingerprint: FINGERPRINT,
    declaredBy: "analyst-synthetic-01",
    ...overrides,
  };
}

async function withStore(
  fn: (store: PgLogTimeStore, pool: Pool) => Promise<void>,
): Promise<void> {
  await withDisposableDb(async (client, url) => {
    await migrateUp(client);
    const pool = new Pool({ connectionString: url });
    try {
      await new PgCaseStore(pool).insertCase(caseRow());
      await fn(new PgLogTimeStore(pool), pool);
    } finally {
      await pool.end();
    }
  });
}

async function insertCorpus(store: PgLogTimeStore, revision = 1): Promise<void> {
  await store.insertCorpus({
    caseId: CASE_ID,
    corpusId: "corpus-synthetic-0001",
    corpusName: "synthetic war room case",
    privacyClass: "owner_only",
    corpusRevision: revision,
    undoableRevision: null,
    builtAt: CREATED_AT,
    builtBy: "analyst-synthetic-01",
  });
}

async function insertOperation(
  store: PgLogTimeStore,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await store.insertOperation({
    id,
    caseId: CASE_ID,
    operation: "apply",
    source: SOURCE,
    previousRevision: 1,
    appliedRevision: 2,
    restoredRevision: null,
    changedRecords: 4,
    idempotencyKey: "apply-worker-0001",
    requestDigest: FINGERPRINT,
    createdAt: CREATED_AT,
    createdBy: "analyst-synthetic-01",
    ...overrides,
  } as Parameters<PgLogTimeStore["insertOperation"]>[0]);
  return id;
}

describe.skipIf(!adminUrl())("pg-backed log-time record", () => {
  it("round-trips a corpus and advances its revision", async () => {
    await withStore(async (store) => {
      expect(await store.getCorpus(CASE_ID)).toBeNull();
      await insertCorpus(store);

      const built = await store.getCorpus(CASE_ID);
      expect(built?.corpusId).toBe("corpus-synthetic-0001");
      expect(built?.corpusRevision).toBe(1);
      expect(built?.undoableRevision).toBeNull();
      expect(built?.builtAt).toBe(CREATED_AT);

      await store.updateCorpusRevision(CASE_ID, 2, 1);
      const advanced = await store.getCorpus(CASE_ID);
      expect(advanced?.corpusRevision).toBe(2);
      expect(advanced?.undoableRevision).toBe(1);
    });
  });

  it("refuses a second corpus for the same case", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await expect(insertCorpus(store)).rejects.toThrow();
    });
  });

  it("refuses an undo target at or after the current revision", async () => {
    await withStore(async (store) => {
      await insertCorpus(store, 3);
      await expect(store.updateCorpusRevision(CASE_ID, 3, 3)).rejects.toThrow(
        /log_corpora_undo_check/,
      );
    });
  });

  it("round-trips a declaration and replaces it in place", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await store.putDeclaration(declaration());
      expect(await store.listDeclarations(CASE_ID)).toEqual([declaration()]);

      await store.putDeclaration(
        declaration({ ianaTimezone: "Europe/Berlin", appliedRevision: 3 }),
      );
      const rows = await store.listDeclarations(CASE_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ianaTimezone).toBe("Europe/Berlin");

      await store.deleteDeclaration(CASE_ID, SOURCE);
      expect(await store.listDeclarations(CASE_ID)).toEqual([]);
    });
  });

  it("refuses a declaration whose fingerprint is not a digest", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await expect(
        store.putDeclaration(declaration({ declarationFingerprint: "not-a-digest" })),
      ).rejects.toThrow(/fingerprint_check/);
    });
  });

  it("refuses an absolute or traversing source identity at the database", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      for (const source of ["/var/log/worker.log", "worker/../../etc/passwd"]) {
        await expect(store.putDeclaration(declaration({ source }))).rejects.toThrow(
          /source_check/,
        );
      }
    });
  });

  it("refuses a basis the pipeline cannot produce", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await expect(
        store.putDeclaration(
          declaration({ basis: "inferred" as LogTimeDeclarationRow["basis"] }),
        ),
      ).rejects.toThrow(/basis_check/);
    });
  });

  it("replaces the whole declaration set for an undo", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await store.putDeclaration(declaration());
      await store.putDeclaration(declaration({ source: "gateway/edge.log" }));
      expect(await store.listDeclarations(CASE_ID)).toHaveLength(2);

      await store.replaceDeclarations(CASE_ID, [declaration({ appliedRevision: 5 })]);
      const rows = await store.listDeclarations(CASE_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe(SOURCE);
      expect(rows[0]?.appliedRevision).toBe(5);
    });
  });

  it("records an operation and finds it again by idempotency key", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      const id = await insertOperation(store);

      const found = await store.getOperationByIdempotency(CASE_ID, "apply-worker-0001");
      expect(found?.id).toBe(id);
      expect(found?.appliedRevision).toBe(2);
      expect(found?.restoredRevision).toBeNull();
      expect(await store.getOperationByIdempotency(CASE_ID, "never-used-0001")).toBeNull();
    });
  });

  it("refuses reusing one idempotency key within a case", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await insertOperation(store);
      await expect(
        insertOperation(store, { previousRevision: 2, appliedRevision: 3 }),
      ).rejects.toThrow();
    });
  });

  it("refuses a durable operation that does not advance the revision", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await expect(
        insertOperation(store, { previousRevision: 2, appliedRevision: 2 }),
      ).rejects.toThrow(/advance_check/);
    });
  });

  it("refuses an undo with no restored revision, and an apply that claims one", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      await expect(
        insertOperation(store, {
          operation: "undo",
          source: null,
          previousRevision: 3,
          appliedRevision: 4,
          restoredRevision: null,
          idempotencyKey: "undo-worker-0001",
        }),
      ).rejects.toThrow(/restore_check/);
      await expect(
        insertOperation(store, {
          restoredRevision: 2,
          idempotencyKey: "apply-worker-0003",
        }),
      ).rejects.toThrow(/restore_check/);
    });
  });

  it("keeps the dependent record append-only and reports the latest per dependent", async () => {
    await withStore(async (store, pool) => {
      await insertCorpus(store);
      const first = await insertOperation(store);
      const second = await insertOperation(store, {
        operation: "clear",
        previousRevision: 2,
        appliedRevision: 3,
        idempotencyKey: "clear-worker-0001",
      });

      await store.insertDependents([
        {
          caseId: CASE_ID,
          operationId: first,
          kind: "snapshot",
          dependentId: "snapshot-synthetic-0001",
          disposition: "revised",
          reason: "synthetic reason",
          observedRevision: 1,
        },
      ]);
      await store.insertDependents([
        {
          caseId: CASE_ID,
          operationId: second,
          kind: "snapshot",
          dependentId: "snapshot-synthetic-0001",
          disposition: "invalidated",
          reason: "synthetic reason",
          observedRevision: 2,
        },
      ]);

      expect(await store.listDependents(CASE_ID, first)).toHaveLength(1);
      const latest = await store.listLatestDependents(CASE_ID);
      expect(latest).toHaveLength(1);
      expect(latest[0]?.disposition).toBe("invalidated");
      expect(latest[0]?.observedRevision).toBe(2);

      // The record says what was true at the time of each change; nothing may
      // rewrite it afterwards.
      await expect(
        pool.query(
          `UPDATE log_time_dependents SET disposition = 'unaffected'
            WHERE operation_id = $1`,
          [first],
        ),
      ).rejects.toThrow(/insert-only/);
    });
  });

  it("refuses unknown_basis paired with a recorded revision", async () => {
    await withStore(async (store) => {
      await insertCorpus(store);
      const id = await insertOperation(store);
      await expect(
        store.insertDependents([
          {
            caseId: CASE_ID,
            operationId: id,
            kind: "snapshot",
            dependentId: "snapshot-synthetic-0001",
            disposition: "unknown_basis",
            reason: "synthetic reason",
            observedRevision: 3,
          },
        ]),
      ).rejects.toThrow(/unknown_check/);
    });
  });

  it("removes the whole log-time record when its case is deleted", async () => {
    await withStore(async (store, pool) => {
      await insertCorpus(store);
      await store.putDeclaration(declaration());
      await pool.query(`DELETE FROM cases WHERE id = $1`, [CASE_ID]);
      expect(await store.getCorpus(CASE_ID)).toBeNull();
      expect(await store.listDeclarations(CASE_ID)).toEqual([]);
    });
  });
});
