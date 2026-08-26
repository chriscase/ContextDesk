import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID,
  parseAdminRoleMappingList,
  parseAuthError,
  parseSessionResponse,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, type AuditStore } from "../audit/index.js";
import {
  MemoryGroupRoleStore,
  MutableGroupRoleMap,
  parseGroupRoleMap,
  type GroupRoleStore,
} from "../authz/index.js";
import { MapAuthAdapter, type AuthAdapter } from "./adapter.js";
import { createAuthLog } from "./log.js";
import { createRateLimiter } from "./rate-limit.js";
import { MemorySessionStore, defaultSessionPolicy } from "./sessions.js";

const FIXTURE_PASSWORD = "fixture-alice-secret";

function fixtureUsers() {
  return new Map([
    [
      "alice",
      {
        password: FIXTURE_PASSWORD,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "bob",
      {
        password: "fixture-bob-secret",
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=unmapped,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "carol",
      {
        password: "fixture-carol-secret",
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: "fixture-dave-secret",
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const defaultMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: AuditStore;
    log: ReturnType<typeof createAuthLog>;
    roles: MutableGroupRoleMap;
    roleStore: GroupRoleStore;
    users: ReturnType<typeof fixtureUsers>;
  }) => Promise<void>,
  opts?: {
    maxFails?: number;
    audit?: AuditStore;
    roleStore?: GroupRoleStore;
    roles?: MutableGroupRoleMap;
    users?: ReturnType<typeof fixtureUsers>;
    adapter?: AuthAdapter;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-auth-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = opts?.audit ?? new MemoryAuditStore();
  const log = createAuthLog();
  const roles = opts?.roles ?? new MutableGroupRoleMap(parseGroupRoleMap(defaultMap));
  const roleStore = opts?.roleStore ?? new MemoryGroupRoleStore(roles);
  const users = opts?.users ?? fixtureUsers();
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    security: {
      auth: {
        adapter: opts?.adapter ?? new MapAuthAdapter(users),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log,
        limiter: createRateLimiter({
          maxFails: opts?.maxFails ?? 5,
          windowMs: 60_000,
        }),
        cookieSecure: false,
      },
      roles,
      roleStore,
      audit,
    },
  });
  try {
    await fn({ app, audit, log, roles, roleStore, users });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";
  return value.split(";")[0] ?? "";
}

describe("auth flow", () => {
  afterEach(() => {
    // keep hooks for symmetry with other suites
  });

  it("logs in a mapped user and sets an httpOnly SameSite=Lax cookie", async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: FIXTURE_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const session = parseSessionResponse(JSON.parse(res.body));
      expect(session.identity.username).toBe("alice");
      expect(session.roles).toEqual(["contributor"]);
      expect(session.capabilities).toEqual(["investigation:read", "investigation:write"]);
      const setCookie = String(res.headers["set-cookie"] ?? "");
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).not.toMatch(/role=/i);
    });
  });

  it("denies an unmapped authenticated user and audits it", async () => {
    await withApp(async ({ app, audit }) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "bob", password: "fixture-bob-secret" },
      });
      expect(res.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(res.body)).error).toBe("access_denied");
      const events = await audit.list({ action: "login" });
      expect(events.some((e) => e.outcome === "denied" && e.target === "unmapped")).toBe(
        true,
      );
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });

  it("denies a viewer mutation and audits it", async () => {
    await withApp(async ({ app, audit }) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "carol", password: "fixture-carol-secret" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = cookieFrom(login);
      const denied = await app.inject({
        method: "POST",
        url: "/api/authz/mutations",
        headers: { cookie },
        payload: { kind: "probe" },
      });
      expect(denied.statusCode).toBe(403);
      expect(parseAuthError(JSON.parse(denied.body)).error).toBe("forbidden");
      const events = await audit.list({ action: "mutation" });
      expect(events).toHaveLength(1);
      expect(events[0]?.outcome).toBe("denied");
      expect(events[0]?.identity).toContain("carol");
    });
  });

  it("applies role revocation without waiting for session expiry", async () => {
    await withApp(async ({ app, roles }) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: FIXTURE_PASSWORD },
      });
      const cookie = cookieFrom(login);
      const ok = await app.inject({
        method: "POST",
        url: "/api/authz/mutations",
        headers: { cookie },
        payload: { kind: "probe" },
      });
      expect(ok.statusCode).toBe(200);
      roles.set("cn=contributors,ou=groups,dc=example,dc=test", "viewer");
      const denied = await app.inject({
        method: "POST",
        url: "/api/authz/mutations",
        headers: { cookie },
        payload: { kind: "probe" },
      });
      expect(denied.statusCode).toBe(403);
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(parseSessionResponse(JSON.parse(me.body)).roles).toEqual(["viewer"]);
    });
  });

  it("persists and revokes a group-role mapping through the admin API", async () => {
    await withApp(async ({ app, audit, roleStore }) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "dave", password: "fixture-dave-secret" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = cookieFrom(login);
      const group = "cn=temporary,ou=groups,dc=example,dc=test";

      const updated = await app.inject({
        method: "PUT",
        url: "/api/authz/group-role-map",
        headers: { cookie },
        payload: { group, role: "contributor" },
      });
      expect(updated.statusCode).toBe(200);
      expect((await roleStore.load()).entries.get(group)).toBe("contributor");

      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/authz/group-role-map",
        headers: { cookie },
        payload: { group },
      });
      expect(revoked.statusCode).toBe(200);
      expect((await roleStore.load()).entries.has(group)).toBe(false);

      const events = await audit.list();
      expect(
        events.some(
          (event) =>
            event.action === "role_mapping_update" &&
            event.target === `${group}=contributor` &&
            event.outcome === "success",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.action === "role_mapping_revoke" &&
            event.target === group &&
            event.outcome === "success",
        ),
      ).toBe(true);
    });
  });

  it("lists current group-role mappings only to admins and audits the read", async () => {
    await withApp(async ({ app, audit }) => {
      const anonymous = await app.inject({
        method: "GET",
        url: "/api/authz/group-role-map",
      });
      expect(anonymous.statusCode).toBe(401);

      const viewer = cookieFrom(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "carol", password: "fixture-carol-secret" },
        }),
      );
      const denied = await app.inject({
        method: "GET",
        url: "/api/authz/group-role-map",
        headers: { cookie: viewer },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("cn=admins");

      const admin = cookieFrom(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "dave", password: "fixture-dave-secret" },
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/api/authz/group-role-map",
        headers: { cookie: admin },
      });
      expect(response.statusCode).toBe(200);
      expect(parseAdminRoleMappingList(JSON.parse(response.body))).toMatchObject({
        mappings: [
          { group: "cn=admins,ou=groups,dc=example,dc=test", role: "admin" },
          { group: "cn=contributors,ou=groups,dc=example,dc=test", role: "contributor" },
          { group: "cn=viewers,ou=groups,dc=example,dc=test", role: "viewer" },
        ],
        truncated: false,
      });

      const reads = await audit.list({ action: "role_mapping_read" });
      expect(reads.map((event) => event.outcome)).toEqual(["denied", "success"]);
      expect(JSON.stringify(reads)).not.toContain("cn=admins");
    });
  });

  it("fails mapping reads closed when their success audit cannot be recorded", async () => {
    const inner = new MemoryAuditStore();
    const audit: AuditStore = {
      append: async (record) => {
        if (record.action === "role_mapping_read" && record.outcome === "success") {
          throw new Error("audit unavailable");
        }
        return inner.append(record);
      },
      list: (filter) => inner.list(filter),
    };
    await withApp(
      async ({ app }) => {
        const admin = cookieFrom(
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "dave", password: "fixture-dave-secret" },
          }),
        );
        const response = await app.inject({
          method: "GET",
          url: "/api/authz/group-role-map",
          headers: { cookie: admin },
        });
        expect(response.statusCode).toBe(503);
        expect(JSON.parse(response.body)).toEqual({
          schemaId: ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID,
          error: "unavailable",
        });
        expect(response.body).not.toContain("cn=admins");
      },
      { audit },
    );
  });

  it("reports the mapping-list safety limit instead of implying a complete list", async () => {
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(defaultMap));
    for (let index = 0; index < 505; index += 1) {
      roles.set(`local:bounded-${String(index).padStart(3, "0")}`, "viewer");
    }
    const roleStore = new MemoryGroupRoleStore(roles);
    await withApp(
      async ({ app }) => {
        const admin = cookieFrom(
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "dave", password: "fixture-dave-secret" },
          }),
        );
        const response = await app.inject({
          method: "GET",
          url: "/api/authz/group-role-map",
          headers: { cookie: admin },
        });
        const body = parseAdminRoleMappingList(JSON.parse(response.body));
        expect(body.mappings).toHaveLength(body.limit);
        expect(body.truncated).toBe(true);
      },
      { roles, roleStore },
    );
  });

  it("rate-limits failed logins without user-enumeration leakage", async () => {
    await withApp(async ({ app, audit, log }) => {
      const unknown = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nosuch", password: "fixture-wrong-secret" },
      });
      const wrong = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: "fixture-wrong-secret" },
      });
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.body).toBe(wrong.body);
      expect(parseAuthError(JSON.parse(unknown.body)).error).toBe(
        "invalid_credentials",
      );
      for (const line of log.lines()) {
        expect(line).not.toContain("fixture-wrong-secret");
        expect(line).not.toContain(FIXTURE_PASSWORD);
      }
      for (let i = 0; i < 5; i += 1) {
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: "fixture-wrong-secret" },
        });
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: "fixture-wrong-secret" },
      });
      expect(limited.statusCode).toBe(429);
      expect(parseAuthError(JSON.parse(limited.body)).error).toBe("rate_limited");
      const failures = await audit.list({ action: "login" });
      expect(failures.some((e) => e.outcome === "failure")).toBe(true);
      expect(failures.some((e) => e.target === "rate_limited")).toBe(true);
      expect(failures.every((e) => e.identity === null || e.outcome !== "failure")).toBe(
        true,
      );
    }, { maxFails: 5 });
  });

  it("drops live directory groups without waiting for session TTL", async () => {
    await withApp(async ({ app, users }) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: FIXTURE_PASSWORD },
      });
      const cookie = cookieFrom(login);
      const ok = await app.inject({
        method: "POST",
        url: "/api/authz/mutations",
        headers: { cookie },
        payload: { kind: "probe" },
      });
      expect(ok.statusCode).toBe(200);
      const alice = users.get("alice");
      expect(alice).toBeDefined();
      alice!.groups = [];
      const denied = await app.inject({
        method: "POST",
        url: "/api/authz/mutations",
        headers: { cookie },
        payload: { kind: "probe" },
      });
      expect(denied.statusCode).toBe(403);
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
      expect(parseSessionResponse(JSON.parse(me.body)).roles).toEqual([]);
    });
  });

  it("keeps login-time groups when an adapter explicitly uses snapshot refresh", async () => {
    const users = fixtureUsers();
    const adapter = new MapAuthAdapter(users, "login_snapshot");
    await withApp(
      async ({ app }) => {
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: FIXTURE_PASSWORD },
        });
        const cookie = cookieFrom(login);
        users.get("alice")!.groups = [];
        const me = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie },
        });
        expect(me.statusCode).toBe(200);
        expect(parseSessionResponse(JSON.parse(me.body)).roles).toEqual(["contributor"]);
      },
      { users, adapter },
    );
  });

  it("applies a group-role revoke on another instance without restart", async () => {
    const shared = new MemoryGroupRoleStore(parseGroupRoleMap(defaultMap));
    const users = fixtureUsers();
    await withApp(
      async ({ app: instanceA }) => {
        await withApp(
          async ({ app: instanceB }) => {
            const aliceLogin = await instanceB.inject({
              method: "POST",
              url: "/api/auth/login",
              payload: { username: "alice", password: FIXTURE_PASSWORD },
            });
            const aliceCookie = cookieFrom(aliceLogin);
            const before = await instanceB.inject({
              method: "POST",
              url: "/api/authz/mutations",
              headers: { cookie: aliceCookie },
              payload: { kind: "probe" },
            });
            expect(before.statusCode).toBe(200);

            const dave = cookieFrom(
              await instanceA.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: { username: "dave", password: "fixture-dave-secret" },
              }),
            );
            const revoked = await instanceA.inject({
              method: "DELETE",
              url: "/api/authz/group-role-map",
              headers: { cookie: dave },
              payload: { group: "cn=contributors,ou=groups,dc=example,dc=test" },
            });
            expect(revoked.statusCode).toBe(200);

            const after = await instanceB.inject({
              method: "POST",
              url: "/api/authz/mutations",
              headers: { cookie: aliceCookie },
              payload: { kind: "probe" },
            });
            expect(after.statusCode).toBe(403);
            const me = await instanceB.inject({
              method: "GET",
              url: "/api/auth/me",
              headers: { cookie: aliceCookie },
            });
            expect(parseSessionResponse(JSON.parse(me.body)).roles).toEqual([]);
          },
          { roleStore: shared, users },
        );
      },
      { roleStore: shared, users },
    );
  });

  it("does not report persist success as forbidden when audit append fails", async () => {
    const inner = new MemoryAuditStore();
    const audit = {
      append: async (record: Parameters<MemoryAuditStore["append"]>[0]) => {
        if (record.action === "role_mapping_update" && record.outcome === "success") {
          throw new Error("audit append failed");
        }
        return inner.append(record);
      },
      list: (filter?: { action?: string; identity?: string }) => inner.list(filter),
    };
    await withApp(
      async ({ app }) => {
        const cookie = cookieFrom(
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "dave", password: "fixture-dave-secret" },
          }),
        );
        const group = "cn=temporary,ou=groups,dc=example,dc=test";
        const updated = await app.inject({
          method: "PUT",
          url: "/api/authz/group-role-map",
          headers: { cookie },
          payload: { group, role: "contributor" },
        });
        expect(updated.statusCode).toBe(200);
        const body = JSON.parse(updated.body) as {
          ok?: boolean;
          audit?: string;
          error?: string;
        };
        expect(body.ok).toBe(true);
        expect(body.audit).toBe("failed");
        expect(body.error).toBeUndefined();
        expect(updated.body).not.toContain("forbidden");
        const events = await inner.list({ action: "role_mapping_update" });
        expect(events.some((event) => event.outcome === "failure")).toBe(false);
        expect(events.some((event) => event.outcome === "success")).toBe(false);
      },
      { audit },
    );
  });

  it("does not report persist failure as success or forbidden", async () => {
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(defaultMap));
    const roleStore = {
      load: async () => roles.snapshot(),
      set: async () => {
        throw new Error("persist failed");
      },
      delete: async () => false,
    };
    await withApp(
      async ({ app, audit }) => {
        const cookie = cookieFrom(
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "dave", password: "fixture-dave-secret" },
          }),
        );
        const group = "cn=temporary,ou=groups,dc=example,dc=test";
        const updated = await app.inject({
          method: "PUT",
          url: "/api/authz/group-role-map",
          headers: { cookie },
          payload: { group, role: "contributor" },
        });
        expect(updated.statusCode).toBe(503);
        const body = JSON.parse(updated.body) as { error?: string; ok?: boolean };
        expect(body.ok).toBeUndefined();
        expect(body.error).toBe("unavailable");
        expect(updated.body).not.toContain("forbidden");
        const events = await audit.list({ action: "role_mapping_update" });
        expect(events.some((event) => event.outcome === "success")).toBe(false);
        expect(events.some((event) => event.outcome === "failure")).toBe(true);
      },
      { roles, roleStore },
    );
  });

  it("does not log passwords on successful login", async () => {
    await withApp(async ({ app, log }) => {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: FIXTURE_PASSWORD },
      });
      const blob = log.lines().join("\n");
      expect(blob).toContain("login_success");
      expect(blob).not.toContain(FIXTURE_PASSWORD);
      expect(blob).not.toContain("password");
    });
  });
});
