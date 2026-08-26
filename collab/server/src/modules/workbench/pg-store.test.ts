/**
 * PostgreSQL-backed Log workbench records. Skipped unless COLLAB_TEST_ADMIN_URL
 * names a reachable PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgCaseStore, type CaseRow } from "../cases/index.js";
import { PgWorkbenchStore, type WorkbenchBookmarkRow, type WorkbenchViewRow } from "./store.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREATED_AT = "2026-08-20T00:00:00.000Z";
const DIGEST = "a".repeat(64);

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

async function withStore(
  fn: (store: PgWorkbenchStore, pool: Pool) => Promise<void>,
): Promise<void> {
  await withDisposableDb(async (client, url) => {
    await migrateUp(client);
    const pool = new Pool({ connectionString: url });
    try {
      await new PgCaseStore(pool).insertCase(caseRow());
      await fn(new PgWorkbenchStore(pool), pool);
    } finally {
      await pool.end();
    }
  });
}

describe.skipIf(!adminUrl())("pg-backed workbench record", () => {
  it("round-trips a saved view and refuses a duplicate idempotency key", async () => {
    await withStore(async (store) => {
      const row: WorkbenchViewRow = {
        id: randomUUID(),
        caseId: CASE_ID,
        name: "Timeout window",
        payloadJson: "{}",
        idempotencyKey: "view-timeout-0001",
        requestDigest: DIGEST,
        privacyClass: "owner_only",
        createdAt: CREATED_AT,
        createdBy: "analyst-synthetic-01",
      };
      await store.insertView(row);
      expect((await store.listViews(CASE_ID))[0]?.name).toBe("Timeout window");
      await expect(store.insertView({ ...row, id: randomUUID() })).rejects.toThrow();
    });
  });

  it("looks up a bookmark by share-safe token and refuses mutation", async () => {
    await withStore(async (store, pool) => {
      const row: WorkbenchBookmarkRow = {
        id: randomUUID(),
        caseId: CASE_ID,
        evidenceId: randomUUID(),
        payloadJson: "{}",
        shareSafeToken: "b".repeat(64),
        idempotencyKey: "bookmark-gap-0001",
        requestDigest: DIGEST,
        privacyClass: "owner_only",
        createdAt: CREATED_AT,
        createdBy: "analyst-synthetic-01",
      };
      await store.insertBookmark(row);
      expect((await store.getBookmarkByToken(row.shareSafeToken))?.id).toBe(row.id);
      await expect(
        pool.query(`UPDATE log_workbench_bookmarks SET payload_json = '{}' WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/insert-only/);
    });
  });

  it("adds a nullable normalization revision on snapshots", async () => {
    await withStore(async (_store, pool) => {
      const result = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'snapshots' AND column_name = 'normalization_revision'`,
      );
      expect(result.rows).toHaveLength(1);
    });
  });
});
