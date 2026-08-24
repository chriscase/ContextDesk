import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { adminUrl, appRoleUrl, withDisposableDb } from "../test/disposable-db.js";
import { migrateUp } from "./migrate.js";

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/workflows/collab.yml",
);

describe("hosted least-privilege pin", () => {
  it("fails closed if collab.yml drops the collab_app role", () => {
    const yml = readFileSync(workflowPath, "utf8");
    expect(yml).toMatch(/CREATE ROLE collab_app/);
    expect(yml).toMatch(/COLLAB_DATABASE_URL: postgres:\/\/collab_app:/);
    expect(yml).toMatch(/COLLAB_MIGRATE_DATABASE_URL: postgres:\/\/postgres:/);
    expect(yml).toMatch(/COLLAB_TEST_ADMIN_URL: postgres:\/\/postgres:/);
  });

  it("builds the app-role URL without inheriting the admin password", () => {
    const url = appRoleUrl("postgres://postgres:postgres@127.0.0.1:5432/collab_ci");
    expect(url).toContain("://collab_app:fixture-app-role@127.0.0.1:5432/collab_ci");
    expect(url).not.toContain("postgres:postgres");
  });
});

describe.skipIf(!adminUrl())("PostgreSQL least-privilege grants", () => {
  it("exercises migration GRANTs as collab_app, not postgres", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);
      const app = new Client({ connectionString: appRoleUrl(url) });
      await app.connect();
      try {
        const who = await app.query<{ current_user: string }>("SELECT current_user");
        expect(who.rows[0]?.current_user).toBe("collab_app");

        await app.query(
          `INSERT INTO audit_events (identity, action, target, origin, outcome)
           VALUES ($1, $2, $3, $4, $5)`,
          ["uid=alice,ou=people,dc=example,dc=test", "mutation", "probe", "127.0.0.1", "success"],
        );
        await expect(
          app.query(`UPDATE audit_events SET action = 'tamper'`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(app.query(`DELETE FROM audit_events`)).rejects.toThrow(
          /insert-only|permission denied/,
        );

        await admin.query(`
          INSERT INTO cases (id, title, severity, status, created_by, created_by_username)
          VALUES (
            '11111111-1111-1111-1111-111111111111',
            'fixture',
            'low',
            'open',
            'uid=alice,ou=people,dc=example,dc=test',
            'alice'
          )
        `);
        await app.query(
          `INSERT INTO timeline_events (case_id, seq, kind, actor_id, actor_username, payload)
           VALUES ($1, 1, 'case_created', $2, 'alice', '{}'::jsonb)`,
          ["11111111-1111-1111-1111-111111111111", "uid=alice,ou=people,dc=example,dc=test"],
        );
        await expect(
          app.query(`UPDATE timeline_events SET kind = 'tamper'`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await app.query(
          `INSERT INTO evidence_intake_batches (
             id, case_id, idempotency_key, request_digest, origin, source_label,
             privacy_class, created_by, payload_json
           ) VALUES ($1, $2, $3, $4, 'files', 'synthetic source', 'owner_only', $5, '{}')`,
          [
            "22222222-2222-4222-8222-222222222222",
            "11111111-1111-1111-1111-111111111111",
            "batch-synthetic-grant",
            "a".repeat(64),
            "uid=alice,ou=people,dc=example,dc=test",
          ],
        );
        await expect(
          app.query(`UPDATE evidence_intake_batches SET source_label = 'tamper'`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(app.query(`DELETE FROM evidence_intake_batches`)).rejects.toThrow(
          /insert-only|permission denied/,
        );
        await app.query(
          `INSERT INTO portable_apply_intents (
             token_hash, actor_id, installation_id, transport_hash, semantic_fingerprint,
             destination_catalog_digest, identity_map_digest, materialized_content_digest,
             collision_policy, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'remap_deterministic', $9)`,
          [
            "11".repeat(32),
            "actor-synthetic-north",
            "inst-synthetic-north",
            "22".repeat(32),
            "33".repeat(32),
            "44".repeat(32),
            "55".repeat(32),
            "66".repeat(32),
            "2042-03-04T12:10:00.000Z",
          ],
        );
        await app.query(
          `UPDATE portable_apply_intents
           SET applied_investigation_id = $2, applied_at = CURRENT_TIMESTAMP
           WHERE token_hash = $1`,
          ["11".repeat(32), "11111111-1111-1111-1111-111111111111"],
        );
        await expect(app.query(`DELETE FROM portable_apply_intents`)).rejects.toThrow(
          /permission denied/,
        );
        await app.query(
          `INSERT INTO authz_group_role_map (group_dn, role, updated_by)
           VALUES ($1, $2, $3)`,
          ["cn=temporary,ou=groups,dc=example,dc=test", "viewer", "collab_app"],
        );
        const deleted = await app.query(
          `DELETE FROM authz_group_role_map WHERE group_dn = $1`,
          ["cn=temporary,ou=groups,dc=example,dc=test"],
        );
        expect(deleted.rowCount).toBe(1);
        await app.query(
          `INSERT INTO experiment_packages (
            id, case_id, package_id, source_schema_id, task_fingerprint, snapshot_fingerprint,
            candidates, agreement, importer_id, importer_username
          ) VALUES (
            '33333333-3333-3333-3333-333333333333',
            '11111111-1111-1111-1111-111111111111',
            'pkg-fixture',
            'cd-collab.experiment_summary.v1',
            'task-f',
            'snap-f',
            '[]'::jsonb,
            '{"sharedAnchors":[],"candidateSpecific":[],"roleConflicts":[],"notes":["Agreement is not proof of correctness."]}'::jsonb,
            'uid=alice,ou=people,dc=example,dc=test',
            'alice'
          )`,
        );
        await expect(
          app.query(`UPDATE experiment_packages SET package_id = 'tamper'`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await app.query(
          `INSERT INTO gold_references (gold_id, experiment_id, version, payload)
           VALUES (
             '44444444-4444-4444-4444-444444444444',
             '33333333-3333-3333-3333-333333333333',
             1,
             '{"schemaId":"cd-collab.gold_reference.v1"}'::jsonb
           )`,
        );
        await expect(
          app.query(`UPDATE gold_references SET version = 2`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await app.query(
          `INSERT INTO experiment_traces (id, experiment_id, candidate_id, fingerprint, payload)
           VALUES (
             '55555555-5555-5555-5555-555555555555',
             '33333333-3333-3333-3333-333333333333',
             'cand-fixture',
             'fp',
             '{"schemaId":"cd-collab.interaction_trace.v1"}'::jsonb
           )`,
        );
        await expect(
          app.query(`UPDATE experiment_traces SET fingerprint = 'tamper'`),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(app.query(`CREATE TABLE collab_app_should_not (id int)`)).rejects.toThrow(
          /permission denied/,
        );

        const listed = await app.query<{ action: string }>(
          `SELECT action FROM audit_events WHERE action = 'mutation'`,
        );
        expect(listed.rows).toHaveLength(1);
      } finally {
        await app.end();
      }
    });
  });
});
