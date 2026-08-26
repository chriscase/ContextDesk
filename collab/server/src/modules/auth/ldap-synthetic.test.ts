import { describe, expect, it } from "vitest";
import { LdapAuthAdapter } from "./ldap-adapter.js";
import { loadLdapConfig, type LdapConfig } from "./ldap-config.js";
import { DirectoryClaimsUnsafeError } from "./ldap-session.js";
import {
  createSyntheticLdapFactory,
  exampleSyntheticDirectory,
  type SyntheticDirectoryOptions,
} from "./ldap-synthetic.js";
import { createAuthLog } from "./log.js";
import { parseGroupRoleMap, resolveRoles } from "../authz/index.js";

function config(env: NodeJS.ProcessEnv = {}): LdapConfig {
  return loadLdapConfig({
    COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
    COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
    COLLAB_LDAP_USER_SEARCH_FILTER: "(uid={username})",
    COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
    COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
    COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
    COLLAB_LDAP_UPN_SUFFIX: "example.test",
    COLLAB_LDAP_NETBIOS_DOMAIN: "EXAMPLE",
    COLLAB_LDAP_MEMBER_ATTR: "memberOf",
    COLLAB_LDAP_USER_RESOLUTION: "service_bind_search,upn,domain_backslash",
    ...env,
  });
}

function adapter(cfg: LdapConfig, directory: SyntheticDirectoryOptions = exampleSyntheticDirectory()) {
  const log = createAuthLog();
  return {
    log,
    adapter: new LdapAuthAdapter(cfg, log, createSyntheticLdapFactory(cfg, directory)),
  };
}

describe("synthetic LDAP adapter", () => {
  it("authenticates over LDAPS, maps claims, and unions memberOf with group search", async () => {
    const { adapter: ldap, log } = adapter(config());
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    expect(ok?.identity.username).toBe("alice");
    expect(ok?.identity.displayName).toBe("Alice Fixture");
    expect(ok?.directoryFields).toMatchObject({
      displayName: "Alice Fixture",
      contactEmail: "alice@example.test",
      roleTitle: "Contributor",
      team: "Blue team",
    });
    expect(ok?.groups.some((group) => group.toLowerCase().includes("contributors"))).toBe(true);
    expect(log.lines().join("\n")).not.toContain("fixture-alice-secret");
  });

  it("requires StartTLS before bind on ldap://", async () => {
    const cfg = config({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
    });
    const { adapter: ldap } = adapter(cfg);
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    expect(ok?.identity.username).toBe("alice");
  });

  it("authenticates an explicit UPN and DOMAIN\\user against configured values only", async () => {
    const { adapter: ldap } = adapter(config());
    const upn = await ldap.authenticate("alice@example.test", "fixture-alice-secret");
    expect(upn?.identity.username).toBe("alice");
    const domain = await ldap.authenticate("EXAMPLE\\alice", "fixture-alice-secret");
    expect(domain?.identity.username).toBe("alice");
    expect(await ldap.authenticate("alice@other.test", "fixture-alice-secret")).toBeNull();
    expect(await ldap.authenticate("OTHER\\alice", "fixture-alice-secret")).toBeNull();
  });

  it("falls back from UPN to DOMAIN\\user for a plain username", async () => {
    const { adapter: ldap } = adapter(
      config({
        COLLAB_LDAP_USER_RESOLUTION: "upn,domain_backslash",
      }),
    );
    const ok = await ldap.authenticate("samonly", "fixture-sam-secret");
    expect(ok?.identity.username).toBe("samonly");
  });

  it("authenticates with a DN template, including the {0} username alias", async () => {
    const cfg = config({
      COLLAB_LDAP_USER_DN_TEMPLATE: "uid={0},ou=people,dc=example,dc=test",
      COLLAB_LDAP_USER_RESOLUTION: "dn_template",
    });
    const { adapter: ldap } = adapter(cfg);
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    expect(ok?.identity.username).toBe("alice");
    expect(await ldap.authenticate("EXAMPLE\\alice@example.test", "fixture-alice-secret")).toBeNull();
  });

  it("uses memberOf when group search is unavailable", async () => {
    const cfg = config();
    cfg.groupSearchBase = undefined;
    const { adapter: ldap } = adapter(cfg);
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    expect(ok?.groups.some((group) => group.toLowerCase().includes("contributors"))).toBe(true);
  });

  it("returns null for bad credentials without logging the secret", async () => {
    const { adapter: ldap, log } = adapter(config());
    const secret = "fixture-wrong-secret";
    expect(await ldap.authenticate("alice", secret)).toBeNull();
    expect(log.lines().join("\n")).not.toContain(secret);
  });

  it("refuses an ambiguous user search", async () => {
    const { adapter: ldap } = adapter(config());
    expect(await ldap.authenticate("dups", "fixture-dups-secret")).toBeNull();
  });

  it("treats missing optional attributes as skipped rather than inventing values", async () => {
    const { adapter: ldap } = adapter(config());
    const ok = await ldap.authenticate("bob", "fixture-bob-secret");
    expect(ok?.directoryFields?.displayName).toBe("Bob Fixture");
    expect(ok?.directoryFields?.contactEmail).toBeUndefined();
    expect(ok?.directoryFields?.roleTitle).toBeUndefined();
  });

  it("throws when directory claims are unsafe", async () => {
    const { adapter: ldap } = adapter(config());
    await expect(ldap.authenticate("unsafe", "fixture-unsafe-secret")).rejects.toBeInstanceOf(
      DirectoryClaimsUnsafeError,
    );
  });

  it("fails TLS verification against an untrusted certificate", async () => {
    const cfg = config();
    const directory = { ...exampleSyntheticDirectory(), untrustedCertificate: true };
    const { adapter: ldap } = adapter(cfg, directory);
    expect(await ldap.authenticate("alice", "fixture-alice-secret")).toBeNull();
  });

  it("fails closed on a directory timeout", async () => {
    const cfg = config({ COLLAB_LDAP_TIMEOUT_MS: "100" });
    const directory = { ...exampleSyntheticDirectory(), forceTimeout: true };
    const { adapter: ldap } = adapter(cfg, directory);
    expect(await ldap.authenticate("alice", "fixture-alice-secret")).toBeNull();
  });

  it("continues with memberOf when group search is inaccessible to the user bind", async () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
      COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
      COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
      COLLAB_LDAP_USER_RESOLUTION: "dn_template",
    });
    const directory = exampleSyntheticDirectory();
    delete directory.service;
    const { adapter: ldap } = adapter(cfg, directory);
    const alice = await ldap.authenticate("alice", "fixture-alice-secret");
    expect(alice?.groups.some((group) => group.toLowerCase().includes("contributors"))).toBe(true);
    const bob = await ldap.authenticate("bob", "fixture-bob-secret");
    expect(bob?.groups.some((group) => group.toLowerCase().includes("unmapped"))).toBe(true);
  });
});

