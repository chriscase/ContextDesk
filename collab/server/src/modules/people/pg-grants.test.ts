import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgLocalGrantStore } from "./grants.js";
import { PgUserProfileStore } from "./store.js";

describe.skipIf(!adminUrl())("PgLocalGrantStore", () => {
  it("is idempotent at the database layer via ON CONFLICT DO NOTHING", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      const profiles = new PgUserProfileStore(client);
      await profiles.touchOnLogin({
        id: "local:grantee",
        username: "grantee",
        displayName: "Grantee",
        provenance: "local",
        directorySubject: null,
      });
      const grants = new PgLocalGrantStore(client);
      expect(await grants.grant("local:grantee", "admin:users", "local:root")).toBe("granted");
      expect(await grants.grant("local:grantee", "admin:users", "local:root")).toBe("already_granted");
      expect(await grants.revoke("local:grantee", "admin:users")).toBe("revoked");
      expect(await grants.revoke("local:grantee", "admin:users")).toBe("not_granted");
    });
  });

  it("cascades grant deletion when the owning profile row is deleted", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      await client.query(
        `INSERT INTO user_profiles (id, username, display_name, status, provenance, directory_sync_status)
         VALUES ('local:temp', 'temp', 'Temp', 'active', 'local', 'not_synced')`,
      );
      const grants = new PgLocalGrantStore(client);
      await grants.grant("local:temp", "export:create", "local:root");
      await client.query(`DELETE FROM user_profiles WHERE id = 'local:temp'`);
      expect(await grants.list("local:temp")).toEqual([]);
    });
  });
});
