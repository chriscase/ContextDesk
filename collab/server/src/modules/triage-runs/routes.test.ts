import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService } from "../cases/index.js";
import {
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { TriageRunService, type TriageProfileOption } from "./index.js";
import type { TriageJobStore } from "./store.js";
import { describe, expect, it } from "vitest";

const leadGroup = "cn=triage-lead,ou=groups,dc=example,dc=test";

function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

describe("triage profile route", () => {
  it("returns only labels and providers, never credentials or endpoints", async () => {
    const audit = new MemoryAuditStore();
    const profiles: TriageProfileOption[] = [
      { id: "profile:employer", label: "Employer gateway", provider: "openai-compatible" },
    ];
    const triageRuns = new TriageRunService({
      cases: {} as CaseService,
      audit,
      jobs: {} as TriageJobStore,
      profiles,
    });
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(`${leadGroup}=case-lead`));
    const app = await buildApp({
      config: testConfig({ staticDir: null, serviceName: "triage-profile-route-test" }),
      pool: null,
      store: { ping: async () => undefined },
      triageRuns,
      security: {
        auth: {
          adapter: new MapAuthAdapter(
            new Map([
              [
                "lead",
                {
                  password: "test-password",
                  identity: { id: "uid=lead", username: "lead", displayName: "Test Lead" },
                  groups: [leadGroup],
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
      const unauthenticated = await app.inject({ method: "GET", url: "/api/triage-profiles" });
      expect(unauthenticated.statusCode).toBe(401);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "lead", password: "test-password" },
      });
      expect(login.statusCode).toBe(200);
      const response = await app.inject({
        method: "GET",
        url: "/api/triage-profiles",
        headers: { cookie: sessionCookie(login.headers) },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).profiles).toEqual(profiles);
      expect(response.body).not.toContain("credential");
      expect(response.body).not.toContain("apiKey");
      expect(response.body).not.toContain("endpoint");
      expect(response.body).not.toContain("https://");

      const capabilities = await app.inject({
        method: "GET",
        url: "/api/triage-capabilities",
        headers: { cookie: sessionCookie(login.headers) },
      });
      expect(capabilities.statusCode).toBe(200);
      expect(JSON.parse(capabilities.body)).toMatchObject({
        schemaId: "cd-collab.triage_job_capabilities.v1",
        syntheticAvailable: true,
        gatewayAvailable: false,
        gatewayMinCandidates: 2,
        profileCatalogConfigured: true,
        profileCount: 1,
      });
      expect(capabilities.body).not.toContain("credential");
      expect(capabilities.body).not.toContain("endpoint");
    } finally {
      await app.close();
    }
  });
});
