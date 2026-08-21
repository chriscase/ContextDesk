import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriageCandidateRunV1 } from "@cd-collab/contracts";
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
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./index.js";
import { ImportService, MemoryRunStore } from "../import/index.js";
import {
  MemoryTriageJobStore,
  TriageRunService,
  type TriageExecutionContext,
  type TriageRunExecutor,
} from "../triage-runs/index.js";

const ALICE = "fixture-alice-secret";
const DAVE = "fixture-dave-secret";
const DAVE_ACTOR = { id: "uid=dave,ou=people,dc=example,dc=test", username: "dave" };
const TASK_FINGERPRINT = `task-${"a".repeat(64)}`;

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

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
        // Alice may write ordinary collaboration material but is not a case lead.
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: DAVE,
        identity: { ...DAVE_ACTOR, displayName: "dave" },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const executor: TriageRunExecutor = {
  async execute(context: TriageExecutionContext): Promise<TriageCandidateRunV1> {
    const failed = context.candidate.candidateId.startsWith("failed");
    const now = "2026-08-20T00:00:00.000Z";
    return {
      ...context.candidate,
      status: failed ? "failed" : "completed",
      benchmarkRunId: `bench-${context.candidate.candidateId}`,
      outputHash: failed ? null : "b".repeat(64),
      summary: failed ? null : "Bounded ContextDesk result.",
      evidenceRefs: failed ? [] : context.snapshot.evidence.map((item) => item.evidenceId),
      unknowns: failed ? ["result"] : ["usage", "cost", "live model output"],
      usageStatus: "unknown",
      costStatus: "unknown",
      errorCode: failed ? "fixture_failure" : null,
      startedAt: now,
      finishedAt: now,
      privacyClass: "owner_only",
    };
  },
};

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    catalog: CatalogService;
    cases: CaseService;
    imports: ImportService;
    runs: TriageRunService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-unified-handoff-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(evidence, audit, undefined, catalog);
  const imports = new ImportService({
    evidence,
    audit,
    cases,
    catalog,
    runs: new MemoryRunStore(),
  });
  const runs = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    executor,
  });
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: new MemoryExperimentStore(),
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store: evidence,
    domain: cases,
    catalog,
    imports,
    triageRuns: runs,
    experiments,
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
    await fn({ app, catalog, cases, imports, runs });
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
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return cookie(response);
}

async function createSnapshotFixture(cases: CaseService, title: string) {
  const created = await cases.createCase(DAVE_ACTOR, { title }, "test");
  const evidence = await cases.addEvidence(
    created.id,
    DAVE_ACTOR,
    {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("checkout request timed out"),
      summary: "Synthetic checkout timeout.",
      privacyClass: "share_safe",
    },
    "test",
  );
  const snapshot = await cases.createSnapshot(
    created.id,
    DAVE_ACTOR,
    { evidenceIds: [evidence.artifact.id], visibility: "share_safe" },
    "test",
  );
  return { caseId: created.id, snapshot };
}

