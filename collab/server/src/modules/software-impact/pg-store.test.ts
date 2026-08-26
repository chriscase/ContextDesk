/**
 * PostgreSQL-backed proof for the investigation software-impact records.
 *
 * Skipped unless COLLAB_TEST_ADMIN_URL names a reachable PostgreSQL. The
 * memory-store tests cover the service; these tests prove the hosted schema,
 * partial active-identity uniqueness, and soft-release behavior.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgCaseStore, type CaseRow } from "../cases/index.js";
import {
  DuplicateSoftwareImpactError,
  PgSoftwareImpactStore,
  type SoftwareImpactRow,
} from "./store.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREATED_AT = "2026-08-20T00:00:00.000Z";

function caseRow(id = CASE_ID): CaseRow {
  return {
    id,
    title: "synthetic software impact fixture",
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

function impact(overrides: Partial<SoftwareImpactRow> = {}): SoftwareImpactRow {
  return {
    id: randomUUID(),
    caseId: CASE_ID,
    productName: "Synthetic Checkout Service",
    version: "7.4",
    build: "2026.08.26-rc1",
    component: "Inventory reservation",
    environment: "Staging",
    status: "suspected",
    note: "The reservation request waits.",
    state: "active",
    recordedAt: CREATED_AT,
    recordedBy: "analyst-synthetic-01",
    recordedByUsername: "analyst-synthetic-01",
    updatedAt: CREATED_AT,
    releasedAt: null,
    ...overrides,
  };
}

async function withStore(
  fn: (store: PgSoftwareImpactStore, pool: Pool) => Promise<void>,
): Promise<void> {
  await withDisposableDb(async (client, url) => {
    await migrateUp(client);
    const pool = new Pool({ connectionString: url });
    try {
      await new PgCaseStore(pool).insertCase(caseRow());
      await fn(new PgSoftwareImpactStore(pool), pool);
    } finally {
      await pool.end();
    }
  });
}

describe.skipIf(!adminUrl())("pg-backed software impact records", () => {
  it("round-trips rows and retains a released identity for history", async () => {
    await withStore(async (store) => {
      const first = impact();
      await store.insert(first);
      expect(await store.get(first.id)).toMatchObject(first);
      expect((await store.list(CASE_ID)).map((row) => row.id)).toEqual([first.id]);

      await store.release(first.id, "2026-08-20T00:01:00.000Z");
      const released = await store.get(first.id);
      expect(released?.state).toBe("released");
      expect(released?.releasedAt).toBe("2026-08-20T00:01:00.000Z");

      const replacement = impact({
        recordedAt: "2026-08-20T00:02:00.000Z",
        updatedAt: "2026-08-20T00:02:00.000Z",
      });
      await store.insert(replacement);
      expect((await store.list(CASE_ID)).map((row) => row.state)).toEqual([
        "released",
        "active",
      ]);
    });
  });

  it("enforces active identity uniqueness in PostgreSQL", async () => {
    await withStore(async (store) => {
      const first = impact();
      await store.insert(first);
      await expect(store.insert(impact({ productName: "synthetic checkout service" }))).rejects.toEqual(
        expect.objectContaining({
          constructor: DuplicateSoftwareImpactError,
          existingId: first.id,
        }),
      );
    });
  });

  it("rejects impossible identities and statuses even when bypassing the service", async () => {
    await withStore(async (_store, pool) => {
      await expect(
        pool.query(
          `INSERT INTO investigation_software_impact (
             id, case_id, product_name, version, build, component, environment,
             status, note, state, recorded_at, recorded_by, recorded_by_username,
             updated_at, released_at
           ) VALUES ($1, $2, '', '', '', '', '', 'not-a-status', 'x', 'active', $3, 'x', 'x', $3, NULL)`,
          [randomUUID(), CASE_ID, CREATED_AT],
        ),
      ).rejects.toThrow();
    });
  });
});
