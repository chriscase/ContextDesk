import { describe, expect, it } from "vitest";
import { adminUrl, withDisposableDb } from "../test/disposable-db.js";
import { latestMigrationVersion, listMigrations, migrateDown, migrateUp } from "./migrate.js";

describe("migration versions", () => {
  it("pins the canonical PostgreSQL head at the investigation record graph", () => {
    const versions = listMigrations().map((file) => file.version);
    expect(versions).toContain("015_user_profiles");
    expect(versions).toContain("016_contribution_write_intents");
    expect(versions).toContain("017_investigation_record");
    expect(latestMigrationVersion()).toBe("017_investigation_record");
  });
});

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
      expect(up.applied).toContain("012_case_situation");
      expect(up.applied).toContain("013_corpus_intake");
      expect(up.applied).toContain("014_portable_apply_intents");
      expect(up.applied).toContain("015_user_profiles");
      expect(up.applied).toContain("016_contribution_write_intents");
      expect(up.applied).toContain("017_investigation_record");
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_events'`,
      );
      expect(tables.rows).toHaveLength(1);
      const situationColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cases'
           AND column_name IN ('open_questions', 'situation_version')
         ORDER BY column_name`,
      );
      expect(situationColumns.rows.map((row) => row.column_name)).toEqual([
        "open_questions",
        "situation_version",
      ]);
      const constraint = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = 'cases_open_questions_array_check'`,
      );
      expect(constraint.rows[0]?.definition).toContain("jsonb_path_exists");
      const intakeConstraint = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = 'evidence_artifacts_intake_batch_fk'`,
      );
      expect(intakeConstraint.rows[0]?.definition).toContain(
        "FOREIGN KEY (case_id, intake_batch_id)",
      );
      expect(intakeConstraint.rows[0]?.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
      await client.query(`
        INSERT INTO cases (id, title, severity, status, created_by, created_by_username)
        VALUES (
          '11111111-1111-4111-8111-111111111111',
          'synthetic referential fixture',
          'low',
          'open',
          'synthetic-actor',
          'synthetic-actor'
        )
      `);
      await expect(client.query(`
        INSERT INTO evidence_artifacts (
          id, case_id, kind, filename, privacy_class, uploader_id, uploader_username,
          intake_batch_id
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          'log',
          'synthetic.log',
          'owner_only',
          'synthetic-actor',
          'synthetic-actor',
          '33333333-3333-4333-8333-333333333333'
        )
      `)).rejects.toThrow(/evidence_artifacts_intake_batch_fk/);
      // Rolling back 017 removes the relationship tables and the occurred-at
      // columns and leaves case, evidence, and timeline content untouched.
      expect((await migrateDown(client)).rolledBack).toBe("017_investigation_record");
      const recordTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename IN ('investigation_entities', 'investigation_involvements',
                             'investigation_references', 'investigation_resolutions')`,
      );
      expect(recordTables.rows).toHaveLength(0);
      const occurredColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cases'
           AND column_name LIKE 'occurred_at%'`,
      );
      expect(occurredColumns.rows).toHaveLength(0);
      const survivingCases = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cases`,
      );
      expect(Number(survivingCases.rows[0]?.count)).toBeGreaterThan(0);
      expect((await migrateDown(client)).rolledBack).toBe("016_contribution_write_intents");
      expect((await migrateDown(client)).rolledBack).toBe("015_user_profiles");
      expect((await migrateDown(client)).rolledBack).toBe("014_portable_apply_intents");
      expect((await migrateDown(client)).rolledBack).toBe("013_corpus_intake");
      const intakeTable = await client.query<{ to_regclass: string | null }>(
        `SELECT to_regclass('public.evidence_intake_batches') AS to_regclass`,
      );
      expect(intakeTable.rows[0]?.to_regclass).toBeNull();
      expect((await migrateDown(client)).rolledBack).toBe("012_case_situation");
      const rolledBackColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cases'
           AND column_name IN ('open_questions', 'situation_version')`,
      );
      expect(rolledBackColumns.rows).toHaveLength(0);
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
      expect(dry.pending).toContain("012_case_situation");
      expect(dry.pending).toContain("013_corpus_intake");
      expect(dry.pending).toContain("014_portable_apply_intents");
      expect(dry.pending).toContain("015_user_profiles");
      expect(dry.pending).toContain("016_contribution_write_intents");
      expect(dry.pending).toContain("017_investigation_record");
      expect(dry.applied).toHaveLength(0);
      expect(dry.sql.some((s) => s.includes("evidence_file_references"))).toBe(
        true,
      );
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(tables.rows).toHaveLength(0);
    });
  });
});
