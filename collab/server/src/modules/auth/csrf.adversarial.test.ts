import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CSRF_ERROR_SCHEMA_ID,
  parseCsrfError,
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
  type GroupRoleStore,
} from "../authz/index.js";
import type { SetupService } from "../setup/index.js";
import { MapAuthAdapter } from "./adapter.js";
import { injectWithoutBrowserCsrf } from "./csrf.js";
import { createAuthLog } from "./log.js";
import { createRateLimiter } from "./rate-limit.js";
import { MemorySessionStore, defaultSessionPolicy } from "./sessions.js";

const FIXTURE_PASSWORD = "fixture-alice-secret";
const ADMIN_PASSWORD = "fixture-dave-secret";
const defaultMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

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
      "dave",
      {
        password: ADMIN_PASSWORD,
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

class WriteCountingRoleStore implements GroupRoleStore {
  writes = 0;

  constructor(private readonly inner: GroupRoleStore) {}

  load(): ReturnType<GroupRoleStore["load"]> {
    return this.inner.load();
  }

  async set(groupDn: string, role: Parameters<GroupRoleStore["set"]>[1], updatedBy: string): Promise<void> {
    this.writes += 1;
    await this.inner.set(groupDn, role, updatedBy);
  }

  delete(groupDn: string): ReturnType<GroupRoleStore["delete"]> {
    this.writes += 1;
    return this.inner.delete(groupDn);
  }
}

function stubSetup(calls: string[]): SetupService {
  const status = {
    schemaId: "cd-collab.setup_status.v1" as const,
    stateId: "state:synthetic-csrf",
    revision: 0,
    phase: "awaiting_owner" as const,
    claimed: false,
    failureCode: null,
  };
  return {
    status: async () => status,
    claim: async () => {
      calls.push("claim");
      return { ...status, revision: 1, phase: "claimed", claimed: true };
    },
    issueSecret: async () => {
      calls.push("issueSecret");
      return {
        kind: "handle",
        purpose: "initial_admin_password",
        fileRef: null,
        handle: "handle-synthetic",
      };
    },
    stage: async () => {
      calls.push("stage");
      return { status: { ...status, revision: 2, phase: "prepared", claimed: true } };
    },
    verify: async () => {
      calls.push("verify");
      return { ok: true, status: { ...status, revision: 3, phase: "verified", claimed: true } };
    },
  } as unknown as SetupService;
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    roles: MutableGroupRoleMap;
    roleStore: WriteCountingRoleStore;
    setupCalls: string[];
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-csrf-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(defaultMap));
  const roleStore = new WriteCountingRoleStore(new MemoryGroupRoleStore(roles));
  const setupCalls: string[] = [];
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    setup: stubSetup(setupCalls),
    security: {
      auth: {
        adapter: new MapAuthAdapter(fixtureUsers()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 5, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      roleStore,
      audit,
    },
  });
  try {
    await fn({ app, roles, roleStore, setupCalls });
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

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: "alice" | "dave" = "dave",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      username,
      password: username === "dave" ? ADMIN_PASSWORD : FIXTURE_PASSWORD,
    },
  });
  expect(res.statusCode).toBe(200);
  parseSessionResponse(JSON.parse(res.body));
  return cookieFrom(res);
}

const GROUP = "cn=temporary,ou=groups,dc=example,dc=test";

