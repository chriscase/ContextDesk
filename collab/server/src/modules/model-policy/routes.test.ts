import {
  defaultModelPurposeRules,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
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
import { MemoryTriageJobStore, TriageRunService } from "../triage-runs/index.js";
import { MemoryModelPurposePolicyStore } from "./store.js";
import { ModelPurposePolicyService } from "./service.js";

const adminGroup = "cn=war-room-admin,ou=groups,dc=example,dc=test";
const leadGroup = "cn=triage-lead,ou=groups,dc=example,dc=test";

function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

describe("model purpose policy routes", () => {
  it("allows administrators to update policy and rejects a case lead", async () => {
    const audit = new MemoryAuditStore();
    const profiles = [{
      id: "profile:qwen",
      profileId: "profile:qwen",
      modelId: "qwen-3.6-27b",
      label: "Qwen review",
      provider: "company-gateway",
    }];
    const policy = new ModelPurposePolicyService({
      store: new MemoryModelPurposePolicyStore(),
      profiles,
    });
    const triageRuns = new TriageRunService({
      cases: {} as never,
      audit,
      jobs: new MemoryTriageJobStore(),
      profiles,
      modelPolicy: policy,
    });
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(`${adminGroup}=admin;${leadGroup}=case-lead`));
    const app = await buildApp({
      config: testConfig({ staticDir: null, serviceName: "model-policy-route-test" }),
      pool: null,
      store: { ping: async () => undefined },
      triageRuns,
      modelPolicy: policy,
      security: {
        auth: {
          adapter: new MapAuthAdapter(new Map([
            ["admin", {
              password: "admin-password",
              identity: { id: "uid=admin", username: "admin", displayName: "Test Admin" },
              groups: [adminGroup],
            }],
            ["lead", {
              password: "lead-password",
              identity: { id: "uid=lead", username: "lead", displayName: "Test Lead" },
              groups: [leadGroup],
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
      const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/model-policy" });
      expect(unauthenticated.statusCode).toBe(401);

      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "admin-password" },
      });
      expect(adminLogin.statusCode).toBe(200);
      const adminCookie = sessionCookie(adminLogin.headers);
      const loaded = await app.inject({
        method: "GET",
        url: "/api/admin/model-policy",
        headers: { cookie: adminCookie },
      });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.body).not.toContain("endpoint");
      expect(loaded.body).not.toContain("credential");

      const update = await app.inject({
        method: "PUT",
        url: "/api/admin/model-policy",
        headers: { cookie: adminCookie },
        payload: {
          schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
          purposes: defaultModelPurposeRules(["profile:qwen"]),
        },
      });
      expect(update.statusCode).toBe(200);
      expect(JSON.parse(update.body).policy.revision).toBe(2);

      const leadLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "lead", password: "lead-password" },
      });
      expect(leadLogin.statusCode).toBe(200);
      const leadResponse = await app.inject({
        method: "GET",
        url: "/api/admin/model-policy",
        headers: { cookie: sessionCookie(leadLogin.headers) },
      });
      expect(leadResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
