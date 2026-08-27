import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import {
  TriageRunService,
  type TriageExecutionContext,
  type TriageProfileOption,
  type TriageRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore, type TriageJobStore } from "./store.js";
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
        gatewayMinCandidates: 1,
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

describe("triage run launch route", () => {
  it("answers a duplicate in-flight launch with 409 and names the run already running", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-triage-route-"));
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A gateway slow enough that the operator is tempted to launch again.
    const executor: TriageRunExecutor = {
      execute: async (context: TriageExecutionContext) => {
        await held;
        return {
          ...context.candidate,
          status: "completed" as const,
          benchmarkRunId: null,
          outputHash: "output-hash",
          summary: "Synthetic result.",
          evidenceRefs: [],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown" as const,
          costStatus: "unknown" as const,
          errorCode: null,
          startedAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
          privacyClass: "owner_only" as const,
        };
      },
    };
    const audit = new MemoryAuditStore();
    const cases = new CaseService(
      new FilesystemEvidenceStore({ rootDir: root }),
      audit,
      new MemoryCaseStore(),
      new CatalogService(),
    );
    const triageRuns = new TriageRunService({
      cases,
      audit,
      jobs: new MemoryTriageJobStore(),
      executor,
    });
    const roles = new MutableGroupRoleMap(parseGroupRoleMap(`${leadGroup}=case-lead`));
    const app = await buildApp({
      config: testConfig({ staticDir: null, serviceName: "triage-launch-route-test" }),
      pool: null,
      store: { ping: async () => undefined },
      cases,
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
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "lead", password: "test-password" },
      });
      expect(login.statusCode).toBe(200);
      const cookie = sessionCookie(login.headers);

      const actor = { id: "uid=lead", username: "lead" };
      const created = await cases.createCase(actor, { title: "Route duplicate" }, "test");
      const artifact = await cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("synthetic checkout timeout"),
          summary: "Synthetic checkout timeout.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const snapshot = await cases.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
        "test",
      );
      const payload = {
        schemaId: "cd-collab.triage_job_request.v1",
        snapshotId: snapshot.id,
        mode: "deterministic_mock",
        strategyId: "contextdesk.standard",
        question: "What happened and what should we inspect next?",
        policyFingerprint: null,
        taskFingerprint: "task-fingerprint",
        candidates: [
          {
            candidateId: "candidate-1",
            role: "reviewer",
            provider: "synthetic",
            profileId: null,
            model: "qwen-3.6-27b",
            version: null,
          },
        ],
      };
      const url = `/api/cases/${created.id}/triage-runs`;
      const first = await app.inject({ method: "POST", url, headers: { cookie }, payload });
      expect(first.statusCode).toBe(200);
      const firstJobId = JSON.parse(first.body).id as string;

      const second = await app.inject({ method: "POST", url, headers: { cookie }, payload });
      expect(second.statusCode).toBe(409);
      const error = JSON.parse(second.body).error as string;
      // The GUI shows this text, so it has to name the run and the way out.
      expect(error).toContain(firstJobId);
      expect(error).toContain("open or cancel it");
      // The refusal must not have recorded a second run.
      const listed = await app.inject({
        method: "GET",
        url,
        headers: { cookie },
      });
      expect(JSON.parse(listed.body).jobs.length).toBe(1);
    } finally {
      release?.();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
