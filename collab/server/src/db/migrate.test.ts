import { describe, expect, it } from "vitest";
import { adminUrl, withDisposableDb } from "../test/disposable-db.js";
import { migrateDown, migrateUp } from "./migrate.js";

describe.skipIf(!adminUrl())("migrations", () => {
  it("applies and rolls back all migrations in order", async () => {
    await withDisposableDb(async (client) => {
      const up = await migrateUp(client);
      expect(up.applied).toContain("001_baseline");
      expect(up.applied).toContain("002_auth_audit");
      expect(up.applied).toContain("003_cases");
      expect(up.applied).toContain("004_catalog_import");
      expect(up.applied).toContain("005_authz_bootstrap");
      expect(up.applied).toContain("006_experiments");
      expect(up.applied).toContain("007_gold_references");
      expect(up.applied).toContain("007_snapshots");
      expect(up.applied).toContain("008_interaction_traces");
      expect(up.applied).toContain("009_triage_jobs");
      expect(up.applied).toContain("010_presence");
      expect(up.applied).toContain("011_triage_worker_leases");
      expect(up.applied).toContain("012_triage_job_rerun_integrity");
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_events'`,
      );
      expect(tables.rows).toHaveLength(1);
      const rerunColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'triage_jobs'
           AND column_name IN ('parent_job_id', 'idempotency_scope_digest', 'idempotency_binding_digest')
         ORDER BY column_name`,
      );
      expect(rerunColumns.rows.map((row) => row.column_name)).toEqual([
        "idempotency_binding_digest",
        "idempotency_scope_digest",
        "parent_job_id",
      ]);
      expect((await migrateDown(client)).rolledBack).toBe("012_triage_job_rerun_integrity");
      expect((await migrateDown(client)).rolledBack).toBe("011_triage_worker_leases");
      expect((await migrateDown(client)).rolledBack).toBe("010_presence");
      expect((await migrateDown(client)).rolledBack).toBe("009_triage_jobs");
      expect((await migrateDown(client)).rolledBack).toBe("008_interaction_traces");
      expect((await migrateDown(client)).rolledBack).toBe("007_snapshots");
      expect((await migrateDown(client)).rolledBack).toBe("007_gold_references");
      expect((await migrateDown(client)).rolledBack).toBe("006_experiments");
      expect((await migrateDown(client)).rolledBack).toBe("005_authz_bootstrap");
      expect((await migrateDown(client)).rolledBack).toBe("004_catalog_import");
      expect((await migrateDown(client)).rolledBack).toBe("003_cases");
      expect((await migrateDown(client)).rolledBack).toBe("002_auth_audit");
      const second = await migrateDown(client);
      expect(second.rolledBack).toBe("001_baseline");
      const gone = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('evidence_file_references', 'audit_events', 'experiment_packages')`,
      );
      expect(gone.rows).toHaveLength(0);
    });
  });

  it("dry-run lists pending SQL without applying", async () => {
    await withDisposableDb(async (client) => {
      const dry = await migrateUp(client, { dryRun: true });
      expect(dry.pending).toContain("001_baseline");
      expect(dry.pending).toContain("002_auth_audit");
      expect(dry.pending).toContain("003_cases");
      expect(dry.pending).toContain("004_catalog_import");
      expect(dry.pending).toContain("005_authz_bootstrap");
      expect(dry.pending).toContain("006_experiments");
      expect(dry.pending).toContain("007_gold_references");
      expect(dry.pending).toContain("007_snapshots");
      expect(dry.pending).toContain("008_interaction_traces");
      expect(dry.pending).toContain("009_triage_jobs");
      expect(dry.pending).toContain("010_presence");
      expect(dry.pending).toContain("011_triage_worker_leases");
      expect(dry.pending).toContain("012_triage_job_rerun_integrity");
      expect(dry.applied).toHaveLength(0);
      expect(dry.sql.some((s) => s.includes("evidence_file_references"))).toBe(
        true,
      );
      expect(dry.sql.some((s) => s.includes("triage_jobs_idempotency_scope_uidx"))).toBe(true);
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(tables.rows).toHaveLength(0);
    });
  });
});
