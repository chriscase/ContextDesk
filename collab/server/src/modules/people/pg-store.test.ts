import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import {
  assertFieldUpdateContract,
  assertListContract,
  assertLoginSyncContract,
} from "./store.contract-tests.js";
import { PgUserProfileStore } from "./store.js";

describe.skipIf(!adminUrl())("PgUserProfileStore", () => {
  it("satisfies the same contract as the memory store against a migrated database", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      const store = new PgUserProfileStore(client);
      await assertLoginSyncContract(store);
      await assertFieldUpdateContract(store);
      await assertListContract(store);
    });
  });

  it("enforces case-insensitive username uniqueness at the database layer", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      await client.query(
        `INSERT INTO user_profiles (id, username, display_name, status, provenance, directory_sync_status)
         VALUES ('local:alice', 'alice', 'Alice', 'active', 'local', 'not_synced')`,
      );
      await expect(
        client.query(
          `INSERT INTO user_profiles (id, username, display_name, status, provenance, directory_sync_status)
           VALUES ('local:ALICE-2', 'ALICE', 'Alice Again', 'active', 'local', 'not_synced')`,
        ),
      ).rejects.toThrow(/user_profiles_username_lower_idx|duplicate key/);
    });
  });

  it("requires a directory subject for ldap/oidc provenance at the database layer", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      await expect(
        client.query(
          `INSERT INTO user_profiles (id, username, display_name, status, provenance, directory_sync_status)
           VALUES ('bad-ldap', 'noldapdn', 'No DN', 'active', 'ldap', 'not_synced')`,
        ),
      ).rejects.toThrow(/user_profiles_directory_subject_required/);
    });
  });

  it("persists and round-trips custom attributes as JSONB", async () => {
    await withDisposableDb(async (client: Client) => {
      await migrateUp(client);
      const store = new PgUserProfileStore(client);
      const created = await store.touchOnLogin({
        id: "local:ivan",
        username: "ivan",
        displayName: "Ivan",
        provenance: "local",
        directorySubject: null,
      });
      if (created.outcome !== "ok") throw new Error("setup failed");
      const updated = await store.updateFields(
        "local:ivan",
        { customAttributes: [{ key: "pager", value: "+1-555-0100" }] },
        created.profile.revision,
      );
      expect(updated.outcome).toBe("ok");
      if (updated.outcome !== "ok") return;
      expect(updated.profile.customAttributes).toEqual([{ key: "pager", value: "+1-555-0100" }]);

      const reread = await store.getById("local:ivan");
      expect(reread?.customAttributes).toEqual([{ key: "pager", value: "+1-555-0100" }]);
    });
  });
});
