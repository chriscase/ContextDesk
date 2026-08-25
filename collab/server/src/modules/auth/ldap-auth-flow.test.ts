import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAuthError, parseSessionResponse } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  LdapAuthAdapter,
  MemorySessionStore,
  createAuthLog,
  createRateLimiter,
  createSyntheticLdapFactory,
  defaultSessionPolicy,
  exampleSyntheticDirectory,
  loadLdapConfig,
} from "./index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { MemoryUserProfileStore } from "../people/index.js";

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

describe("LDAP login profile sync", () => {
  it("syncs directory claims on login and denies unmapped or colliding identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ldap-flow-"));
    const audit = new MemoryAuditStore();
    const log = createAuthLog();
    const cfg = loadLdapConfig(ldapEnv);
    const adapter = new LdapAuthAdapter(
      cfg,
      log,
      createSyntheticLdapFactory(cfg, exampleSyntheticDirectory()),
    );
    const roles = new MutableGroupRoleMap(
      parseGroupRoleMap(
        "cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=unmapped,ou=groups,dc=example,dc=test=viewer",
      ),
    );
    const profiles = new MemoryUserProfileStore();
    const app = await buildApp({
      config: testConfig({ evidenceRoot: root, authMode: "ldap" }),
      pool: null,
      store: new FilesystemEvidenceStore({ rootDir: root }),
      profiles,
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
      },
    });
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: "fixture-alice-secret" },
      });
      expect(ok.statusCode).toBe(200);
      const session = parseSessionResponse(JSON.parse(ok.body));
      expect(session.identity.displayName).toBe("Alice Fixture");
      const profile = await profiles.getByUsername("alice");
      expect(profile?.directorySyncStatus).toBe("synced");
      expect(profile?.contactEmail).toBe("alice@example.test");
      expect(profile?.roleTitle).toBe("Contributor");
      expect(profile?.team).toBe("Blue team");

      const denied = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nogroups", password: "fixture-nogroups-secret" },
      });
      expect(denied.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(denied.body)).error).toBe("access_denied");

      await profiles.touchOnLogin({
        id: "local:alice-local",
        username: "samonly",
        displayName: "Local SAM",
        provenance: "local",
        directorySubject: null,
      });
      const collision = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "samonly", password: "fixture-sam-secret" },
      });
      expect(collision.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(collision.body)).error).toBe("access_denied");
      expect(String(collision.headers["set-cookie"] ?? "")).toMatch(/Max-Age=0/);

      const unsafe = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "unsafe", password: "fixture-unsafe-secret" },
      });
      expect(unsafe.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(unsafe.body)).error).toBe("access_denied");
      expect(unsafe.body).not.toContain("fixture-unsafe-secret");
      expect(ok.body).not.toContain("fixture-alice-secret");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
