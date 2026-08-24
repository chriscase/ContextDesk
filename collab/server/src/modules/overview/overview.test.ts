import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERVIEW_ACTIVITY_CAP,
  OVERVIEW_OPEN_CASE_CAP,
  OVERVIEW_RUNNING_JOB_CAP,
  OVERVIEW_SCHEMA_ID,
  OVERVIEW_TERMINAL_JOB_CAP,
  parseOverview,
  type ExperimentPackageV1,
  type TriageJobStatus,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { captureStaticDemoRoutes } from "../../demo-static.js";
import { buildDemoApp, DEMO_PASSWORD, DEMO_USERNAME } from "../../demo.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, type Actor } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "../experiments/index.js";
import { PresenceService } from "../presence/index.js";
import { MemoryTriageJobStore, TriageRunService, type OverviewJobQuery } from "../triage-runs/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as ExperimentPackageV1;

const ALICE = "fixture-alice-secret";
const BOB = "fixture-bob-secret";
const CAROL = "fixture-carol-secret";
const LEAD = "fixture-lead-secret";
const DAVE = "fixture-dave-secret";
const EVE = "fixture-eve-secret";

const PLANTED_BODY = "PLANTED_CONTRIBUTION_BODY";
const PLANTED_DECISION = "PLANTED_DECISION_TEXT";
const PLANTED_MODEL = "PLANTED_MODEL_OUTPUT";
const HIDDEN_TITLE = "Hidden foreign investigation";

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=leads,ou=groups,dc=example,dc=test=case-lead;cn=admins,ou=groups,dc=example,dc=test=admin";

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE,
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
        password: BOB,
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "carol",
      {
        password: CAROL,
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "lead",
      {
        password: LEAD,
        identity: {
          id: "uid=lead,ou=people,dc=example,dc=test",
          username: "lead",
          displayName: "lead",
        },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: DAVE,
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "eve",
      {
        password: EVE,
        identity: {
          id: "uid=eve,ou=people,dc=example,dc=test",
          username: "eve",
          displayName: "eve",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

class CountingCaseService extends CaseService {
  listCasesCalls = 0;

  override async listCases(actor: Actor, isAdmin: boolean) {
    this.listCasesCalls += 1;
    return super.listCases(actor, isAdmin);
  }
}

class CountingJobStore extends MemoryTriageJobStore {
  listByCaseCalls = 0;
  boundedCalls = 0;

  override async listByCase(caseId: string): Promise<TriageJobV1[]> {
    this.listByCaseCalls += 1;
    return super.listByCase(caseId);
  }

  override async listOverviewJobs(query: OverviewJobQuery) {
    this.boundedCalls += 1;
    return super.listOverviewJobs(query);
  }
}

class CountingExperimentStore extends MemoryExperimentStore {
  listByCaseCalls = 0;
  boundedCalls = 0;

  override async listByCase(caseId: string) {
    this.listByCaseCalls += 1;
    return super.listByCase(caseId);
  }

  override async listOverviewProposed(
    query: Parameters<MemoryExperimentStore["listOverviewProposed"]>[0],
  ) {
    this.boundedCalls += 1;
    return super.listOverviewProposed(query);
  }
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    jobs: CountingJobStore;
    experiments: CountingExperimentStore;
    domain: CountingCaseService;
    roles: MutableGroupRoleMap;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-overview-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CountingCaseService(store, audit, undefined, catalog);
  const experimentStore = new CountingExperimentStore();
  const experiments = new ExperimentService({
    cases: domain,
    audit,
    experiments: experimentStore,
  });
  const jobs = new CountingJobStore();
  const triageRuns = new TriageRunService({ cases: domain, audit, jobs });
  const presence = new PresenceService();
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    experiments,
    triageRuns,
    presence,
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });
  try {
    await fn({ app, jobs, experiments: experimentStore, domain, roles });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function createCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  title: string,
  severity = "medium",
): Promise<{ id: string; title: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: token },
    payload: { title, severity },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { id: string; title: string };
}

async function addMember(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
  caseId: string,
  identityId: string,
  username: string,
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/participants`,
    headers: { cookie: token },
    payload: { identityId, username },
  });
  expect(res.statusCode).toBe(200);
}

async function overviewOf(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string,
) {
  const res = await app.inject({
    method: "GET",
    url: "/api/overview",
    headers: { cookie: token },
  });
  expect(res.statusCode).toBe(200);
  return { res, body: parseOverview(JSON.parse(res.body)) };
}

function syntheticJob(input: {
  id: string;
  caseId: string;
  status: TriageJobStatus;
  sameSnapshot: boolean | null;
  updatedAt: string;
  parentJobId?: string;
}): TriageJobV1 {
  return {
    schemaId: "cd-collab.triage_job.v1",
    id: input.id,
    caseId: input.caseId,
    snapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    snapshotFingerprint: "child-fingerprint",
    requestFingerprint: "request-fingerprint",
    cancellationId: "cancel-1",
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    request: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard",
      question: "inspect the synthetic timeout",
      policyFingerprint: null,
      taskFingerprint: "task-fingerprint",
      ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
      candidates: [
        {
          candidateId: "cand-1",
          role: "single",
          provider: "synthetic",
          profileId: null,
          model: "synthetic-model",
          version: null,
        },
      ],
    },
    status: input.status,
    candidates: [
      {
        candidateId: "cand-1",
        role: "single",
        provider: "synthetic",
        profileId: null,
        model: "synthetic-model",
        version: null,
        status: input.status,
        benchmarkRunId: null,
        outputHash: null,
        summary: PLANTED_MODEL,
        evidenceRefs: ["ev-planted"],
        unknowns: ["usage", "cost"],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: null,
        startedAt: input.status === "queued" ? null : input.updatedAt,
        finishedAt: input.status === "completed" ? input.updatedAt : null,
        privacyClass: "share_safe",
      },
    ],
    sameSnapshot: input.sameSnapshot,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "uid=alice,ou=people,dc=example,dc=test",
    requestedByUsername: "alice",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    startedAt: input.status === "queued" ? null : input.updatedAt,
    finishedAt: input.status === "completed" ? input.updatedAt : null,
    cancelRequestedAt: null,
    stoppedReason: null,
  };
}

describe("GET /api/overview", () => {
  it("authorizes like listCases and never leaks a non-member case", async () => {
    await withApp(async ({ app, jobs, domain }) => {
      const alice = await login(app, "alice", ALICE);
      const carol = await login(app, "carol", CAROL);
      const lead = await login(app, "lead", LEAD);
      const dave = await login(app, "dave", DAVE);
      const eve = await login(app, "eve", EVE);
      const visible = await createCase(app, alice, "Synthetic checkout timeouts", "high");
      await addMember(app, dave, visible.id, "uid=carol,ou=people,dc=example,dc=test", "carol");
      await addMember(app, dave, visible.id, "uid=lead,ou=people,dc=example,dc=test", "lead");
      const hidden = await createCase(app, eve, HIDDEN_TITLE, "critical");
      await app.inject({
        method: "POST",
        url: `/api/cases/${visible.id}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "message", body: PLANTED_BODY, privacyClass: "share_safe" },
      });
      await app.inject({
        method: "POST",
        url: `/api/cases/${hidden.id}/contributions`,
        headers: { cookie: eve },
        payload: { kind: "message", body: "hidden body", privacyClass: "share_safe" },
      });
      await jobs.insert(
        syntheticJob({
          id: "11111111-1111-4111-8111-111111111111",
          caseId: visible.id,
          status: "running",
          sameSnapshot: null,
          updatedAt: "2026-08-24T11:00:00.000Z",
        }),
      );
      await jobs.insert(
        syntheticJob({
          id: "22222222-2222-4222-8222-222222222222",
          caseId: hidden.id,
          status: "running",
          sameSnapshot: true,
          updatedAt: "2026-08-24T11:01:00.000Z",
        }),
      );
      await app.inject({
        method: "POST",
        url: `/api/cases/${visible.id}/presence`,
        headers: { cookie: alice },
        payload: { surface: "experiment_lab" },
      });
      await app.inject({
        method: "POST",
        url: `/api/cases/${hidden.id}/presence`,
        headers: { cookie: eve },
        payload: { surface: "case_board" },
      });

      const unauthenticated = await app.inject({ method: "GET", url: "/api/overview" });
      expect(unauthenticated.statusCode).toBe(401);
      const casesUnauthenticated = await app.inject({ method: "GET", url: "/api/cases" });
      expect(casesUnauthenticated.statusCode).toBe(401);

      for (const token of [alice, carol, lead]) {
        const { res, body } = await overviewOf(app, token);
        expect(body.schemaId).toBe(OVERVIEW_SCHEMA_ID);
        expect(body.openCases.map((row) => row.title)).toEqual(["Synthetic checkout timeouts"]);
        expect(body.recentActivity.every((row) => row.caseId === visible.id)).toBe(true);
        expect(body.queuedAndRunningJobs.map((row) => row.caseId)).toEqual([visible.id]);
        expect(body.presence.members.every((row) => row.caseId === visible.id)).toBe(true);
        expect(res.body).not.toContain(HIDDEN_TITLE);
      }

      const admin = await overviewOf(app, dave);
      expect(admin.body.openCases.some((row) => row.title === HIDDEN_TITLE)).toBe(true);
      expect(domain.listCasesCalls).toBe(0);
    });
  });

  it("returns viewer-empty attention, lead/admin accept-eligible foreign proposals, and author-only own proposals", async () => {
    await withApp(async ({ app, roles }) => {
      const alice = await login(app, "alice", ALICE);
      const carol = await login(app, "carol", CAROL);
      const lead = await login(app, "lead", LEAD);
      const dave = await login(app, "dave", DAVE);
      const created = await createCase(app, alice, "Synthetic checkout timeouts");
      await addMember(app, dave, created.id, "uid=carol,ou=people,dc=example,dc=test", "carol");
      await addMember(app, dave, created.id, "uid=lead,ou=people,dc=example,dc=test", "lead");
      const imported = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments`,
        headers: { cookie: alice },
        payload: PACKAGE,
      });
      expect(imported.statusCode).toBe(200);
      const experimentId = (JSON.parse(imported.body) as { id: string }).id;
      const proposed = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/experiments/${experimentId}/decisions`,
        headers: { cookie: alice },
        payload: {
          text: PLANTED_DECISION,
          rationale: "synthetic rationale",
          evidenceRefs: ["ev-demo-checkout-log"],
        },
      });
      expect(proposed.statusCode).toBe(200);

      const viewer = await overviewOf(app, carol);
      expect(viewer.body.attention).toEqual([]);
      expect(viewer.res.body).not.toContain(PLANTED_DECISION);

      const author = await overviewOf(app, alice);
      expect(author.body.attention).toEqual([
        expect.objectContaining({
          predicate: "own_open_proposal",
          caseId: created.id,
          experimentId,
          authorUsername: "alice",
        }),
      ]);
      expect(author.res.body).not.toContain(PLANTED_DECISION);

      for (const token of [lead, dave]) {
        const { body, res } = await overviewOf(app, token);
        expect(body.attention).toEqual([
          expect.objectContaining({
            predicate: "accept_eligible_proposal",
            caseId: created.id,
            experimentId,
            authorUsername: "alice",
          }),
        ]);
        expect(res.body).not.toContain(PLANTED_DECISION);
      }

      roles.set("cn=contributors,ou=groups,dc=example,dc=test", "viewer");
      const downgraded = await overviewOf(app, alice);
      expect(downgraded.body.viewer.roles).toEqual(["viewer"]);
      expect(downgraded.body.attention).toEqual([]);
      const leadAfterDowngrade = await overviewOf(app, lead);
      expect(leadAfterDowngrade.body.attention).toEqual([
        expect.objectContaining({
          predicate: "accept_eligible_proposal",
          authorUsername: "alice",
        }),
      ]);
    });
  });

  it("omits timeline payloads, contribution bodies, model text, and invented cost or usage amounts", async () => {
    await withApp(async ({ app, jobs }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await createCase(app, alice, "Synthetic checkout timeouts");
      await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "message", body: PLANTED_BODY, privacyClass: "share_safe" },
      });
      await jobs.insert(
        syntheticJob({
          id: "33333333-3333-4333-8333-333333333333",
          caseId: created.id,
          status: "completed",
          sameSnapshot: true,
          updatedAt: "2026-08-24T11:00:00.000Z",
        }),
      );
      const { res, body } = await overviewOf(app, alice);
      expect(res.body).not.toContain(PLANTED_BODY);
      expect(res.body).not.toContain(PLANTED_MODEL);
      expect(res.body).not.toContain('"payload"');
      expect(res.body).not.toContain('"costUsd"');
      expect(res.body).not.toContain('"usageTokens"');
      expect(body.recentActivity[0]).toEqual(
        expect.objectContaining({
          caseId: created.id,
          title: "Synthetic checkout timeouts",
          actor: "alice",
        }),
      );
      expect(Object.keys(body.recentActivity[0] ?? {}).sort()).toEqual(
        ["actor", "caseId", "kind", "seq", "serverTime", "title"].sort(),
      );
      expect(body.recentTerminalJobs[0]?.strategyVersion).toBeUndefined();
      expect(body.recentTerminalJobs[0]?.sameSnapshot).toBe(true);
    });
  });

  it("preserves recorded sameSnapshot on a child job and does not copy the parent", async () => {
    await withApp(async ({ app, jobs }) => {
      const alice = await login(app, "alice", ALICE);
      const created = await createCase(app, alice, "Synthetic checkout timeouts");
      const parentId = "44444444-4444-4444-8444-444444444444";
      await jobs.insert(
        syntheticJob({
          id: parentId,
          caseId: created.id,
          status: "completed",
          sameSnapshot: true,
          updatedAt: "2026-08-24T11:00:00.000Z",
        }),
      );
      await jobs.insert(
        syntheticJob({
          id: "55555555-5555-4555-8555-555555555555",
          caseId: created.id,
          status: "queued",
          sameSnapshot: null,
          updatedAt: "2026-08-24T11:01:00.000Z",
          parentJobId: parentId,
        }),
      );
      const { body } = await overviewOf(app, alice);
      expect(body.recentTerminalJobs[0]?.sameSnapshot).toBe(true);
      expect(body.queuedAndRunningJobs[0]?.sameSnapshot).toBeNull();
    });
  });

  it("enforces caps without per-case store fan-out or listCases inventory", async () => {
    await withApp(async ({ app, jobs, experiments, domain }) => {
      const alice = await login(app, "alice", ALICE);
      const first = await createCase(app, alice, "Synthetic case 0");
      for (let index = 1; index < OVERVIEW_ACTIVITY_CAP + 5; index += 1) {
        await createCase(app, alice, `Synthetic case ${index}`);
      }
      for (let index = 0; index < OVERVIEW_RUNNING_JOB_CAP + 4; index += 1) {
        await jobs.insert(
          syntheticJob({
            id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
            caseId: first.id,
            status: "queued",
            sameSnapshot: null,
            updatedAt: `2026-08-24T11:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        );
      }
      for (let index = 0; index < OVERVIEW_TERMINAL_JOB_CAP + 3; index += 1) {
        await jobs.insert(
          syntheticJob({
            id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
            caseId: first.id,
            status: "completed",
            sameSnapshot: true,
            updatedAt: `2026-08-24T10:00:${String(index).padStart(2, "0")}.000Z`,
          }),
        );
      }
      const beforeCases = jobs.listByCaseCalls;
      const beforeExperiments = experiments.listByCaseCalls;
      const { body } = await overviewOf(app, alice);
      expect(body.statusCounts.open).toBe(OVERVIEW_ACTIVITY_CAP + 5);
      expect(body.openCases).toHaveLength(OVERVIEW_OPEN_CASE_CAP);
      expect(body.recentActivity).toHaveLength(OVERVIEW_ACTIVITY_CAP);
      expect(body.queuedAndRunningJobs).toHaveLength(OVERVIEW_RUNNING_JOB_CAP);
      expect(body.recentTerminalJobs).toHaveLength(OVERVIEW_TERMINAL_JOB_CAP);
      expect(jobs.listByCaseCalls).toBe(beforeCases);
      expect(jobs.boundedCalls).toBe(2);
      expect(experiments.listByCaseCalls).toBe(beforeExperiments);
      expect(experiments.boundedCalls).toBeGreaterThanOrEqual(1);
      expect(domain.listCasesCalls).toBe(0);
    });
  });
});

const demoApps: Awaited<ReturnType<typeof buildDemoApp>>[] = [];
afterEach(async () => {
  await Promise.all(demoApps.splice(0).map(({ app }) => app.close()));
});

describe("overview static demo snapshot", () => {
  it("captures GET /api/overview with honest static presence availability", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    demoApps.push(demo);
    const liveLogin = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    const live = await demo.app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { cookie: cookie(liveLogin) },
    });
    expect(live.statusCode).toBe(200);
    const liveOverview = parseOverview(JSON.parse(live.body));
    expect(liveOverview.presence.reason).toBe("ephemeral_live");
    expect(liveOverview.presence.available).toBe(true);

    const routes = await captureStaticDemoRoutes(demo.app, demo.caseId);
    expect(Object.keys(routes)).toContain("GET /api/overview");
    const snapshot = parseOverview(routes["GET /api/overview"]);
    expect(snapshot.presence.available).toBe(false);
    expect(snapshot.presence.reason).toBe("static_snapshot");
    expect(snapshot.presence.members).toEqual([]);
  });
});
