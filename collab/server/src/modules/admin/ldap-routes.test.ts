import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LDAP_PROBE_REQUEST_SCHEMA_ID,
  parseLdapProbeReport,
  parseLdapPublicConfig,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  LdapAuthAdapter,
  MapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  createSyntheticLdapFactory,
  defaultSessionPolicy,
  exampleSyntheticDirectory,
  injectWithoutBrowserCsrf,
  loadLdapConfig,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";

const ldapEnv = {
  COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
  COLLAB_LDAP_USER_SEARCH_BASE: "ou=people,dc=example,dc=test",
  COLLAB_LDAP_GROUP_SEARCH_BASE: "ou=groups,dc=example,dc=test",
  COLLAB_LDAP_BIND_DN: "cn=svc,ou=services,dc=example,dc=test",
  COLLAB_LDAP_BIND_PASSWORD: "fixture-service-secret",
  COLLAB_LDAP_UPN_SUFFIX: "example.test",
  COLLAB_LDAP_NETBIOS_DOMAIN: "EXAMPLE",
  COLLAB_LDAP_MEMBER_ATTR: "memberOf",
};

async function withLdapApp(
  fn: (ctx: { app: Awaited<ReturnType<typeof buildApp>> }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-ldap-admin-"));
  const audit = new MemoryAuditStore();
  const log = createAuthLog();
  const cfg = loadLdapConfig(ldapEnv);
  const directory = exampleSyntheticDirectory();
  const adapter = new LdapAuthAdapter(cfg, log, createSyntheticLdapFactory(cfg, directory));
  const roles = new MutableGroupRoleMap(
    parseGroupRoleMap(
      "cn=contributors,ou=groups,dc=example,dc=test=admin;cn=unmapped,ou=groups,dc=example,dc=test=viewer",
    ),
  );
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "ldap" }),
    pool: null,
    store: new FilesystemEvidenceStore({ rootDir: root }),
    security: {
      auth: {
        adapter,
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log,
        limiter: createRateLimiter({ maxFails: 5, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      roleStore: new MemoryGroupRoleStore(roles),
      audit,
      ldapConfig: cfg,
      ldapSessions: createSyntheticLdapFactory(cfg, directory),
    },
  });
  try {
    await fn({ app });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function loginAdmin(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "alice", password: "fixture-alice-secret" },
  });
  expect(res.statusCode).toBe(200);
  return String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

describe("admin LDAP routes", () => {
  it("returns share-safe config and a staged probe without secrets", async () => {
    await withLdapApp(async ({ app }) => {
      const cookie = await loginAdmin(app);
      const configRes = await app.inject({
        method: "GET",
        url: "/api/admin/ldap/config",
        headers: { cookie },
      });
      expect(configRes.statusCode).toBe(200);
      const config = parseLdapPublicConfig(JSON.parse(configRes.body));
      expect(config.bindPasswordConfigured).toBe(true);
      expect(configRes.body).not.toContain("fixture-service-secret");
      expect(configRes.body).not.toContain("fixture-alice-secret");

      const probeRes = await app.inject({
        method: "POST",
        url: "/api/admin/ldap/test",
        headers: { cookie },
        payload: {
          schemaId: LDAP_PROBE_REQUEST_SCHEMA_ID,
          probeUsername: "alice",
          probePassword: "fixture-alice-secret",
        },
      });
      expect(probeRes.statusCode).toBe(200);
      const report = parseLdapProbeReport(JSON.parse(probeRes.body));
      expect(report.ready).toBe(true);
      expect(probeRes.body).not.toContain("fixture-alice-secret");
      expect(probeRes.body).not.toContain("fixture-service-secret");
    });
  });

  it("forbids viewers and requires CSRF for the probe", async () => {
    await withLdapApp(async ({ app }) => {
      const cookie = await loginAdmin(app);
      const missingCsrf = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/admin/ldap/test",
        headers: { cookie },
        payload: {
          schemaId: LDAP_PROBE_REQUEST_SCHEMA_ID,
          probeUsername: "alice",
          probePassword: null,
        },
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.body).not.toContain("fixture-alice-secret");

      const viewerLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "bob", password: "fixture-bob-secret" },
      });
      expect(viewerLogin.statusCode).toBe(200);
      const viewerCookie = String(viewerLogin.headers["set-cookie"] ?? "").split(";")[0] ?? "";
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/ldap/config",
        headers: { cookie: viewerCookie },
      });
      expect(forbidden.statusCode).toBe(403);
    });
  });
});

describe("admin LDAP routes without a directory", () => {
  it("publishes a local public config when no LDAP adapter is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ldap-local-"));
    const audit = new MemoryAuditStore();
    const roles = new MutableGroupRoleMap(parseGroupRoleMap("local:admins=admin"));
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root, authMode: "local" }),
      pool: null,
      store: new FilesystemEvidenceStore({ rootDir: root }),
      security: {
        auth: {
          adapter: new MapAuthAdapter(
            new Map([
              [
                "admin",
                {
                  password: "admin-secret",
                  identity: { id: "local:admin", username: "admin", displayName: "Admin" },
                  groups: ["local:admins"],
                },
              ],
            ]),
          ),
          sessions: new MemorySessionStore(),
          policy: defaultSessionPolicy,
          roles,
          audit,
          log: createAuthLog(),
          limiter: createRateLimiter({ maxFails: 5, windowMs: 60_000 }),
          cookieSecure: false,
        },
        roles,
        roleStore: new MemoryGroupRoleStore(roles),
        audit,
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin-secret" },
      });
      const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0] ?? "";
      const configRes = await app.inject({
        method: "GET",
        url: "/api/admin/ldap/config",
        headers: { cookie },
      });
      expect(configRes.statusCode).toBe(200);
      expect(parseLdapPublicConfig(JSON.parse(configRes.body)).authMode).toBe("local");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