describe("LDAP group resolution scope (documented non-claim)", () => {
  const GROUP_BASE = "ou=groups,dc=example,dc=test";

  /**
   * `cn=engineering` in the fixture has `cn=contributors` as its member, so
   * alice is a *transitive* member of engineering through contributors.
   *
   * ContextDesk resolves direct membership only - the memberOf attribute plus
   * one `(member={dn})` search keyed on the user's own DN. It does not walk a
   * group-of-groups chain and does not send an AD in-chain matching rule. This
   * test pins that boundary so a nested-group deployment cannot quietly assume
   * a role it was never granted, and so the limit is a tested statement rather
   * than an undocumented gap.
   */
  it("resolves direct membership and does not walk a nested group chain", async () => {
    const { adapter: ldap } = adapter(config());
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    const groups = (ok?.groups ?? []).map((group) => group.toLowerCase());

    expect(groups).toContain(`cn=contributors,${GROUP_BASE}`);
    expect(groups).not.toContain(`cn=engineering,${GROUP_BASE}`);
    expect(groups.some((group) => group.includes("engineering"))).toBe(false);
  });

  it("maps roles only from the directly-resolved groups", async () => {
    const { adapter: ldap } = adapter(config());
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    const mapping = parseGroupRoleMap(
      `cn=engineering,${GROUP_BASE}=admin;cn=contributors,${GROUP_BASE}=contributor`,
    );

    // The parent group carries "admin" in this map. Because membership is not
    // walked transitively, alice must resolve to contributor only.
    expect(resolveRoles(ok?.groups ?? [], mapping)).toEqual(["contributor"]);
  });

  it("does not expose a nested parent group through live group lookup either", async () => {
    const { adapter: ldap } = adapter(config());
    const ok = await ldap.authenticate("alice", "fixture-alice-secret");
    const live = await ldap.lookupGroups(ok!.identity);
    expect(live.some((group) => group.toLowerCase().includes("engineering"))).toBe(false);
    expect(live.some((group) => group.toLowerCase().includes("contributors"))).toBe(true);
  });
});
