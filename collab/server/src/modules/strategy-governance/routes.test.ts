import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { StrategyGovernanceService } from "./service.js";
import { MemoryStrategyGovernanceStore } from "./store.js";

const adminGroup = "cn=admins,dc=example,dc=test";
const viewerGroup = "cn=viewers,dc=example,dc=test";

function cookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

describe("strategy governance routes", () => {
  it("governs rollout and personal preference without turning policy denial into auth loss", async () => {
    const audit = new MemoryAuditStore();
    const governance = new StrategyGovernanceService({
      store: new MemoryStrategyGovernanceStore(),
      audit,
    });
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(
      `${adminGroup}=admin;${viewerGroup}=viewer`,
    ));
    const app = await buildApp({
      config: testConfig({ staticDir: null, serviceName: "strategy-governance-route-test" }),
      pool: null,
      store: { ping: async () => undefined },
      strategyGovernance: governance,
      security: {
        auth: {
          adapter: new MapAuthAdapter(new Map([
            ["admin", {
              password: "admin-password",
              identity: { id: "uid=admin", username: "admin", displayName: "Admin" },
              groups: [adminGroup],
            }],
            ["reader", {
              password: "reader-password",
              identity: { id: "uid=reader", username: "reader", displayName: "Reader" },
              groups: [viewerGroup],
            }],
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
    try {
      expect((await app.inject({ method: "GET", url: "/api/ui-strategies/effective" })).statusCode)
        .toBe(401);
      const readerLogin = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "reader", password: "reader-password" },
      });
      const readerCookie = cookie(readerLogin.headers);
      const initial = await app.inject({
        method: "GET", url: "/api/ui-strategies/effective", headers: { cookie: readerCookie },
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ effectiveId: "war-room", policyRevision: 0 });

      const deniedAdmin = await app.inject({
        method: "GET", url: "/api/admin/ui-strategies", headers: { cookie: readerCookie },
      });
      expect(deniedAdmin.statusCode).toBe(403);

      const adminLogin = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "admin", password: "admin-password" },
      });
      const adminCookie = cookie(adminLogin.headers);
      const update = await app.inject({
        method: "PUT", url: "/api/admin/ui-strategies",
        headers: {
          cookie: adminCookie,
          [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
        },
        payload: {
          schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
          expectedRevision: 0,
          instance: {
            enabledIds: ["war-room", "investigation-first", "keystone", "beacon"],
            visibleIds: ["war-room", "beacon"],
            defaultId: "war-room",
            selectionMode: "approved_subset",
            approvedIds: ["war-room"],
          },
          roleRules: [
            { role: "viewer", approvedIds: ["war-room"], defaultId: "war-room" },
            { role: "admin", approvedIds: ["war-room", "beacon"], defaultId: "beacon" },
          ],
        },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({ revision: 1 });

      const disallowed = await app.inject({
        method: "PUT", url: "/api/ui-strategies/preference",
        headers: {
          cookie: readerCookie,
          [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
        },
        payload: {
          schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
          expectedPolicyRevision: 1,
          expectedPreferenceRevision: 0,
          strategyId: "beacon",
        },
      });
      expect(disallowed.statusCode).toBe(409);
      expect(disallowed.json()).toMatchObject({ error: "disallowed_strategy" });
      expect((await app.inject({
        method: "GET", url: "/api/ui-strategies/effective", headers: { cookie: readerCookie },
      })).statusCode).toBe(200);

      const selected = await app.inject({
        method: "PUT", url: "/api/ui-strategies/preference",
        headers: {
          cookie: adminCookie,
          [COLLAB_CSRF_HEADER]: COLLAB_CSRF_HEADER_VALUE,
        },
        payload: {
          schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
          expectedPolicyRevision: 1,
          expectedPreferenceRevision: 0,
          strategyId: "beacon",
        },
      });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toMatchObject({
        preferredId: "beacon", effectiveId: "beacon", source: "user",
      });
      expect((await audit.list({ action: "ui_strategy_preference_update" }))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
