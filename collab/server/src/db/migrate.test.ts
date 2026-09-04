import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { adminUrl, withDisposableDb } from "../test/disposable-db.js";
import { latestMigrationVersion, listMigrations, migrateDown, migrateUp } from "./migrate.js";

describe("migration versions", () => {
  // The integration-train migrations remain consecutively ordered: the
  // investigation record graph, the case-bound log corpus, the narrow
  // experiment row-lock privilege, the administrator model-use policy, the
  // investigation log workbench, structured context, UI strategy governance,
  // first-class artifact annotations, replay-safe singular writes, and one
  // parent intent for each replay-safe bulk write, capability model v2, and
  // the case-row-serialized investigation coordination projection.
  it("pins the canonical PostgreSQL head at investigation coordination", () => {
    const versions = listMigrations().map((file) => file.version);
    expect(versions).toContain("015_user_profiles");
    expect(versions).toContain("016_contribution_write_intents");
    expect(versions).toContain("017_investigation_record");
    expect(versions).toContain("018_log_time");
    expect(versions).toContain("019_experiment_lock_privilege");
    expect(versions).toContain("020_model_purpose_policy");
    expect(versions).toContain("021_workbench");
    expect(versions).toContain("022_software_impact");
    expect(versions).toContain("023_investigation_context");
    expect(versions).toContain("024_ui_strategy_governance");
    expect(versions).toContain("025_artifact_annotations");
    expect(versions).toContain("026_artifact_annotation_write_intents");
    expect(versions).toContain("027_artifact_annotation_bulk_write_intents");
    expect(versions).toContain("028_capability_model_v2");
    expect(versions).toContain("029_investigation_coordination");
    expect(latestMigrationVersion()).toBe("029_investigation_coordination");
  });

  it("keeps every migration version unique and consecutively ordered from the record graph", () => {
    const versions = listMigrations().map((file) => file.version);
    expect(new Set(versions).size).toBe(versions.length);
    // localeCompare ordering is what the runner applies, so assert on it
    // directly rather than on the filenames' numeric prefixes.
    expect([...versions].sort((a, b) => a.localeCompare(b))).toEqual(versions);
    expect(versions.slice(-7)).toEqual([
      "023_investigation_context",
      "024_ui_strategy_governance",
      "025_artifact_annotations",
      "026_artifact_annotation_write_intents",
      "027_artifact_annotation_bulk_write_intents",
      "028_capability_model_v2",
      "029_investigation_coordination",
    ]);
  });

  it("replaces only the capability check with exact v2 and rollback enums", () => {
    const migration = listMigrations().find(
      (file) => file.version === "028_capability_model_v2",
    );
    expect(migration).toBeDefined();
    const values = (path: string) =>
      [...readFileSync(path, "utf8").matchAll(/'([^']+)'/g)].map(
        (match) => match[1],
      );
    expect(values(migration!.upPath)).toEqual([
      "investigation:read",
      "investigation:write",
      "investigation:coordinate",
      "evidence:private:read",
      "run:strategies",
      "decision:accept",
      "export:create",
      "portable:restore",
      "admin:users",
      "admin:system_config",
      "audit:view",
    ]);
    expect(values(migration!.downPath)).toEqual([
      "investigation:read",
      "investigation:write",
      "evidence:private:read",
      "run:strategies",
      "decision:accept",
      "export:create",
      "portable:restore",
      "admin:users",
      "admin:system_config",
      "audit:view",
    ]);
    for (const path of [migration!.upPath, migration!.downPath]) {
      const sql = readFileSync(path, "utf8");
      expect(sql.match(/DROP CONSTRAINT user_capability_grants_capability_check/g)).toHaveLength(1);
      expect(sql.match(/ADD CONSTRAINT user_capability_grants_capability_check/g)).toHaveLength(1);
      expect(sql).not.toMatch(/DELETE\s+FROM/i);
    }
  });

  it("guards coordination rollback before dropping either persisted table", () => {
    const migration = listMigrations().find(
      (file) => file.version === "029_investigation_coordination",
    );
    expect(migration).toBeDefined();
    const sql = readFileSync(migration!.downPath, "utf8");
    const projectionLock = sql.indexOf(
      "LOCK TABLE investigation_coordination IN ACCESS EXCLUSIVE MODE",
    );
    const intentLock = sql.indexOf(
      "LOCK TABLE investigation_coordination_success_intents IN ACCESS EXCLUSIVE MODE",
    );
    const projectionGuard = sql.indexOf(
      "IF EXISTS (SELECT 1 FROM investigation_coordination LIMIT 1)",
    );
    const intentGuard = sql.indexOf(
      "OR EXISTS (SELECT 1 FROM investigation_coordination_success_intents LIMIT 1)",
    );
    const firstDrop = sql.indexOf("DROP TRIGGER");
    expect(intentLock).toBeGreaterThanOrEqual(0);
    expect(projectionLock).toBeGreaterThan(intentLock);
    expect(projectionGuard).toBeGreaterThan(projectionLock);
    expect(intentGuard).toBeGreaterThan(projectionGuard);
    expect(firstDrop).toBeGreaterThan(intentGuard);
  });

  it("matches rollback locks to the coordination writer's first table access", () => {
    const migration = listMigrations().find(
      (file) => file.version === "029_investigation_coordination",
    );
    expect(migration).toBeDefined();
    const downSql = readFileSync(migration!.downPath, "utf8");
    const serviceSource = readFileSync(
      new URL("../modules/cases/service.ts", import.meta.url),
      "utf8",
    );
    const methodStart = serviceSource.indexOf("async coordinateInvestigation(");
    const methodEnd = serviceSource.indexOf("\n  async createCase(", methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = serviceSource.slice(methodStart, methodEnd);
    const intentLookup = method.indexOf("getInvestigationCoordinationSuccessIntent(");
    const projectionLookup = method.indexOf("getInvestigationCoordination(");
    expect(intentLookup).toBeGreaterThanOrEqual(0);
    expect(projectionLookup).toBeGreaterThan(intentLookup);
    expect(downSql.indexOf(
      "LOCK TABLE investigation_coordination_success_intents IN ACCESS EXCLUSIVE MODE",
    )).toBeLessThan(downSql.indexOf(
      "LOCK TABLE investigation_coordination IN ACCESS EXCLUSIVE MODE",
    ));
    // Existing writers make rollback wait before it holds the projection
    // lock; new writers cannot pass their first coordination-table access.
    // The shared intent-first order therefore removes the two-table cycle.
  });

  it("runs down migration SQL and version bookkeeping in one explicit transaction", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("to_regclass")) {
          return { rows: [{ to_regclass: "schema_migrations" }] };
        }
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: [{ version: "029_investigation_coordination" }] };
        }
        return { rows: [] };
      },
    } as unknown as Client;

    expect((await migrateDown(client)).rolledBack).toBe("029_investigation_coordination");
    const begin = queries.indexOf("BEGIN");
    const migration = queries.findIndex((sql) => sql.includes("LOCK TABLE investigation_coordination"));
    const bookkeeping = queries.findIndex((sql) =>
      sql.trimStart().startsWith("DELETE FROM schema_migrations WHERE version = $1")
    );
    const commit = queries.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(migration).toBeGreaterThan(begin);
    expect(bookkeeping).toBeGreaterThan(migration);
    expect(commit).toBeGreaterThan(bookkeeping);
  });

  it("rolls back the explicit migration transaction after down SQL fails", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("to_regclass")) {
          return { rows: [{ to_regclass: "schema_migrations" }] };
        }
        if (sql.includes("SELECT version FROM schema_migrations")) {
          return { rows: [{ version: "029_investigation_coordination" }] };
        }
        if (sql.includes("LOCK TABLE investigation_coordination")) {
          throw new Error("synthetic down failure");
        }
        return { rows: [] };
      },
    } as unknown as Client;

    await expect(migrateDown(client)).rejects.toThrow("synthetic down failure");
    expect(queries).toContain("BEGIN");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
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
      expect(up.applied).toContain("018_log_time");
      expect(up.applied).toContain("019_experiment_lock_privilege");
      expect(up.applied).toContain("020_model_purpose_policy");
      expect(up.applied).toContain("021_workbench");
      expect(up.applied).toContain("022_software_impact");
      expect(up.applied).toContain("023_investigation_context");
      expect(up.applied).toContain("024_ui_strategy_governance");
      expect(up.applied).toContain("025_artifact_annotations");
      expect(up.applied).toContain("026_artifact_annotation_write_intents");
      expect(up.applied).toContain("027_artifact_annotation_bulk_write_intents");
      expect(up.applied).toContain("028_capability_model_v2");
      expect(up.applied).toContain("029_investigation_coordination");
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
      // Proven present before it is proven gone, so a rollback assertion
      // cannot pass against a migration that never created the tables.
      const logTimeBeforeRollback = await client.query<{ to_regclass: string | null }>(
        `SELECT to_regclass('public.log_corpora') AS to_regclass`,
      );
      expect(logTimeBeforeRollback.rows[0]?.to_regclass).not.toBeNull();
      const contextColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cases'
           AND column_name = 'investigation_context'`,
      );
      expect(contextColumns.rows.map((row) => row.column_name)).toEqual([
        "investigation_context",
      ]);
      const strategyTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename IN ('ui_strategy_policy_state', 'ui_strategy_policy_history',
                             'ui_strategy_preferences')
         ORDER BY tablename`,
      );
      expect(strategyTables.rows.map((row) => row.tablename)).toEqual([
        "ui_strategy_policy_history",
        "ui_strategy_policy_state",
        "ui_strategy_preferences",
      ]);
      const annotationTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename = 'artifact_annotations'`,
      );
      expect(annotationTables.rows.map((row) => row.tablename)).toEqual([
        "artifact_annotations",
      ]);
      const annotationIntentTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename = 'artifact_annotation_write_intents'`,
      );
      expect(annotationIntentTables.rows.map((row) => row.tablename)).toEqual([
        "artifact_annotation_write_intents",
      ]);
      const bulkIntentTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename = 'artifact_annotation_bulk_write_intents'`,
      );
      expect(bulkIntentTables.rows.map((row) => row.tablename)).toEqual([
        "artifact_annotation_bulk_write_intents",
      ]);
      const coordinationTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename IN ('investigation_coordination',
                             'investigation_coordination_success_intents')
         ORDER BY tablename`,
      );
      expect(coordinationTables.rows.map((row) => row.tablename)).toEqual([
        "investigation_coordination",
        "investigation_coordination_success_intents",
      ]);

      await expect(client.query(`
        INSERT INTO investigation_coordination (
          case_id, coordinator_identity_id, coordinator_username, revision,
          updated_at, updated_by_identity_id, updated_by_username
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'synthetic-holder', NULL, 1,
          CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
        )
      `)).rejects.toThrow(/investigation_coordination_coordinator_pair_check/);
      await expect(client.query(`
        INSERT INTO investigation_coordination (
          case_id, coordinator_identity_id, coordinator_username, revision,
          updated_at, updated_by_identity_id, updated_by_username
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', NULL, 'synthetic-holder', 1,
          CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
        )
      `)).rejects.toThrow(/investigation_coordination_coordinator_pair_check/);
      await expect(client.query(`
        INSERT INTO investigation_coordination (
          case_id, coordinator_identity_id, coordinator_username, revision,
          updated_at, updated_by_identity_id, updated_by_username
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', NULL, NULL, 0,
          CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
        )
      `)).rejects.toThrow(/investigation_coordination_revision_check/);

      await client.query(`
        INSERT INTO investigation_coordination (
          case_id, coordinator_identity_id, coordinator_username, revision,
          updated_at, updated_by_identity_id, updated_by_username
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', NULL, NULL, 1,
          CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
        )
      `);
      await expect(migrateDown(client)).rejects.toThrow(
        /cannot roll back 029_investigation_coordination while coordination data exists/,
      );
      expect((await client.query(
        `SELECT case_id FROM investigation_coordination`,
      )).rows).toEqual([
        { case_id: "11111111-1111-4111-8111-111111111111" },
      ]);
      await client.query(`TRUNCATE TABLE investigation_coordination`);

      await client.query(`
        INSERT INTO investigation_coordination_success_intents (
          case_id, actor_id, idempotency_key, action, target_identity_id,
          success_json, created_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'synthetic-actor',
          'coord-migration-intent', 'claim_self', NULL, '{}', CURRENT_TIMESTAMP
        )
      `);
      await expect(migrateDown(client)).rejects.toThrow(
        /cannot roll back 029_investigation_coordination while coordination data exists/,
      );
      expect((await client.query(
        `SELECT success_json FROM investigation_coordination_success_intents`,
      )).rows).toEqual([{ success_json: "{}" }]);
      await client.query(`TRUNCATE TABLE investigation_coordination_success_intents`);

      expect((await migrateDown(client)).rolledBack).toBe("029_investigation_coordination");
      const coordinationTablesAfterRollback = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename LIKE 'investigation_coordination%'`,
      );
      expect(coordinationTablesAfterRollback.rows).toHaveLength(0);
      await client.query(`
        INSERT INTO user_profiles (
          id, username, display_name, status, provenance, directory_sync_status
        ) VALUES (
          'local:coordination-migration', 'coordination-migration',
          'Coordination migration', 'active', 'local', 'not_synced'
        )
      `);
      await client.query(`
        INSERT INTO user_capability_grants (user_id, capability, granted_by)
        VALUES ('local:coordination-migration', 'investigation:coordinate', 'local:root')
      `);
      await expect(migrateDown(client)).rejects.toThrow(
        /user_capability_grants_capability_check/,
      );
      const preservedV2Grant = await client.query<{ capability: string }>(`
        SELECT capability FROM user_capability_grants
        WHERE user_id = 'local:coordination-migration'
      `);
      expect(preservedV2Grant.rows).toEqual([
        { capability: "investigation:coordinate" },
      ]);
      await client.query(`
        DELETE FROM user_capability_grants
        WHERE user_id = 'local:coordination-migration'
          AND capability = 'investigation:coordinate'
      `);
      expect((await migrateDown(client)).rolledBack).toBe("028_capability_model_v2");
      await expect(client.query(`
        INSERT INTO user_capability_grants (user_id, capability, granted_by)
        VALUES ('local:coordination-migration', 'investigation:coordinate', 'local:root')
      `)).rejects.toThrow(/user_capability_grants_capability_check/);
      expect((await migrateDown(client)).rolledBack).toBe("027_artifact_annotation_bulk_write_intents");
      const bulkIntentTablesAfterRollback = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename = 'artifact_annotation_bulk_write_intents'`,
      );
      expect(bulkIntentTablesAfterRollback.rows).toHaveLength(0);
      expect((await migrateDown(client)).rolledBack).toBe("026_artifact_annotation_write_intents");
      const annotationIntentTablesAfterRollback = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename = 'artifact_annotation_write_intents'`,
      );
      expect(annotationIntentTablesAfterRollback.rows).toHaveLength(0);
      expect((await migrateDown(client)).rolledBack).toBe("025_artifact_annotations");
      expect((await migrateDown(client)).rolledBack).toBe("024_ui_strategy_governance");
      const strategyTablesAfterRollback = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename LIKE 'ui_strategy_%'`,
      );
      expect(strategyTablesAfterRollback.rows).toHaveLength(0);
      // 023 is storage for the case context, then the product migrations
      // unwind before the privilege and record migrations below.
      expect((await migrateDown(client)).rolledBack).toBe("023_investigation_context");
      expect((await migrateDown(client)).rolledBack).toBe("022_software_impact");
      expect((await migrateDown(client)).rolledBack).toBe("021_workbench");
      expect((await migrateDown(client)).rolledBack).toBe("020_model_purpose_policy");
      expect((await migrateDown(client)).rolledBack).toBe("019_experiment_lock_privilege");
      // 018 tables reference cases but
      // nothing in the record graph, so it rolls back independently.
      expect((await migrateDown(client)).rolledBack).toBe("018_log_time");
      const logTimeTables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename IN ('log_corpora', 'log_time_declarations',
                             'log_time_operations', 'log_time_dependents')`,
      );
      expect(logTimeTables.rows).toHaveLength(0);
      const logTimeTrigger = await client.query<{ proname: string }>(
        `SELECT proname FROM pg_proc WHERE proname = 'log_time_dependents_immutable'`,
      );
      expect(logTimeTrigger.rows).toHaveLength(0);
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

  it("excludes concurrent writers from both coordination tables during the rollback guard", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      await client.query(`
        INSERT INTO cases (id, title, severity, status, created_by, created_by_username)
        VALUES (
          '11111111-1111-4111-8111-111111111111',
          'synthetic coordination lock fixture',
          'low', 'open', 'synthetic-actor', 'synthetic-actor'
        )
      `);
      const writer = new Client({ connectionString: url });
      await writer.connect();
      let lockTransactionOpen = false;
      try {
        await writer.query("SET lock_timeout = '100ms'");
        await client.query("BEGIN");
        lockTransactionOpen = true;
        await client.query(
          `LOCK TABLE investigation_coordination_success_intents IN ACCESS EXCLUSIVE MODE`,
        );
        await client.query(
          `LOCK TABLE investigation_coordination IN ACCESS EXCLUSIVE MODE`,
        );

        await expect(writer.query(`
          INSERT INTO investigation_coordination (
            case_id, coordinator_identity_id, coordinator_username, revision,
            updated_at, updated_by_identity_id, updated_by_username
          ) VALUES (
            '11111111-1111-4111-8111-111111111111', NULL, NULL, 1,
            CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
          )
        `)).rejects.toMatchObject({ code: "55P03" });
        await expect(writer.query(`
          INSERT INTO investigation_coordination_success_intents (
            case_id, actor_id, idempotency_key, action, target_identity_id,
            success_json, created_at
          ) VALUES (
            '11111111-1111-4111-8111-111111111111', 'synthetic-actor',
            'coord-lock-intent', 'claim_self', NULL, '{}', CURRENT_TIMESTAMP
          )
        `)).rejects.toMatchObject({ code: "55P03" });

        await client.query("ROLLBACK");
        lockTransactionOpen = false;
        await writer.query(`
          INSERT INTO investigation_coordination (
            case_id, coordinator_identity_id, coordinator_username, revision,
            updated_at, updated_by_identity_id, updated_by_username
          ) VALUES (
            '11111111-1111-4111-8111-111111111111', NULL, NULL, 1,
            CURRENT_TIMESTAMP, 'synthetic-actor', 'synthetic-actor'
          )
        `);
        await expect(migrateDown(client)).rejects.toThrow(
          /cannot roll back 029_investigation_coordination while coordination data exists/,
        );
        expect((await client.query(
          `SELECT case_id FROM investigation_coordination`,
        )).rows).toEqual([
          { case_id: "11111111-1111-4111-8111-111111111111" },
        ]);
      } finally {
        if (lockTransactionOpen) await client.query("ROLLBACK");
        await writer.end();
      }
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
      expect(dry.pending).toContain("018_log_time");
      expect(dry.pending).toContain("019_experiment_lock_privilege");
      expect(dry.pending).toContain("020_model_purpose_policy");
      expect(dry.pending).toContain("021_workbench");
      expect(dry.pending).toContain("022_software_impact");
      expect(dry.pending).toContain("023_investigation_context");
      expect(dry.pending).toContain("024_ui_strategy_governance");
      expect(dry.pending).toContain("025_artifact_annotations");
      expect(dry.pending).toContain("026_artifact_annotation_write_intents");
      expect(dry.pending).toContain("027_artifact_annotation_bulk_write_intents");
      expect(dry.pending).toContain("028_capability_model_v2");
      expect(dry.pending).toContain("029_investigation_coordination");
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