describe("browser mutation CSRF", () => {
  afterEach(() => {
    // keep hooks for symmetry with other suites
  });

  it("rejects a missing CSRF header before a domain write", async () => {
    await withApp(async ({ app, roleStore, roles }) => {
      const cookie = await login(app);
      const before = (await roles.snapshot()).entries.get(GROUP.toLowerCase());
      const res = await injectWithoutBrowserCsrf(app, {
        method: "PUT",
        url: "/api/authz/group-role-map",
        headers: { cookie },
        payload: { group: GROUP, role: "contributor" },
      });
      expect(res.statusCode).toBe(403);
      expect(parseCsrfError(JSON.parse(res.body))).toEqual({
        schemaId: CSRF_ERROR_SCHEMA_ID,
        error: "csrf_required",
      });
      expect(roleStore.writes).toBe(0);
      expect((await roles.snapshot()).entries.get(GROUP.toLowerCase())).toBe(before);
    });
  });

  it("rejects a wrong CSRF header before a domain write", async () => {
    await withApp(async ({ app, roleStore }) => {
      const cookie = await login(app);
      const res = await app.inject({
        method: "PUT",
        url: "/api/authz/group-role-map",
        headers: { cookie, "x-cd-collab-csrf": "0" },
        payload: { group: GROUP, role: "contributor" },
      });
      expect(res.statusCode).toBe(403);
      expect(parseCsrfError(JSON.parse(res.body)).error).toBe("csrf_required");
      expect(roleStore.writes).toBe(0);
    });
  });

  it("accepts the canonical header and then performs the domain write", async () => {
    await withApp(async ({ app, roleStore, roles }) => {
      const cookie = await login(app);
      const res = await app.inject({
        method: "PUT",
        url: "/api/authz/group-role-map",
        headers: { cookie, "x-cd-collab-csrf": "1" },
        payload: { group: GROUP, role: "contributor" },
      });
      expect(res.statusCode).toBe(200);
      expect(roleStore.writes).toBe(1);
      expect((await roles.snapshot()).entries.get(GROUP.toLowerCase())).toBe("contributor");
    });
  });

  it("leaves GET and HEAD usable without the header", async () => {
    await withApp(async ({ app }) => {
      const cookie = await login(app, "alice");
      const get = await injectWithoutBrowserCsrf(app, {
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(get.statusCode).toBe(200);
      expect(parseSessionResponse(JSON.parse(get.body)).identity.username).toBe("alice");
      const head = await injectWithoutBrowserCsrf(app, {
        method: "HEAD",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(head.statusCode).toBe(200);
    });
  });

  it("keeps login, logout, and setup usable without the header", async () => {
    await withApp(async ({ app, setupCalls }) => {
      const loginRes = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: FIXTURE_PASSWORD },
      });
      expect(loginRes.statusCode).toBe(200);
      const cookie = cookieFrom(loginRes);

      const logout = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(200);

      const claim = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/setup/claim",
        headers: { cookie },
        payload: {
          schemaId: "cd-collab.setup_claim_request.v1",
          expectedRevision: 0,
          ownerToken: "A".repeat(43),
          claimantLabel: "Synthetic owner",
        },
      });
      expect(claim.statusCode).not.toBe(403);
      expect(setupCalls).toContain("claim");
      expect(JSON.stringify(claim.json())).not.toContain("csrf_required");
    });
  });

  it("does not CSRF-reject an unauthenticated mutation, and still performs no write", async () => {
    await withApp(async ({ app, roleStore }) => {
      const res = await injectWithoutBrowserCsrf(app, {
        method: "PUT",
        url: "/api/authz/group-role-map",
        payload: { group: GROUP, role: "contributor" },
      });
      expect(res.statusCode).toBe(401);
      expect(roleStore.writes).toBe(0);
    });
  });

  it("rejects a cookie-authenticated simple-request mutation and never grants CORS", async () => {
    await withApp(async ({ app, roleStore }) => {
      const cookie = await login(app);
      const res = await injectWithoutBrowserCsrf(app, {
        method: "POST",
        url: "/api/authz/mutations",
        headers: {
          cookie,
          origin: "https://evil.example.test",
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "kind=probe",
      });
      expect(res.statusCode).toBe(403);
      expect(parseCsrfError(JSON.parse(res.body)).error).toBe("csrf_required");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-headers"]).toBeUndefined();
      expect(roleStore.writes).toBe(0);
    });
  });
});
