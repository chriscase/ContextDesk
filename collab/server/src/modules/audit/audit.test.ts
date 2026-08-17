import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, appRoleUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgAuditStore } from "./store.js";

describe.skipIf(!adminUrl())("audit insert-only", () => {
  it("allows INSERT and rejects UPDATE/DELETE under the app DB role", async () => {
    await withDisposableDb(async (admin, url) => {
      await migrateUp(admin);
      const appClient = new Client({ connectionString: appRoleUrl(url) });
      await appClient.connect();
      try {
        const who = await appClient.query<{ current_user: string }>("SELECT current_user");
        expect(who.rows[0]?.current_user).toBe("collab_app");
        const store = new PgAuditStore(appClient);
        const row = await store.append({
          identity: "uid=alice,ou=people,dc=example,dc=test",
          action: "mutation",
          target: "probe",
          origin: "127.0.0.1",
          outcome: "success",
        });
        await expect(
          appClient.query(`UPDATE audit_events SET action = 'tamper' WHERE id = $1`, [row.id]),
        ).rejects.toThrow(/insert-only|permission denied/);
        await expect(
          appClient.query(`DELETE FROM audit_events WHERE id = $1`, [row.id]),
        ).rejects.toThrow(/insert-only|permission denied/);
        const listed = await store.list({ action: "mutation" });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.identity).toContain("alice");
      } finally {
        await appClient.end();
      }
    });
  });
});
