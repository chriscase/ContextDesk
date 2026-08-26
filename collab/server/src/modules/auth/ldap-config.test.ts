import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ldapClientOptions, ldapTlsOptions } from "./ldap-adapter.js";
import { loadLdapConfig, publicLdapConfig } from "./ldap-config.js";
import { liveLdapConfigured } from "./ldap-coverage.js";
import { escapeDn, escapeFilter, interpolate } from "./ldap-escape.js";

const identityEnv = {
  COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
};

describe("LDAP config", () => {
  it("refuses plaintext ldap:// without StartTLS", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      }),
    ).toThrow(/plaintext LDAP refused/);
  });

  it("refuses credentials, query, or fragment in the directory URL", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://user:pass@directory.example.test:636",
        ...identityEnv,
      }),
    ).toThrow(/must not carry credentials/);
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636?debug=1",
        ...identityEnv,
      }),
    ).toThrow(/must not carry credentials/);
  });

  it("accepts ldaps://", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      ...identityEnv,
    });
    expect(cfg.url).toMatch(/^ldaps:/);
    expect(cfg.verifyTls).toBe(true);
  });

  it("accepts ldap:// only with StartTLS", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
      ...identityEnv,
    });
    expect(cfg.starttls).toBe(true);
  });

  it("omits constructor tlsOptions so StartTLS can upgrade a plaintext socket", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
      ...identityEnv,
    });
    expect(ldapClientOptions(cfg).tlsOptions).toBeUndefined();
    expect(ldapTlsOptions(cfg).rejectUnauthorized).toBe(true);
  });

  it("uses insecure fixture TLS options that Node can negotiate with osixia", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://127.0.0.1:636",
      COLLAB_LDAP_TLS_INSECURE: "1",
      COLLAB_LDAP_DEV_MODE: "1",
      ...identityEnv,
    });
    const tls = ldapClientOptions(cfg).tlsOptions;
    expect(tls?.rejectUnauthorized).toBe(false);
    expect(tls?.ecdhCurve).toBe("auto");
    expect(tls && "ca" in tls).toBe(false);
  });

  it("rebinds with the service account before group search after a user bind", () => {
    const src = readFileSync(new URL("./ldap-adapter.ts", import.meta.url), "utf8");
    const groupFn = src.slice(src.indexOf("private async searchGroups"));
    expect(groupFn).toMatch(/this\.config\.bindDn && this\.config\.bindPassword/);
    expect(groupFn).toMatch(/client\.bind\(this\.config\.bindDn, this\.config\.bindPassword\)/);
    expect(src.indexOf("await client.bind(dn, password)")).toBeLessThan(
      src.indexOf("await this.searchGroups(client, dn)"),
    );
  });

  it("loads the optional service-bind used for group lookup", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldap://directory.example.test:389",
      COLLAB_LDAP_STARTTLS: "1",
      COLLAB_LDAP_BIND_DN: "cn=admin,dc=example,dc=test",
      COLLAB_LDAP_BIND_PASSWORD: "fixture-admin-secret",
      ...identityEnv,
    });
    expect(cfg.bindDn).toBe("cn=admin,dc=example,dc=test");
    expect(cfg.bindPassword).toBe("fixture-admin-secret");
  });

  it("refuses TLS verification disable without explicit dev mode", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_TLS_INSECURE: "1",
      }),
    ).toThrow(/COLLAB_LDAP_DEV_MODE/);
  });

  it("verified TLS options keep certificate checking enabled", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      ...identityEnv,
    });
    expect(cfg.verifyTls).toBe(true);
    expect(ldapTlsOptions(cfg).rejectUnauthorized).toBe(true);
    expect(ldapTlsOptions(cfg).ecdhCurve).toBeUndefined();
  });

  it("fails closed when required live LDAP coverage is missing its URL", () => {
    expect(() =>
      liveLdapConfigured({
        COLLAB_REQUIRE_LDAP: "1",
      }),
    ).toThrow(/COLLAB_REQUIRE_LDAP=1 but COLLAB_LDAP_URL is missing/);
    expect(liveLdapConfigured({})).toBe(false);
    expect(
      liveLdapConfigured({
        COLLAB_LDAP_URL: "ldap://127.0.0.1:389",
      }),
    ).toBe(true);
  });
});

describe("LDAP DN vs filter escaping", () => {
  const template = "uid={username},ou=people,dc=example,dc=test";

  it("uses RFC 4514 escaping inside userDnTemplate", () => {
    expect(
      interpolate(template, { username: escapeDn("bob,ou=admins") }),
    ).toBe("uid=bob\\2cou\\3dadmins,ou=people,dc=example,dc=test");
    expect(interpolate(template, { username: escapeDn("x+cn=admin") })).toBe(
      "uid=x\\2bcn\\3dadmin,ou=people,dc=example,dc=test",
    );
    expect(interpolate(template, { username: escapeDn(" leading") })).toBe(
      "uid=\\20leading,ou=people,dc=example,dc=test",
    );
    expect(interpolate(template, { username: escapeDn("trailing ") })).toBe(
      "uid=trailing\\20,ou=people,dc=example,dc=test",
    );
    expect(interpolate(template, { username: escapeDn("#hash") })).toBe(
      "uid=\\23hash,ou=people,dc=example,dc=test",
    );
    expect(escapeFilter("bob,ou=admins")).toBe("bob,ou=admins");
    expect(escapeFilter("x+cn=admin")).toBe("x+cn=admin");
  });

  it("does not reuse filter escaping for the bind DN template", () => {
    const src = readFileSync(new URL("./ldap-adapter.ts", import.meta.url), "utf8");
    const resolveFn = src.slice(src.indexOf("private async resolveByMode"));
    const templateBranch = resolveFn.slice(
      0,
      resolveFn.indexOf('if (mode === "service_bind_search")'),
    );
    expect(templateBranch).toMatch(/username: escapeDn\(username\)/);
    expect(templateBranch).not.toMatch(/username: escapeFilter\(username\)/);
    expect(src).toMatch(/function userFilter[\s\S]*username: escapeFilter\(username\)/);
  });
});

