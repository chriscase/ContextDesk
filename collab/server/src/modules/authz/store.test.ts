import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { parseGroupRoleMap } from "./roles.js";
import { PgGroupRoleStore } from "./store.js";

describe.skipIf(!adminUrl())("PostgreSQL group-role map", () => {
  it("loads persisted changes and keeps a revoke across a new store", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const group = "cn=temporary,ou=groups,dc=example,dc=test";
      const bootstrap = parseGroupRoleMap(
        "cn=contributors,ou=groups,dc=example,dc=test=contributor",
      );
      const first = new PgGroupRoleStore(client, bootstrap);

      expect((await first.load()).entries.get("cn=contributors,ou=groups,dc=example,dc=test")).toBe(
        "contributor",
      );
      await first.set(group, "admin", "uid=alice,ou=people,dc=example,dc=test");

      const second = new PgGroupRoleStore(client, bootstrap);
      expect((await second.load()).entries.get(group)).toBe("admin");
      expect(
        (await client.query<{ updated_by: string }>(
          "SELECT updated_by FROM authz_group_role_map WHERE group_dn = $1",
          [group],
        )).rows[0]?.updated_by,
      ).toBe("uid=alice,ou=people,dc=example,dc=test");

      expect(await second.delete(group)).toBe(true);
      const afterRevoke = new PgGroupRoleStore(client, bootstrap);
      const loaded = await afterRevoke.load();
      expect(loaded.entries.has(group)).toBe(false);
      expect(loaded.entries.has("cn=contributors,ou=groups,dc=example,dc=test")).toBe(true);
    });
  });
});
