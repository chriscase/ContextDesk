import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdapAuthAdapter } from "./ldap-adapter.js";
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
