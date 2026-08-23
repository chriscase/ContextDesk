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
import {
  TriageRunConflictError,
  TriageRunService,
  type TriageProfileOption,
} from "./index.js";
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

  it("checks rerun idempotency only after authentication and lead authorization", async () => {
    const audit = new MemoryAuditStore();
    const calls: unknown[][] = [];
    const triageRuns = {
      create: async (...args: unknown[]) => {
        calls.push(args);
        if (args[5] === "conflicting-binding") {
          throw new TriageRunConflictError("idempotency key is already bound to a different rerun");
        }
        return { id: "admitted-job" };
      },
    } as unknown as TriageRunService;
    const viewerGroup = "cn=triage-viewer,ou=groups,dc=example,dc=test";
    const roles = new MutableGroupRoleMap(
      parseGroupRoleMap(`${leadGroup}=case-lead;${viewerGroup}=viewer`),
    );
    const app = await buildApp({
      config: testConfig({ staticDir: null, serviceName: "triage-idempotency-route-test" }),
      pool: null,
      store: { ping: async () => undefined },
      triageRuns,
      security: {
        auth: {
          adapter: new MapAuthAdapter(new Map([
            [
              "lead",
              {
                password: "test-password",
                identity: { id: "uid=lead", username: "lead", displayName: "Test Lead" },
                groups: [leadGroup],
              },
            ],
            [
              "viewer",
              {
                password: "test-password",
                identity: { id: "uid=viewer", username: "viewer", displayName: "Viewer" },
                groups: [viewerGroup],
              },
            ],
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
    const rerun = {
      schemaId: "cd-collab.triage_job_create_request.v1",
      fromJobId: "parent-job",
      snapshotId: "target-snapshot",
      mode: "deterministic_mock",
    };
    const ordinary = {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: "snapshot-1",
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard",
      question: "What happened?",
      policyFingerprint: null,
      taskFingerprint: "task",
      candidates: [{
        candidateId: "candidate-a",
        role: "reviewer",
        provider: "synthetic",
        profileId: null,
        model: "qwen-3.6-27b",
        version: null,
      }],
    };
    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        payload: rerun,
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(calls).toHaveLength(0);

      const viewerLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "viewer", password: "test-password" },
      });
      expect(viewerLogin.statusCode).toBe(200);
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie: sessionCookie(viewerLogin.headers) },
        payload: rerun,
      });
      expect(forbidden.statusCode).toBe(403);
      expect(calls).toHaveLength(0);

      const leadLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "lead", password: "test-password" },
      });
      const cookie = sessionCookie(leadLogin.headers);
      const missing = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie },
        payload: rerun,
      });
      expect(missing.statusCode).toBe(400);
      expect(calls).toHaveLength(0);

      const unversioned = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie, "idempotency-key": "rerun-key" },
        payload: { fromJobId: "parent-job", snapshotId: "target-snapshot", mode: "deterministic_mock" },
      });
      expect(unversioned.statusCode).toBe(400);
      expect(calls).toHaveLength(0);

      const accepted = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie, "idempotency-key": "k".repeat(256) },
        payload: rerun,
      });
      expect(accepted.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[5]).toBe("k".repeat(256));

      const conflict = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie, "idempotency-key": "conflicting-binding" },
        payload: rerun,
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.parse(conflict.body).error).toMatch(/already bound/);

      const oversized = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie, "idempotency-key": "k".repeat(257) },
        payload: rerun,
      });
      expect(oversized.statusCode).toBe(400);
      expect(calls).toHaveLength(2);

      const ordinaryWithKey = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie, "idempotency-key": "ordinary-key" },
        payload: ordinary,
      });
      expect(ordinaryWithKey.statusCode).toBe(400);
      const ordinaryAccepted = await app.inject({
        method: "POST",
        url: "/api/cases/case-1/triage-runs",
        headers: { cookie },
        payload: ordinary,
      });
      expect(ordinaryAccepted.statusCode).toBe(200);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toHaveLength(5);
    } finally {
      await app.close();
    }
  });
});