describe("LDAP AD-compatible configuration", () => {
  it("never derives a UPN suffix or NetBIOS domain from a search base", () => {
    const cfg = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
      COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=corp,dc=example,dc=test",
      COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=corp,dc=example,dc=test",
    });
    expect(cfg.upnSuffix).toBeUndefined();
    expect(cfg.netbiosDomain).toBeUndefined();
    expect(cfg.userResolutionModes).toEqual(["service_bind_search"]);
  });

  it("requires an explicit UPN suffix and NetBIOS name for those modes", () => {
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
        COLLAB_LDAP_USER_RESOLUTION: "upn",
      }),
    ).toThrow(/COLLAB_LDAP_UPN_SUFFIX/);
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
        COLLAB_LDAP_USER_RESOLUTION: "domain_backslash",
      }),
    ).toThrow(/COLLAB_LDAP_NETBIOS_DOMAIN/);
  });

  it("interpolates {0} as the escaped username in filters and DN templates", () => {
    expect(interpolate("(sAMAccountName={0})", { username: escapeFilter("a*b") })).toBe(
      "(sAMAccountName=a\\2ab)",
    );
    expect(
      interpolate("uid={0},ou=people,dc=example,dc=test", { username: escapeDn("a+b") }),
    ).toBe("uid=a\\2bb,ou=people,dc=example,dc=test");
  });

  it("loads a bind secret from exactly one file reference", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cd-ldap-secret-"));
    const file = join(dir, "bind");
    await writeFile(file, "fixture-file-secret\n");
    try {
      const cfg = loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
        COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
        COLLAB_LDAP_BIND_PASSWORD_FILE: file,
      });
      expect(cfg.bindPassword).toBe("fixture-file-secret");
      expect(() =>
        loadLdapConfig({
          COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
          COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
          COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
          COLLAB_LDAP_BIND_PASSWORD: "inline",
          COLLAB_LDAP_BIND_PASSWORD_FILE: file,
        }),
      ).toThrow(/exactly one/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LDAP bind-secret owner-local references", () => {
  const baseEnv = {
    COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
    COLLAB_LDAP_USER_DN_TEMPLATE: "uid={username},ou=people,dc=example,dc=test",
    COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
  };

  it("accepts an absolute file: reference and refuses a relative one", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, isAbsolute } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cd-ldap-secret-ref-"));
    const file = join(dir, "bind-secret");
    await writeFile(file, "fixture-ref-secret\n");
    expect(isAbsolute(file)).toBe(true);
    try {
      expect(
        loadLdapConfig({ ...baseEnv, COLLAB_LDAP_BIND_PASSWORD_REF: `file:${file}` }).bindPassword,
      ).toBe("fixture-ref-secret");

      // A relative reference resolves against the server process CWD, which
      // differs between a unit file, a container, and a developer shell. Read
      // the wrong file silently, or none - so refuse it outright.
      for (const relative of ["file:bind-secret", "file:./bind-secret", "file:../bind-secret"]) {
        expect(() =>
          loadLdapConfig({ ...baseEnv, COLLAB_LDAP_BIND_PASSWORD_REF: relative }),
        ).toThrow(/absolute file: path/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-file scheme and a URL-shaped reference before touching the filesystem", () => {
    for (const ref of [
      "https://secrets.example.test/ldap-bind",
      "file://secrets.example.test/ldap-bind",
      "keychain:cd-collab-secrets",
      "/etc/cd-collab/ldap-bind",
    ]) {
      expect(() =>
        loadLdapConfig({ ...baseEnv, COLLAB_LDAP_BIND_PASSWORD_REF: ref }),
      ).toThrow(/file: path/);
    }
  });

  it("refuses more than one bind-secret source", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cd-ldap-secret-conflict-"));
    const file = join(dir, "bind-secret");
    await writeFile(file, "fixture-ref-secret\n");
    try {
      expect(() =>
        loadLdapConfig({
          ...baseEnv,
          COLLAB_LDAP_BIND_PASSWORD_FILE: file,
          COLLAB_LDAP_BIND_PASSWORD_REF: `file:${file}`,
        }),
      ).toThrow(/exactly one/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the loaded bind secret out of the share-safe public config", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cd-ldap-secret-public-"));
    const file = join(dir, "bind-secret");
    await writeFile(file, "fixture-ref-secret\n");
    try {
      const cfg = loadLdapConfig({ ...baseEnv, COLLAB_LDAP_BIND_PASSWORD_REF: `file:${file}` });
      const published = JSON.stringify(publicLdapConfig(cfg, "ldap"));
      expect(published).not.toContain("fixture-ref-secret");
      expect(published).not.toContain(file);
      expect(JSON.parse(published).bindPasswordConfigured).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
