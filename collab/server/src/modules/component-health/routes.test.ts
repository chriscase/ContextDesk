import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseComponentHealthResponse } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { syntheticComponentHealth } from "./routes.js";

async function appForTest() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-component-health-"));
  const audit = new MemoryAuditStore();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap("local:admins=admin;local:viewers=viewer"));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root, authMode: "local" }),
    pool: null,
    store: new FilesystemEvidenceStore({ rootDir: root }),
    componentHealth: syntheticComponentHealth,
    security: {
      auth: {
        adapter: new MapAuthAdapter(new Map([
          ["admin", { password: "admin-secret", identity: { id: "local:admin", username: "admin", displayName: "Admin" }, groups: ["local:admins"] }],
          ["viewer", { password: "viewer-secret", identity: { id: "local:viewer", username: "viewer", displayName: "Viewer" }, groups: ["local:viewers"] }],
        ])),
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
  return { app, root };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: "admin" | "viewer") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: `${username}-secret` },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
}

describe("component health route", () => {
  it("is admin-only and returns the projected synthetic fixture without actions", async () => {
    const { app, root } = await appForTest();
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/component-health" })).statusCode).toBe(401);
      const viewer = await login(app, "viewer");
      expect((await app.inject({ method: "GET", url: "/api/admin/component-health", headers: { cookie: viewer } })).statusCode).toBe(403);
      const admin = await login(app, "admin");
      const response = await app.inject({ method: "GET", url: "/api/admin/component-health", headers: { cookie: admin } });
      expect(response.statusCode).toBe(200);
      const body = parseComponentHealthResponse(JSON.parse(response.body));
      expect(body.dataMode).toBe("synthetic_fixture");
      expect(body.components[0]?.storageMigration).toEqual({
        state: "current",
        current: "016_contribution_write_intents",
        target: "016_contribution_write_intents",
      });
      expect(body.components[2]?.reportStatus).toBe("not_reported");
      expect(response.body).not.toMatch(/password|secret|email|directory|customer/i);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
