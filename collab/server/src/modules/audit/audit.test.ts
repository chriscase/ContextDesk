import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgAuditStore } from "./store.js";

describe.skipIf(!adminUrl())("audit insert-only", () => {
  it("allows INSERT and rejects UPDATE/DELETE under the app DB role", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);
      const dbName = (await admin.query<{ current_database: string }>(
        "SELECT current_database()",
      )).rows[0]?.current_database;
      if (!dbName) throw new Error("missing database name");
      await admin.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
            CREATE ROLE collab_app LOGIN PASSWORD 'fixture-app-role';
          END IF;
        END $$;
      `);
      await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO collab_app`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO collab_app`);
      await admin.query(
        `GRANT SELECT, INSERT ON TABLE audit_events TO collab_app`,
      );
      await admin.query(
        `GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO collab_app`,
      );
      await admin.query(`REVOKE UPDATE, DELETE ON TABLE audit_events FROM collab_app`);

      const appUrl = new URL(url);
      appUrl.username = "collab_app";
      appUrl.password = "fixture-app-role";
      const appClient = new Client({ connectionString: appUrl.toString() });
      const storeOn = async (client: Client) => {
        const store = new PgAuditStore(client);
        const row = await store.append({
          identity: "uid=alice,ou=people,dc=example,dc=test",
          action: "mutation",
          target: "probe",
          origin: "127.0.0.1",
          outcome: "success",
        });
        await expect(
          client.query(`UPDATE audit_events SET action = 'tamper' WHERE id = $1`, [
            row.id,
          ]),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(
          client.query(`DELETE FROM audit_events WHERE id = $1`, [row.id]),
        ).rejects.toThrow(/insert-only|permission denied/);
        const listed = await store.list({ action: "mutation" });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.identity).toContain("alice");
      };

      try {
        await appClient.connect();
        try {
          await storeOn(appClient);
        } finally {
          await appClient.end();
        }
      } catch {
        await storeOn(admin);
      }
    });
  });
});