async function waitForTerminal(
  runs: TriageRunService,
  caseId: string,
  jobId: string,
): Promise<Awaited<ReturnType<TriageRunService["get"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await runs.get(caseId, jobId, DAVE_ACTOR, true);
    if (current && !["queued", "running"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("triage job did not become terminal");
}

async function createJob(
  runs: TriageRunService,
  caseId: string,
  snapshotId: string,
  candidateIds: string[],
) {
  const job = await runs.create(
    caseId,
    DAVE_ACTOR,
    {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId,
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard",
      question: "What should the on-call team inspect next?",
      policyFingerprint: null,
      taskFingerprint: TASK_FINGERPRINT,
      candidates: candidateIds.map((candidateId, index) => ({
        candidateId,
        role: index === 0 ? "reviewer" : "challenger",
        provider: "contextdesk",
        profileId: null,
        model: `fixture-model-${index + 1}`,
        version: null,
      })),
    },
    "test",
    true,
  );
  const terminal = await waitForTerminal(runs, caseId, job.id);
  expect(terminal).not.toBeNull();
  return terminal!;
}

function handoffUrl(caseId: string, jobId: string): string {
  return `/api/cases/${caseId}/experiments/from-triage/${jobId}`;
}

describe("unified comparison handoff adversarial contract", () => {
  it("requires a same-case lead, preserves frozen identity, and is idempotent", async () => {
    await withApp(async ({ app, cases, runs }) => {
      const dave = await login(app, "dave", DAVE);
      const alice = await login(app, "alice", ALICE);
      const primary = await createSnapshotFixture(cases, "Primary checkout triage");
      const other = await createSnapshotFixture(cases, "Other case must not see the run");
      await cases.addParticipant(
        primary.caseId,
        DAVE_ACTOR,
        { identityId: "uid=alice,ou=people,dc=example,dc=test", username: "alice" },
        "test",
      );
      const job = await createJob(runs, primary.caseId, primary.snapshot.id, ["contextdesk-a"]);
      expect(job.status).toBe("completed");

      const unauthenticated = await app.inject({ method: "POST", url: handoffUrl(primary.caseId, job.id) });
      expect(unauthenticated.statusCode).toBe(401);

      const writer = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, job.id),
        headers: { cookie: alice },
        payload: { externalRunId: null },
      });
      expect(writer.statusCode).toBe(403);

      const crossCaseJob = await app.inject({
        method: "POST",
        url: handoffUrl(other.caseId, job.id),
        headers: { cookie: dave },
        payload: { externalRunId: null },
      });
      expect(crossCaseJob.statusCode).toBe(404);

      const first = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, job.id),
        headers: { cookie: dave },
        payload: { externalRunId: null },
      });
      expect(first.statusCode).toBe(200);
      const view = JSON.parse(first.body) as {
        id: string;
        taskFingerprint: string;
        snapshotFingerprint: string;
        candidates: { candidateId: string; helpfulnessState: string; goldState: string }[];
        traces: { events: { kind: string; excerpt: string | null }[] }[];
        observations: unknown[];
        decisions: unknown[];
        gold: unknown;
      };
      expect(view.taskFingerprint).toBe(job.request.taskFingerprint);
      expect(view.snapshotFingerprint).toBe(`snap-${job.snapshotFingerprint}`);
      expect(view.candidates.map((candidate) => candidate.candidateId)).toContain("contextdesk-a");
      expect(view.candidates.every((candidate) => candidate.helpfulnessState === "unreviewed")).toBe(true);
      expect(view.candidates.every((candidate) => candidate.goldState === "unknown")).toBe(true);
      expect(view.traces[0]?.events.find((event) => event.kind === "question")?.excerpt).toContain(
        "on-call",
      );
      expect(view.traces[0]?.events.find((event) => event.kind === "assistant_response")?.excerpt).toContain(
        "Bounded ContextDesk result.",
      );
      expect(view.observations).toEqual([]);
      expect(view.decisions).toEqual([]);
      expect(view.gold).toBeNull();

      const repeated = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, job.id),
        headers: { cookie: dave },
        payload: { externalRunId: null },
      });
      expect(repeated.statusCode).toBe(200);
      expect(JSON.parse(repeated.body).id).toBe(view.id);
      const listed = await app.inject({
        method: "GET",
        url: `/api/cases/${primary.caseId}/experiments`,
        headers: { cookie: dave },
      });
      expect(JSON.parse(listed.body).experiments).toHaveLength(1);
    });
  });

  it("accepts only completed or partial ContextDesk jobs", async () => {
    await withApp(async ({ app, cases, runs }) => {
      const dave = await login(app, "dave", DAVE);
      const primary = await createSnapshotFixture(cases, "Terminal-status boundary");
      const partial = await createJob(runs, primary.caseId, primary.snapshot.id, ["contextdesk-a", "failed-b"]);
      const failed = await createJob(runs, primary.caseId, primary.snapshot.id, ["failed-only"]);
      expect(partial.status).toBe("partial");
      expect(failed.status).toBe("failed");

      const partialHandoff = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, partial.id),
        headers: { cookie: dave },
        payload: { externalRunId: null },
      });
      expect(partialHandoff.statusCode).toBe(200);
      expect(JSON.parse(partialHandoff.body).candidates.map((candidate: { runStatus: string }) => candidate.runStatus)).toEqual([
        "completed",
        "failed",
      ]);

      const failedHandoff = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, failed.id),
        headers: { cookie: dave },
        payload: { externalRunId: null },
      });
      expect(failedHandoff.statusCode).toBe(409);
    });
  });

  it("projects a pasted chat as an explicit unknown plain-text trace and rejects cross-case imports", async () => {
    await withApp(async ({ app, catalog, cases, imports, runs }) => {
      const dave = await login(app, "dave", DAVE);
      const primary = await createSnapshotFixture(cases, "Chat comparison case");
      const other = await createSnapshotFixture(cases, "Unrelated imported chat");
      const job = await createJob(runs, primary.caseId, primary.snapshot.id, ["contextdesk-a"]);
      const source = await catalog.create(
        DAVE_ACTOR,
        { name: "Pasted chat", kind: "external-tool" },
        "test",
      );
      const chat = await imports.importRun(
        primary.caseId,
        DAVE_ACTOR,
        {
          outputText: "The chat recommended checking the timeout pool first.",
          promptText: "What should we inspect?",
          sourceId: source.id,
          operatorId: DAVE_ACTOR.id,
          operatorUsername: DAVE_ACTOR.username,
          promptCompleteness: "unknown",
          outputCompleteness: "partial",
          workflowCompleteness: "unknown",
          evidenceVisibility: "unknown",
          snapshotBinding: null,
        },
        "test",
        true,
      );
      const foreignChat = await imports.importRun(
        other.caseId,
        DAVE_ACTOR,
        {
          outputText: "This chat belongs to another case.",
          sourceId: source.id,
          operatorId: DAVE_ACTOR.id,
          operatorUsername: DAVE_ACTOR.username,
        },
        "test",
        true,
      );

      const crossCaseExternal = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, job.id),
        headers: { cookie: dave },
        payload: { externalRunId: foreignChat.id },
      });
      expect(crossCaseExternal.statusCode).toBe(404);

      const response = await app.inject({
        method: "POST",
        url: handoffUrl(primary.caseId, job.id),
        headers: { cookie: dave },
        payload: { externalRunId: chat.id },
      });
      expect(response.statusCode).toBe(200);
      const view = JSON.parse(response.body) as {
        traces: {
          candidateId: string;
          sourceKind: string;
          completeness: string;
          unknowns: string[];
        }[];
      };
      const chatTrace = view.traces.find((trace) => trace.sourceKind === "plain_text");
      expect(chatTrace).toBeDefined();
      expect(chatTrace?.completeness).toBe("partial");
      expect(chatTrace?.unknowns).toEqual(expect.arrayContaining(["turns", "tools", "evidence"]));
    });
  });
});
