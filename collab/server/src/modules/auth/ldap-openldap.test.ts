import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LdapAuthAdapter,
  directoryGroupFilter,
  directoryIdentityFilter,
} from "./ldap-adapter.js";
import { loadLdapConfig } from "./ldap-config.js";
import { liveLdapConfigured, missingRequiredLiveLdapEnv } from "./ldap-coverage.js";
import { createAuthLog } from "./log.js";

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../.github/workflows/collab.yml",
);

describe("hosted OpenLDAP coverage pin", () => {
  it("fails closed if collab.yml drops the live directory configuration", () => {
    const yml = readFileSync(workflowPath, "utf8");
    expect(yml).toMatch(/COLLAB_REQUIRE_LDAP:\s*"1"/);
    expect(yml).toMatch(/COLLAB_LDAP_URL:/);
    expect(yml).toMatch(/COLLAB_LDAP_STARTTLS:\s*"1"/);
    expect(yml).toMatch(/COLLAB_LDAP_BIND_DN:/);
    expect(yml).toMatch(/COLLAB_LDAP_USER_DN_TEMPLATE:/);
    expect(yml).toMatch(/COLLAB_LDAP_GROUP_SEARCH_BASE:/);
  });
});

describe("LDAP administrative directory filters", () => {
  it("escapes assertion values before adding a server-owned prefix wildcard", () => {
    expect(directoryIdentityFilter("a*)(uid=*)")).toBe(
      "(&(objectClass=person)(|(uid=a\\2a\\29\\28uid=\\2a\\29*)(cn=a\\2a\\29\\28uid=\\2a\\29*)(displayName=a\\2a\\29\\28uid=\\2a\\29*)))",
    );
    expect(directoryGroupFilter("ad*(member=*)")).toBe(
      "(&(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=group)(objectClass=posixGroup))" +
        "(cn=ad\\2a\\28member=\\2a\\29*))",
    );
  });
});

const configured = liveLdapConfigured();

describe.skipIf(!configured)("OpenLDAP fixture (encrypted)", () => {
  it("binds a mapped fixture user over encrypted transport", async () => {
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(loadLdapConfig(), log);
    const ok = await adapter.authenticate(
      process.env.COLLAB_LDAP_FIXTURE_USER ?? "alice",
      process.env.COLLAB_LDAP_FIXTURE_PASSWORD ?? "fixture-alice-secret",
    );
    expect(ok, log.lines().join(" | ")).not.toBeNull();
    expect(ok?.identity.username).toBe(
      process.env.COLLAB_LDAP_FIXTURE_USER ?? "alice",
    );
    expect(ok?.groups.some((g) => g.toLowerCase().includes("contributors"))).toBe(
      true,
    );
    expect(log.lines().join("\n")).not.toContain("fixture-alice-secret");
    const live = await adapter.lookupGroups(ok!.identity);
    expect(live.some((g) => g.toLowerCase().includes("contributors"))).toBe(true);
  });

  it("returns null for a wrong password without logging it", async () => {
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(loadLdapConfig(), log);
    const secret = "fixture-wrong-secret";
    const result = await adapter.authenticate("alice", secret);
    expect(result).toBeNull();
    expect(log.lines().join("\n")).not.toContain(secret);
  });

  it("service-searches only projected identity and group attributes", async () => {
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(loadLdapConfig(), log);
    const identities = await adapter.searchIdentities("ali", {
      limit: 20,
      timeoutMs: 3_000,
    });
    expect(identities).toContainEqual({
      id: "uid=alice,ou=people,dc=example,dc=test",
      username: "alice",
      displayName: "Alice",
      source: "ldap",
    });
    const groups = await adapter.searchDirectoryGroups("adm", {
      limit: 20,
      timeoutMs: 3_000,
    });
    expect(groups).toContainEqual({
      dn: "cn=admins,ou=groups,dc=example,dc=test",
      name: "admins",
      source: "ldap",
    });
    expect(JSON.stringify({ identities, groups })).not.toMatch(/member|password/i);
  });
});

describe.skipIf(!configured)("OpenLDAP certificate verification", () => {
  it("fails closed when the fixture certificate is not trusted", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.COLLAB_LDAP_TLS_INSECURE;
    delete env.COLLAB_LDAP_DEV_MODE;
    const cfg = loadLdapConfig(env);
    expect(cfg.verifyTls).toBe(true);
    const log = createAuthLog();
    const adapter = new LdapAuthAdapter(cfg, log);
    const ok = await adapter.authenticate(
      process.env.COLLAB_LDAP_FIXTURE_USER ?? "alice",
      process.env.COLLAB_LDAP_FIXTURE_PASSWORD ?? "fixture-alice-secret",
    );
    expect(ok).toBeNull();
    const blob = log.lines().join("\n");
    expect(blob).toMatch(/cert|tls|ssl|self-signed|unable to verify|untrusted/i);
    expect(blob).not.toContain("fixture-alice-secret");
    expect(missingRequiredLiveLdapEnv()).toEqual([]);
  });
});
