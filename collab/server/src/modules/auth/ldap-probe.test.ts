import { describe, expect, it } from "vitest";
import { loadLdapConfig } from "./ldap-config.js";
import { probeLdap } from "./ldap-probe.js";
import { createSyntheticLdapFactory, exampleSyntheticDirectory } from "./ldap-synthetic.js";

const mapped = {
  "cn=contributors,ou=groups,dc=example,dc=test": "contributor" as const,
};

function resolveRoles(groups: readonly string[]) {
  return groups
    .map((group) => mapped[group.toLowerCase() as keyof typeof mapped])
    .filter((role): role is "contributor" => role !== undefined);
}

describe("LDAP probe stages", () => {
  it("reports skipped stages for local authentication", async () => {
    const report = await probeLdap({
      config: null,
      authMode: "local",
      probeUsername: "alice",
      probePassword: "fixture-alice-secret",
      resolveRoles,
      roleMapConfigured: true,
    });
    expect(report.ready).toBe(true);
    expect(report.stages.every((stage) => stage.status === "skipped")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fixture-alice-secret");
  });

  it("distinguishes transport, bind, user search, groups, and role map", async () => {
    const config = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
      COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
      COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
      COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
      COLLAB_LDAP_UPN_SUFFIX: "example.test",
      COLLAB_LDAP_NETBIOS_DOMAIN: "EXAMPLE",
      COLLAB_LDAP_MEMBER_ATTR: "memberOf",
    });
    const report = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: "alice",
      probePassword: "fixture-alice-secret",
      resolveRoles,
      roleMapConfigured: true,
      sessions: createSyntheticLdapFactory(config, exampleSyntheticDirectory()),
    });
    expect(report.ready).toBe(true);
    expect(report.stages.map((stage) => stage.id)).toEqual([
      "transport",
      "service_bind",
      "user_search",
      "group_lookup",
      "role_map",
    ]);
    expect(report.stages.every((stage) => stage.status === "passed")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("fixture-alice-secret");
    expect(JSON.stringify(report)).not.toContain("fixture-service-secret");
  });

  it("fails TLS, timeout, bad probe credentials, and authorization denial honestly", async () => {
    const config = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
      COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
      COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
      COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
    });
    const tls = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: null,
      probePassword: null,
      resolveRoles,
      roleMapConfigured: true,
      sessions: createSyntheticLdapFactory(config, {
        ...exampleSyntheticDirectory(),
        untrustedCertificate: true,
      }),
    });
    expect(tls.stages[0]?.status).toBe("failed");
    expect(tls.stages[0]?.detail).toMatch(/TLS/);

    const timeout = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: null,
      probePassword: null,
      resolveRoles,
      roleMapConfigured: true,
      sessions: createSyntheticLdapFactory(config, {
        ...exampleSyntheticDirectory(),
        forceTimeout: true,
      }),
    });
    expect(timeout.stages[0]?.status).toBe("failed");
    expect(timeout.stages[0]?.detail).toMatch(/timed out/i);

    const bad = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: "alice",
      probePassword: "fixture-wrong-secret",
      resolveRoles,
      roleMapConfigured: true,
      sessions: createSyntheticLdapFactory(config, exampleSyntheticDirectory()),
    });
    expect(bad.stages.find((stage) => stage.id === "user_search")?.status).toBe("failed");
    expect(JSON.stringify(bad)).not.toContain("fixture-wrong-secret");

    const denied = await probeLdap({
      config,
      authMode: "ldap",
      probeUsername: "bob",
      probePassword: "fixture-bob-secret",
      resolveRoles,
      roleMapConfigured: true,
      sessions: createSyntheticLdapFactory(config, exampleSyntheticDirectory()),
    });
    expect(denied.stages.find((stage) => stage.id === "role_map")?.status).toBe("failed");
  });
});
