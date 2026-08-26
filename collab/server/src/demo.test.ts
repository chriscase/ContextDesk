import { existsSync } from "node:fs";
import {
  LAB_EXPORT_V2_SCHEMA_ID,
  parseCaseBoard,
  parseLabExportV2,
  parseCasePresence,
  parsePortableArchive,
  parseSnapshot,
  parseSnapshotList,
  parseTriageJob,
  parseTriageJobList,
  type TriageCandidateRunV1,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDemoApp,
  DEMO_PASSWORD,
  DEMO_USERNAME,
} from "./demo.js";
import type {
  TriageBatchExecutionContext,
  TriageBatchRunExecutor,
  TriageProfileOption,
} from "./modules/triage-runs/index.js";
import type { LogTimeAction } from "./modules/log-time/index.js";

const apps: Awaited<ReturnType<typeof buildDemoApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
});

function cookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function waitForTerminalTriage(
  demo: Awaited<ReturnType<typeof buildDemoApp>>,
  jobId: string,
  headers: { cookie: string },
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/triage-runs/${jobId}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const job = parseTriageJob(JSON.parse(response.body));
    if (["completed", "partial", "failed", "timed_out", "cancelled"].includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("synthetic gateway triage did not reach a terminal state");
}

describe("synthetic demo server", () => {
  it("wires the investigation record services used by the visible demo UI", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    apps.push(demo);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    const headers = { cookie: cookie(login) };

    const initialEntities = await demo.app.inject({
      method: "GET",
      url: "/api/entities",
      headers,
    });
    expect(initialEntities.statusCode).toBe(200);

    const createdEntity = await demo.app.inject({
      method: "POST",
      url: "/api/entities",
      headers,
      payload: {
        kind: "organization",
        label: "Synthetic Northwind Support",
        privacyClass: "owner_only",
      },
    });
    expect(createdEntity.statusCode).toBe(201);
    const entity = JSON.parse(createdEntity.body) as { id: string };

    const involvement = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/involvement`,
      headers,
      payload: {
        entityId: entity.id,
        relationship: "affected",
        occurredAt: "2025-11-02",
      },
    });
    expect(involvement.statusCode).toBe(201);

    const references = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/references`,
      headers,
    });
    expect(references.statusCode).toBe(200);
    const resolutions = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/resolutions`,
      headers,
    });
    expect(resolutions.statusCode).toBe(200);
  });

  it("can expose provider-free log chronology through an explicitly configured local bridge", async () => {
    const demo = await buildDemoApp({
      staticDir: null,
      logTimeBridge: {
        async run() {
          throw new Error("the state read must not invoke the host bridge");
        },
      },
    });
    apps.push(demo);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    const response = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/log-time`,
      headers: { cookie: cookie(login) },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).state.corpusId).toBeNull();
  });

  it("seeds the visible demo logs through corpus intake so timezone review can build them", async () => {
    const actions: LogTimeAction[] = [];
    const demo = await buildDemoApp({
      staticDir: null,
      logTimeBridge: {
        async run(caseId, action) {
          actions.push(action);
          return {
            caseId,
            corpusId: "corpus-demo-checkout",
            corpusRevision: 1,
            build: {
              corpusName: `case ${caseId} log corpus`,
              eventsImported: 18,
              sourcesSelected: 3,
              sourcesFailed: 0,
              partial: false,
              timezoneAmbiguousSources: [],
            },
            sources: ["checkout.log", "connection-pool.log", "inventory-timeout.log"].map(
              (source) => ({
                source,
                unresolvedLocalRecords: 0,
                resolvedLocalRecords: 0,
                explicitWallClockRecords: 1,
                otherOrderOnlyRecords: 0,
              }),
            ),
            declarations: {},
          };
        },
      },
    });
    apps.push(demo);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    const response = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/log-time/build`,
      headers: { cookie: cookie(login) },
    });

    expect(response.statusCode).toBe(200);
    const build = actions.find((action) => action.kind === "build");
    expect(build?.kind).toBe("build");
    if (build?.kind !== "build") throw new Error("demo did not ask the host to build a corpus");
    expect(build.files.map((file) => file.relativePath).sort()).toEqual([
      "checkout.log",
      "connection-pool.log",
      "inventory-timeout.log",
    ]);
  });

  it("seeds the three-model and interaction-strategy review stories", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    apps.push(demo);
    const root = await demo.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: cookie(login) };
    const session = await demo.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).roles).toEqual(["admin"]);
    const activityResponse = await demo.app.inject({
      method: "GET",
      url: "/api/activity?limit=30",
      headers,
    });
    expect(activityResponse.statusCode).toBe(200);
    const activity = JSON.parse(activityResponse.body) as {
      activities: { caseId: string; caseTitle: string; targetId: string | null }[];
    };
    expect(activity.activities.length).toBeGreaterThan(0);
    // The feed spans every seeded investigation, not only the primary one:
    // the demo now also carries a correspondence case, a human-notes-only
    // case, and an archived one. Each row still names the investigation it
    // belongs to, which is what the projection has to guarantee.
    expect(activity.activities.every((row) => row.caseId.length > 0)).toBe(true);
    expect(activity.activities.every((row) => row.caseTitle.length > 0)).toBe(true);
    expect(activity.activities.some((row) => row.caseId === demo.caseId)).toBe(true);
    expect(activity.activities.some((row) => row.caseTitle.includes("Checkout timeouts"))).toBe(
      true,
    );
    expect(new Set(activity.activities.map((row) => row.caseId)).size).toBeGreaterThan(1);
    const unauthenticatedPresence = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/presence`,
    });
    expect(unauthenticatedPresence.statusCode).toBe(401);
    const presenceResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/presence`,
      headers,
      payload: { surface: "experiment_lab" },
    });
    expect(presenceResponse.statusCode).toBe(200);
    const presence = parseCasePresence(JSON.parse(presenceResponse.body));
    expect(presence.members.map((member) => member.username)).toContain(DEMO_USERNAME);
    const health = await demo.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).service).toBe("contextdesk-synthetic-demo");
    const ready = await demo.app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);

    const snapshotResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/snapshots`,
      headers,
      payload: { evidenceIds: [], visibility: "owner_only" },
    });
    expect(snapshotResponse.statusCode).toBe(200);
    const snapshot = parseSnapshot(JSON.parse(snapshotResponse.body));
    expect(snapshot.status).toBe("frozen");
    const snapshotsResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/snapshots`,
      headers,
    });
    expect(parseSnapshotList(JSON.parse(snapshotsResponse.body)).snapshots.length).toBeGreaterThanOrEqual(2);
    const jobsResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/triage-runs`,
      headers,
    });
    expect(jobsResponse.statusCode).toBe(200);
    const jobs = parseTriageJobList(JSON.parse(jobsResponse.body)).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.status === "completed" && job.sameSnapshot === true)).toBe(true);
    expect(jobs.map((job) => job.candidates.length).sort()).toEqual([2, 3]);
    const threeLaneJob = jobs.find((job) => job.candidates.length === 3);
    expect(threeLaneJob).toBeTruthy();
    const shareSafeJob = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/triage-runs/${threeLaneJob?.id}/share-safe`,
      headers,
    });
    expect(shareSafeJob.statusCode).toBe(200);
    expect(shareSafeJob.body).not.toContain("qwen-3.6-27b");
    expect(shareSafeJob.body).not.toContain("ev-demo-checkout-log");
    const boardResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/board?snapshotId=${snapshot.id}`,
      headers,
    });
    expect(boardResponse.statusCode).toBe(200);
    expect(parseCaseBoard(JSON.parse(boardResponse.body)).snapshotId).toBe(snapshot.id);
    const experiments = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/experiments`,
      headers,
    });
    expect(experiments.statusCode).toBe(200);
    const body = JSON.parse(experiments.body) as {
      experiments: {
        id: string;
        packageId: string;
        candidates: unknown[];
        traces: {
          candidateId: string;
          events: { excerpt: string | null; evidenceRefs: string[] }[];
        }[];
        observations: unknown[];
        decisions: { status: string }[];
        gold: { version: number } | null;
      }[];
    };
    expect(body.experiments.map((row) => row.packageId)).toEqual([
      "pkg-synth-three-model-checkout-v1",
      "pkg-synth-strategy-paths-v1",
    ]);
    expect(body.experiments[0]?.candidates).toHaveLength(3);
    expect(body.experiments[0]?.traces).toHaveLength(3);
    expect(
      body.experiments[0]?.traces.some((trace) =>
        trace.events.some(
          (event) => event.excerpt?.includes("TimeoutError"),
        ),
      ),
    ).toBe(true);
    expect(body.experiments[0]?.observations).toHaveLength(3);
    expect(body.experiments[1]?.traces).toHaveLength(2);
    expect(body.experiments.every((row) => row.decisions.at(-1)?.status === "accepted")).toBe(
      true,
    );
    expect(body.experiments.every((row) => row.gold?.version === 1)).toBe(true);

    const exported = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/experiments/${body.experiments[0]?.id}/export`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    const shareSafe = parseLabExportV2(JSON.parse(exported.body));
    expect(shareSafe.schemaId).toBe(LAB_EXPORT_V2_SCHEMA_ID);
    expect(shareSafe.review.candidates.map((row) => row.candidateAlias)).toEqual([
      "approach-1",
      "approach-2",
      "approach-3",
    ]);
    expect(shareSafe.review.omissions).toEqual({
      modelLabelsIncluded: false,
      participantIdentitiesIncluded: false,
      freeTextIncluded: false,
      privateContentIncluded: false,
      correlatableMetadataIncluded: false,
    });
    for (const withheld of [
      "uid=demo",
      "apiKey",
      "qwen-3.6-27b",
      "gpt-oss-120b",
      "ministral-14b",
      '"modelLabel"',
      '"rationale"',
      '"text"',
    ]) {
      expect(exported.body).not.toContain(withheld);
    }
  });

  it("exports a complete portable archive before and after a deterministic gateway import", async () => {
    const profiles: TriageProfileOption[] = [
      {
        id: "subject:synthetic-qwen",
        profileId: "profile:synthetic-gateway",
        modelId: "alibaba/qwen3.6-27b",
        label: "Synthetic Qwen lane",
        provider: "openai-compatible",
      },
      {
        id: "subject:synthetic-oss",
        profileId: "profile:synthetic-gateway",
        modelId: "openai/gpt-oss-120b",
        label: "Synthetic OSS lane",
        provider: "openai-compatible",
      },
      {
        id: "subject:synthetic-ministral",
        profileId: "profile:synthetic-gateway",
        modelId: "mistral/ministral-14b",
        label: "Synthetic Ministral lane",
        provider: "openai-compatible",
      },
    ];
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (
        context: TriageBatchExecutionContext,
      ): Promise<TriageCandidateRunV1[]> =>
        context.request.candidates.map((candidate, index) => ({
          ...candidate,
          status: index === 0 ? "completed" : "partial",
          benchmarkRunId: `synthetic-connected-run-${index + 1}`,
          outputHash: `${index + 1}`.repeat(64),
          summary: `Synthetic lane ${index + 1} recorded a bounded dependency signal.`,
          evidenceRefs: [
            context.snapshot.evidence[index % context.snapshot.evidence.length]?.evidenceId ?? "",
          ],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: index === 0 ? null : "root_cause_not_established",
          startedAt: null,
          finishedAt: null,
          privacyClass: "owner_only",
        })),
    };
    const demo = await buildDemoApp({
      staticDir: null,
      gatewayExecutor,
      triageProfiles: profiles,
    });
    apps.push(demo);
    const login = await demo.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: cookie(login) };

    const beforeResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/portable-archive`,
      headers,
    });
    expect(beforeResponse.statusCode).toBe(200);
    const before = parsePortableArchive(JSON.parse(beforeResponse.body));
    const beforeSnapshotFingerprints = new Set(
      before.investigation.snapshots.map((snapshot) => snapshot.fingerprint),
    );
    expect(before.investigation.experiments).toHaveLength(2);
    expect(
      before.investigation.experiments.every((experiment) =>
        beforeSnapshotFingerprints.has(experiment.snapshotFingerprint),
      ),
    ).toBe(true);

    const snapshotsResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/snapshots`,
      headers,
    });
    expect(snapshotsResponse.statusCode).toBe(200);
    const frozen = parseSnapshotList(JSON.parse(snapshotsResponse.body)).snapshots.find(
      (snapshot) => snapshot.evidence.length > 0,
    );
    expect(frozen).toBeDefined();
    const createdResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/triage-runs`,
      headers,
      payload: {
        schemaId: "cd-collab.triage_job_request.v1",
        snapshotId: frozen?.id,
        mode: "gateway",
        strategyId: "contextdesk.standard.synthetic-connected",
        question: "Which fictional dependency signal should the operator verify next?",
        policyFingerprint: null,
        taskFingerprint: "synthetic-connected-checkout-v1",
        candidates: profiles.map((profile, index) => ({
          candidateId: `connected-lane-${index + 1}`,
          role: ["reviewer", "contributor", "challenger"][index],
          provider: profile.provider,
          profileId: profile.profileId,
          model: profile.modelId,
          version: null,
        })),
      },
    });
    expect(createdResponse.statusCode).toBe(200);
    const created = parseTriageJob(JSON.parse(createdResponse.body));
    const completed = await waitForTerminalTriage(demo, created.id, headers);
    expect(completed.status).toBe("partial");
    expect(completed.sameSnapshot).toBe(true);
    expect(completed.candidates.every((candidate) => candidate.evidenceRefs.length === 1)).toBe(
      true,
    );
    expect(
      completed.candidates.every(
        (candidate) => candidate.usageStatus === "unknown" && candidate.costStatus === "unknown",
      ),
    ).toBe(true);

    const importedResponse = await demo.app.inject({
      method: "POST",
      url: `/api/cases/${demo.caseId}/experiments/from-triage/${created.id}`,
      headers,
      payload: { externalRunId: null },
    });
    expect(importedResponse.statusCode).toBe(200);

    const afterResponse = await demo.app.inject({
      method: "GET",
      url: `/api/cases/${demo.caseId}/portable-archive`,
      headers,
    });
    expect(afterResponse.statusCode).toBe(200);
    const after = parsePortableArchive(JSON.parse(afterResponse.body));
    const portableJob = after.investigation.triageJobs.find((job) => job.id === created.id);
    expect(portableJob?.status).toBe("partial");
    expect(portableJob?.candidates.every((candidate) => candidate.evidenceRefs.length === 1)).toBe(
      true,
    );
    expect(
      portableJob?.candidates.every(
        (candidate) => candidate.usageStatus === "unknown" && candidate.costStatus === "unknown",
      ),
    ).toBe(true);
    const connectedExperiment = after.investigation.experiments.find(
      (experiment) => experiment.packageId === `pkg-triage-${created.id}`,
    );
    expect(connectedExperiment?.snapshotFingerprint).toBe(portableJob?.snapshotFingerprint);
    expect(after.investigation.experiments).toHaveLength(before.investigation.experiments.length + 1);
  });

  it("removes its temporary evidence root when closed", async () => {
    const demo = await buildDemoApp({ staticDir: null });
    expect(existsSync(demo.evidenceRoot)).toBe(true);
    await demo.app.close();
    expect(existsSync(demo.evidenceRoot)).toBe(false);
  });

  it("removes its temporary evidence root when app construction fails", async () => {
    let evidenceRoot = "";
    await expect(
      buildDemoApp({
        staticDir: null,
        onEvidenceRootCreated: (root) => {
          evidenceRoot = root;
        },
        appBuilder: () => Promise.reject(new Error("synthetic construction failure")),
      }),
    ).rejects.toThrow("synthetic construction failure");
    expect(evidenceRoot).not.toBe("");
    expect(existsSync(evidenceRoot)).toBe(false);
  });
});
