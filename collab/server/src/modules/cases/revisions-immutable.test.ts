import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, appRoleUrl, withDisposableDb } from "../../test/disposable-db.js";

describe.skipIf(!adminUrl())("contribution revisions insert-only", () => {
  it("rejects UPDATE/DELETE of contribution content under the app DB role", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);

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

      const appClient = new Client({ connectionString: appRoleUrl(url) });
      await appClient.connect();
      try {
        const who = await appClient.query<{ current_user: string }>("SELECT current_user");
        expect(who.rows[0]?.current_user).toBe("collab_app");
        await expect(
          appClient.query(
            `UPDATE contribution_revisions SET body = 'tamper' WHERE contribution_id = $1`,
            ["22222222-2222-2222-2222-222222222222"],
          ),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(
          appClient.query(`DELETE FROM contribution_revisions WHERE contribution_id = $1`, [
            "22222222-2222-2222-2222-222222222222",
          ]),
        ).rejects.toThrow(/insert-only|permission denied/);
        const kept = await appClient.query<{ body: string }>(
          `SELECT body FROM contribution_revisions WHERE contribution_id = $1`,
          ["22222222-2222-2222-2222-222222222222"],
        );
        expect(kept.rows[0]?.body).toBe("original note");
      } finally {
        await appClient.end();
      }
    });
  });
});
