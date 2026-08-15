import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";

describe.skipIf(!adminUrl())("contribution revisions insert-only", () => {
  it("rejects UPDATE/DELETE of contribution content under the app DB role", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);
      const dbName = (
        await admin.query<{ current_database: string }>("SELECT current_database()")
      ).rows[0]?.current_database;
      if (!dbName) throw new Error("missing database name");
      await admin.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
            CREATE ROLE collab_app LOGIN PASSWORD 'fixture-app-role';
          ELSE
            ALTER ROLE collab_app LOGIN PASSWORD 'fixture-app-role';
          END IF;
        END $$;
      `);
      await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO collab_app`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO collab_app`);
      await admin.query(`
        GRANT SELECT, INSERT, UPDATE ON TABLE cases TO collab_app;
        GRANT SELECT, INSERT ON TABLE contributions TO collab_app;
        GRANT SELECT, INSERT ON TABLE contribution_revisions TO collab_app;
        REVOKE UPDATE, DELETE ON TABLE contribution_revisions FROM collab_app;
        REVOKE UPDATE, DELETE ON TABLE contributions FROM collab_app;
      `);

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
      await admin.query(`
        INSERT INTO contributions (id, case_id, kind, privacy_class, created_by, created_by_username)
        VALUES (
          '22222222-2222-2222-2222-222222222222',
          '11111111-1111-1111-1111-111111111111',
          'note',
          'owner_only',
          'uid=alice,ou=people,dc=example,dc=test',
          'alice'
        )
      `);
      await admin.query(`
        INSERT INTO contribution_revisions (
          contribution_id, revision, author_id, author_username, body, content_hash
        ) VALUES (
          '22222222-2222-2222-2222-222222222222',
          1,
          'uid=alice,ou=people,dc=example,dc=test',
          'alice',
          'original note',
          'abc'
        )
      `);

      const appUrl = new URL(url);
      appUrl.username = "collab_app";
      appUrl.password = "fixture-app-role";
      const appClient = new Client({ connectionString: appUrl.toString() });

      const assertImmutable = async (client: Client) => {
        await expect(
          client.query(
            `UPDATE contribution_revisions SET body = 'tamper' WHERE contribution_id = $1`,
            ["22222222-2222-2222-2222-222222222222"],
          ),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(
          client.query(`DELETE FROM contribution_revisions WHERE contribution_id = $1`, [
            "22222222-2222-2222-2222-222222222222",
          ]),
        ).rejects.toThrow(/insert-only|permission denied/);
        const kept = await client.query<{ body: string }>(
          `SELECT body FROM contribution_revisions WHERE contribution_id = $1`,
          ["22222222-2222-2222-2222-222222222222"],
        );
        expect(kept.rows[0]?.body).toBe("original note");
      };

      await appClient.connect();
      try {
        await assertImmutable(appClient);
      } finally {
        await appClient.end();
      }
    });
  });
});
