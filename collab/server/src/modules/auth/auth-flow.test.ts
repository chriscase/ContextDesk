import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAuthError,
  parseSessionResponse,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  MemoryGroupRoleStore,
  MutableGroupRoleMap,
  parseGroupRoleMap,
} from "../authz/index.js";
import { MapAuthAdapter } from "./adapter.js";
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
    audit: MemoryAuditStore;
    log: ReturnType<typeof createAuthLog>;
    roles: MutableGroupRoleMap;
    roleStore: MemoryGroupRoleStore;
  }) => Promise<void>,
  opts?: { maxFails?: number },
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-auth-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const log = createAuthLog();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(defaultMap));
  const roleStore = new MemoryGroupRoleStore(roles.snapshot());
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    security: {
      auth: {
        adapter: new MapAuthAdapter(fixtureUsers()),
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
    await fn({ app, audit, log, roles, roleStore });
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
