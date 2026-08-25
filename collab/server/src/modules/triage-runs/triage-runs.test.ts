import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTriageJob,
  parseTriageJobShareSafe,
  projectTriageJobShareSafe,
  type TriageCandidateRunV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import {
  DeterministicMockTriageExecutor,
  TriageRunService,
  type TriageProfileOption,
  type TriageBatchExecutionContext,
  type TriageBatchRunExecutor,
  type TriageExecutionContext,
  type TriageRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore, PgTriageJobStore } from "./store.js";

const actor = { id: "lead", username: "lead" };

async function fixture(
  executor?: TriageRunExecutor,
  gatewayExecutor?: TriageBatchRunExecutor,
  profiles?: TriageProfileOption[],
) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-triage-run-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore(), new CatalogService());
  const service = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    ...(executor ? { executor } : {}),
    ...(gatewayExecutor ? { gatewayExecutor } : {}),
    ...(profiles ? { profiles } : {}),
  });
  const created = await cases.createCase(actor, { title: "Triage run test" }, "test");
  const artifact = await cases.addEvidence(
    created.id,
    actor,
    {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("checkout timeout"),
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
  return { root, cases, service, caseId: created.id, snapshot };
}

function request(snapshotId: string) {
  return {
    schemaId: "cd-collab.triage_job_request.v1" as const,
    snapshotId,
    mode: "deterministic_mock" as const,
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
}

describe("snapshot-bound triage runs", () => {
  it("uses an exclusive durable worker lease and only exposes expired work for recovery", async () => {
    const store = new MemoryTriageJobStore();
    const job: TriageJobV1 = {
      schemaId: "cd-collab.triage_job.v1",
      id: "job-lease",
      caseId: "case-lease",
      snapshotId: "snapshot-lease",
      snapshotFingerprint: "snapshot-fingerprint",
      requestFingerprint: "request-fingerprint",
      cancellationId: "cancel-lease",
      request: request("snapshot-lease"),
      status: "queued",
      candidates: [
        {
          ...request("snapshot-lease").candidates[0]!,
          status: "queued",
          benchmarkRunId: null,
          outputHash: null,
          summary: null,
          evidenceRefs: [],
          unknowns: [],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: null,
          finishedAt: null,
          privacyClass: "owner_only",
        },
      ],
      sameSnapshot: null,
      agreementNotice: "Agreement is not proof of correctness.",
      requestedBy: "lead",
      requestedByUsername: "lead",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      stoppedReason: null,
    };
    await store.insert(job);
    const liveUntil = new Date(Date.now() + 60_000).toISOString();
    const claimed = await store.claimQueued(job.id, new Date().toISOString(), "worker-a", liveUntil);
    expect(claimed?.workerId).toBe("worker-a");
    expect(await store.claimQueued(job.id, new Date().toISOString(), "worker-b", liveUntil)).toBeNull();
    expect(await store.renewLease(job.id, "worker-b", liveUntil)).toBe(false);
    expect(await store.renewLease(job.id, "worker-a", new Date(Date.now() + 120_000).toISOString())).toBe(true);
    expect(await store.listStaleRunning(new Date().toISOString())).toHaveLength(0);

    const expired = (await store.get(job.id))!;
    await store.update({
      ...expired,
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
    });
    expect(await store.listStaleRunning(new Date().toISOString())).toHaveLength(1);
    await expect(store.update({
      ...expired,
      status: "completed",
      updatedAt: new Date().toISOString(),
    })).rejects.toThrow("triage job not found");
    const recovery = {
      ...(await store.get(job.id))!,
      status: "failed" as const,
      stoppedReason: "worker_lease_expired",
      leaseExpiresAt: null,
    };
    expect(await store.recoverStale(recovery, new Date().toISOString())).toBe(true);
    expect(await store.recoverStale(recovery, new Date().toISOString())).toBe(false);
    await expect(store.update({
      ...expired,
      status: "completed",
      updatedAt: new Date().toISOString(),
    })).rejects.toThrow("triage job not found");
    expect((await store.get(job.id))?.status).toBe("failed");
  });

  it("runs a deterministic candidate and projects a share-safe lifecycle record", async () => {
    const fx = await fixture(new DeterministicMockTriageExecutor());
    try {
      const created = await fx.service.create(fx.caseId, actor, request(fx.snapshot.id), "test", false);
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(parseTriageJob(completed).snapshotFingerprint).toBe(fx.snapshot.fingerprint);
      expect(completed.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(completed.candidates[0]?.status).toBe("completed");
      expect(completed.candidates[0]?.evidenceRefs).toEqual([fx.snapshot.evidence[0]?.evidenceId]);
      expect(completed.candidates[0]?.usageStatus).toBe("unknown");
      expect(completed.sameSnapshot).toBe(true);

      const shareSafe = parseTriageJobShareSafe(projectTriageJobShareSafe(completed));
      expect(shareSafe.candidates[0]?.evidenceCount).toBe(1);
      expect(JSON.stringify(shareSafe)).not.toContain("qwen-3.6-27b");
      expect(JSON.stringify(shareSafe)).not.toContain(fx.snapshot.evidence[0]?.evidenceId ?? "");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rejects DeepSeek lanes in any identifier field", async () => {
    const fx = await fixture(new DeterministicMockTriageExecutor());
    try {
      for (const overlay of [
        { model: "deepseek-v3.2" },
        { candidateId: "deepseek-reviewer" },
        { profileId: "profile:DeepSeek-gateway" },
      ]) {
        const req = request(fx.snapshot.id);
        req.candidates[0] = { ...req.candidates[0]!, ...overlay };
        await expect(fx.service.create(fx.caseId, actor, req, "test", false)).rejects.toThrow(
          /DeepSeek lanes are not permitted/,
        );
      }
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("records cancellation instead of fabricating a terminal result", async () => {
    const executor: TriageRunExecutor = {
      execute: async (_context: TriageExecutionContext, signal: AbortSignal): Promise<TriageCandidateRunV1> =>
        await new Promise<TriageCandidateRunV1>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const fx = await fixture(executor);
    try {
      const created = await fx.service.create(fx.caseId, actor, request(fx.snapshot.id), "test", false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const requested = await fx.service.cancel(fx.caseId, created.id, actor, "test", false);
      expect(requested.cancelRequestedAt).not.toBeNull();
      const cancelled = await waitFor(fx.service, fx.caseId, created.id, "cancelled");
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.candidates[0]?.status).toBe("cancelled");
      expect(cancelled.candidates[0]?.outputHash).toBeNull();
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves cancellation when a gateway batch is interrupted", async () => {
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext, signal: AbortSignal): Promise<TriageCandidateRunV1[]> =>
        await new Promise<TriageCandidateRunV1[]>((_resolve, reject) => {
          const abort = () => {
            const candidate = context.request.candidates[0];
            if (candidate) {
              const progress = context.onCandidate?.({
                ...candidate,
                status: "completed",
                benchmarkRunId: "late-run",
                outputHash: "late-output",
                summary: "late callback",
                evidenceRefs: [],
                unknowns: ["usage", "cost"],
                usageStatus: "unknown",
                costStatus: "unknown",
                errorCode: null,
                startedAt: null,
                finishedAt: null,
                privacyClass: "owner_only",
              });
              if (progress) void progress.then(() => reject(new Error("aborted")));
              else reject(new Error("aborted"));
            } else {
              reject(new Error("aborted"));
            }
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    };
    const fx = await fixture(undefined, gatewayExecutor);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          mode: "gateway",
          candidates: [
            {
              candidateId: "gateway-cancelled",
              role: "reviewer",
              provider: "openai-compatible",
              profileId: "profile:test",
              model: "grok-4",
              version: null,
            },
            {
              candidateId: "gateway-cancelled-2",
              role: "challenger",
              provider: "openai-compatible",
              profileId: "profile:test",
              model: "grok-4",
              version: null,
            },
          ],
        },
        "test",
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fx.service.cancel(fx.caseId, created.id, actor, "test", false);
      const cancelled = await waitFor(fx.service, fx.caseId, created.id, "cancelled");
      expect(cancelled.cancelRequestedAt).not.toBeNull();
      expect(cancelled.candidates[0]?.status).toBe("cancelled");
      expect(cancelled.candidates.every((candidate) => candidate.status === "cancelled")).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("retains mixed completed, failed, and timed-out candidates as partial", async () => {
    const executor: TriageRunExecutor = {
      execute: async (context: TriageExecutionContext): Promise<TriageCandidateRunV1> => {
        const status = context.candidate.candidateId.includes("timeout")
          ? "timed_out"
          : context.candidate.candidateId.includes("fail")
            ? "failed"
            : "completed";
        return {
          ...context.candidate,
          status,
          benchmarkRunId: null,
          outputHash: status === "completed" ? "hash-completed" : null,
          summary: status === "completed" ? "Useful synthetic result." : null,
          evidenceRefs: status === "completed" ? [context.snapshot.evidence[0]?.evidenceId ?? ""] : [],
          unknowns: status === "completed" ? ["usage", "cost"] : ["result"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: status === "completed" ? null : status,
          startedAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:00.010Z",
          privacyClass: "owner_only",
        };
      },
    };
    const fx = await fixture(executor);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          candidates: [
            { candidateId: "complete", role: "reviewer", provider: "synthetic", profileId: null, model: "model-a", version: null },
            { candidateId: "fail", role: "contributor", provider: "synthetic", profileId: null, model: "model-b", version: null },
            { candidateId: "timeout", role: "challenger", provider: "synthetic", profileId: null, model: "model-c", version: null },
          ],
        },
        "test",
        false,
      );
      const partial = await waitFor(fx.service, fx.caseId, created.id, "partial");
      expect(partial.candidates.map((candidate) => candidate.status)).toEqual([
        "completed",
        "failed",
        "timed_out",
      ]);
      expect(partial.candidates[1]?.outputHash).toBeNull();
      expect(partial.candidates[2]?.errorCode).toBe("timed_out");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("executes gateway candidates as one batch over the authorized frozen snapshot", async () => {
    let calls = 0;
    let observed: TriageBatchExecutionContext | null = null;
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> => {
        calls += 1;
        observed = context;
        return context.request.candidates.map((candidate) => ({
          ...candidate,
          status: "completed",
          benchmarkRunId: `run-${candidate.candidateId}`,
          outputHash: `hash-${candidate.candidateId}`,
          summary: `Gateway result for ${candidate.role}`,
          evidenceRefs: [context.snapshot.evidence[0]?.evidenceId ?? ""],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:00.010Z",
          privacyClass: "owner_only",
        }));
      },
    };
    const fx = await fixture(undefined, gatewayExecutor);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          mode: "gateway",
          question: "What caused the timeout?",
          candidates: [
            { candidateId: "gateway-a", role: "reviewer", provider: "openai-compatible", profileId: "profile:a", model: "qwen-3.6-27b", version: null },
            { candidateId: "gateway-b", role: "challenger", provider: "openai-compatible", profileId: "profile:a", model: "gpt-oss-120b", version: null },
          ],
        },
        "test",
        false,
      );
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(calls).toBe(1);
      expect(observed?.snapshot.fingerprint).toBe(fx.snapshot.fingerprint);
      expect(observed?.evidence[0]?.contentBase64).toBeTruthy();
      expect(observed?.request.question).toBe("What caused the timeout?");
      expect(observed?.request.concurrency).toBe(2);
      expect(completed.candidates.map((candidate) => candidate.status)).toEqual(["completed", "completed"]);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("exposes queued and admitted gateway lanes while the batch is still running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> => {
        await context.onCandidateStarted?.("gateway-admitted");
        await gate;
        return context.request.candidates.map((candidate) => ({
          ...candidate,
          status: "completed",
          benchmarkRunId: `run-${candidate.candidateId}`,
          outputHash: `hash-${candidate.candidateId}`,
          summary: "Gateway result",
          evidenceRefs: [],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: null,
          finishedAt: null,
          privacyClass: "owner_only",
        }));
      },
    };
    const fx = await fixture(undefined, gatewayExecutor);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          mode: "gateway",
          candidates: [
            { candidateId: "gateway-admitted", role: "reviewer", provider: "openai-compatible", profileId: "profile:a", model: "qwen-3.6-27b", version: null },
            { candidateId: "gateway-queued", role: "challenger", provider: "openai-compatible", profileId: "profile:a", model: "gpt-oss-120b", version: null },
          ],
        },
        "test",
        false,
      );
      let runningJob: Awaited<ReturnType<TriageRunService["get"]>> = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await fx.service.get(fx.caseId, created.id, actor, false);
        if (current?.candidates.some((candidate) => candidate.status === "running")) {
          runningJob = current;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(runningJob?.candidates.map((candidate) => candidate.status)).toEqual(["running", "queued"]);
      release?.();
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(completed.candidates.map((candidate) => candidate.status)).toEqual(["completed", "completed"]);
    } finally {
      release?.();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves a distinct host profile for each gateway lane and rejects unknown catalog ids", async () => {
    let observed: TriageBatchExecutionContext | null = null;
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> => {
        observed = context;
        return context.request.candidates.map((candidate) => ({
          ...candidate,
          status: "completed",
          benchmarkRunId: `run-${candidate.candidateId}`,
          outputHash: `hash-${candidate.candidateId}`,
          summary: "Gateway result",
          evidenceRefs: [],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: null,
          finishedAt: null,
          privacyClass: "owner_only",
        }));
      },
    };
    const profiles: TriageProfileOption[] = [
      { id: "profile:qwen", label: "Qwen gateway", provider: "openai-compatible" },
      { id: "profile:gpt", label: "GPT gateway", provider: "openai-compatible" },
    ];
    const fx = await fixture(undefined, gatewayExecutor, profiles);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          mode: "gateway",
          candidates: [
            { candidateId: "lane-qwen", role: "reviewer", provider: "openai-compatible", profileId: "profile:qwen", model: "qwen-3.6-27b", version: null },
            { candidateId: "lane-gpt", role: "challenger", provider: "openai-compatible", profileId: "profile:gpt", model: "gpt-oss-120b", version: null },
          ],
        },
        "test",
        false,
      );
      await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(observed?.request.candidates.map((candidate) => candidate.profileId)).toEqual([
        "profile:qwen",
        "profile:gpt",
      ]);

      await expect(
        fx.service.create(
          fx.caseId,
          actor,
          {
            ...request(fx.snapshot.id),
            mode: "gateway",
            candidates: [
              { candidateId: "lane-unknown", role: "reviewer", provider: "openai-compatible", profileId: "profile:unknown", model: "qwen-3.6-27b", version: null },
              { candidateId: "lane-known", role: "challenger", provider: "openai-compatible", profileId: "profile:gpt", model: "gpt-oss-120b", version: null },
            ],
          },
          "test",
          false,
        ),
      ).rejects.toThrow("unknown gateway profile for candidate lane-unknown");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("persists an explicit gateway concurrency bound and rejects unsafe values", async () => {
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> =>
        context.request.candidates.map((candidate) => ({
          ...candidate,
          status: "completed",
          benchmarkRunId: `run-${candidate.candidateId}`,
          outputHash: `hash-${candidate.candidateId}`,
          summary: "Gateway result",
          evidenceRefs: [],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: null,
          finishedAt: null,
          privacyClass: "owner_only",
        })),
    };
    const fx = await fixture(undefined, gatewayExecutor);
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id),
          mode: "gateway",
          concurrency: 3,
          candidates: [
            { candidateId: "lane-a", role: "reviewer", provider: "openai-compatible", profileId: "profile:a", model: "qwen-3.6-27b", version: null },
            { candidateId: "lane-b", role: "challenger", provider: "openai-compatible", profileId: "profile:a", model: "gpt-oss-120b", version: null },
          ],
        },
        "test",
        false,
      );
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(completed.request.concurrency).toBe(3);

      await expect(
        fx.service.create(
          fx.caseId,
          actor,
          {
            ...request(fx.snapshot.id),
            mode: "gateway",
            concurrency: 5,
            candidates: [
              { candidateId: "lane-c", role: "reviewer", provider: "openai-compatible", profileId: "profile:a", model: "qwen-3.6-27b", version: null },
              { candidateId: "lane-d", role: "challenger", provider: "openai-compatible", profileId: "profile:a", model: "gpt-oss-120b", version: null },
            ],
          },
          "test",
          false,
        ),
      ).rejects.toThrow("gateway concurrency must be between 1 and 4");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rejects a one-lane gateway job before starting the host bridge", async () => {
    const fx = await fixture(undefined, {
      executeBatch: async (): Promise<TriageCandidateRunV1[]> => [],
    });
    try {
      await expect(
        fx.service.create(
          fx.caseId,
          actor,
          {
            ...request(fx.snapshot.id),
            mode: "gateway",
            candidates: [{
              candidateId: "gateway-only",
              role: "reviewer",
              provider: "openai-compatible",
              profileId: "profile:test",
              model: "grok-4",
              version: null,
            }],
          },
          "test",
          false,
        ),
      ).rejects.toThrow("gateway comparisons require at least 2 candidate lanes");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("persists same-case rerun lineage and rejects a cross-case parent", async () => {
    const fx = await fixture(new DeterministicMockTriageExecutor());
    try {
      const parent = await fx.service.create(fx.caseId, actor, request(fx.snapshot.id), "test", false);
      const child = await fx.service.create(
        fx.caseId,
        actor,
        { ...request(fx.snapshot.id), parentJobId: parent.id },
        "test",
        false,
      );
      expect(child.parentJobId).toBe(parent.id);
      expect(child.request.parentJobId).toBe(parent.id);
      expect((await fx.service.get(fx.caseId, child.id, actor, false))?.parentJobId).toBe(parent.id);

      const otherCase = await fx.cases.createCase(actor, { title: "Other case" }, "test");
      const otherSnapshot = await fx.cases.createSnapshot(
        otherCase.id,
        actor,
        { evidenceIds: [], visibility: "owner_only" },
        "test",
      );
      await expect(
        fx.service.create(
          otherCase.id,
          actor,
          { ...request(otherSnapshot.id), parentJobId: parent.id },
          "test",
          false,
        ),
      ).rejects.toThrow("parent triage job not found for case");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("parses and projects legacy jobs without rerun lineage", async () => {
    const fx = await fixture(new DeterministicMockTriageExecutor());
    try {
      const created = await fx.service.create(fx.caseId, actor, request(fx.snapshot.id), "test", false);
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      const legacy = JSON.parse(JSON.stringify(completed)) as Record<string, unknown>;
      delete legacy.parentJobId;
      delete (legacy.request as Record<string, unknown>).parentJobId;

      const parsed = parseTriageJob(legacy);
      const shareSafe = parseTriageJobShareSafe(projectTriageJobShareSafe(parsed));
      expect(parsed.parentJobId).toBeUndefined();
      expect(parsed.request.parentJobId).toBeUndefined();
      expect(shareSafe.jobId).toBe(completed.id);
      expect(shareSafe.status).toBe("completed");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("never records sameSnapshot=true for unverifiable or unhashed snapshot identity", async () => {
    const fx = await fixture(new DeterministicMockTriageExecutor());
    try {
      const unhashed = await fx.cases.addEvidence(
        fx.caseId,
        actor,
        {
          kind: "file_server_ref",
          uri: "s3://example.invalid/unhashed.log",
          summary: "Reference has no recorded content or expected hash.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const snapshot = await fx.cases.createSnapshot(
        fx.caseId,
        actor,
        { evidenceIds: [unhashed.artifact.id], visibility: "share_safe" },
        "test",
      );
      expect(snapshot.fairnessClass).toBe("unknown");
      const created = await fx.service.create(fx.caseId, actor, request(snapshot.id), "test", false);
      const completed = await waitFor(fx.service, fx.caseId, created.id, "completed");
      expect(completed.sameSnapshot).not.toBe(true);
      expect(completed.sameSnapshot).toBeNull();
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!adminUrl())("pg-backed triage lease integrity", () => {
  it("refuses an expired or recovered worker from updating the job", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "contextdesk-pg-triage-lease-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(client);
      const catalog = new CatalogService(new PgCatalogStore(client), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(client), catalog);
      const jobs = new PgTriageJobStore(client);
      const pgActor = { id: "alice", username: "alice" };
      try {
        const created = await cases.createCase(pgActor, { title: "PG lease fixture" }, "test");
        const artifact = await cases.addEvidence(
          created.id,
          pgActor,
          {
            kind: "log",
            filename: "checkout.log",
            mediaType: "text/plain",
            bytes: new TextEncoder().encode("checkout timeout"),
            summary: "Synthetic checkout timeout.",
            privacyClass: "share_safe",
          },
          "test",
        );
        const snapshot = await cases.createSnapshot(
          created.id,
          pgActor,
          { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
          "test",
        );
        const spec = request(snapshot.id);
        const job: TriageJobV1 = {
          schemaId: "cd-collab.triage_job.v1",
          id: randomUUID(),
          caseId: created.id,
          snapshotId: snapshot.id,
          snapshotFingerprint: snapshot.fingerprint,
          requestFingerprint: "a".repeat(64),
          cancellationId: randomUUID(),
          request: spec,
          status: "queued",
          candidates: [
            {
              ...spec.candidates[0]!,
              status: "queued",
              benchmarkRunId: null,
              outputHash: null,
              summary: null,
              evidenceRefs: [],
              unknowns: [],
              usageStatus: "unknown",
              costStatus: "unknown",
              errorCode: null,
              startedAt: null,
              finishedAt: null,
              privacyClass: "owner_only",
            },
          ],
          sameSnapshot: null,
          agreementNotice: "Agreement is not proof of correctness.",
          requestedBy: pgActor.id,
          requestedByUsername: pgActor.username,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          cancelRequestedAt: null,
          stoppedReason: null,
        };
        await jobs.insert(job);
        const liveUntil = new Date(Date.now() + 60_000).toISOString();
        const claimed = await jobs.claimQueued(job.id, new Date().toISOString(), "worker-a", liveUntil);
        expect(claimed?.workerId).toBe("worker-a");
        const live = (await jobs.get(job.id))!;
        await jobs.update({
          ...live,
          leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
        });
        await expect(jobs.update({
          ...live,
          status: "completed",
          updatedAt: new Date().toISOString(),
        })).rejects.toThrow("triage job not found");
        const recovery = {
          ...(await jobs.get(job.id))!,
          status: "failed" as const,
          stoppedReason: "worker_lease_expired",
          leaseExpiresAt: null,
        };
        expect(await jobs.recoverStale(recovery, new Date().toISOString())).toBe(true);
        await expect(jobs.update({
          ...live,
          status: "completed",
          updatedAt: new Date().toISOString(),
        })).rejects.toThrow("triage job not found");
        expect((await jobs.get(job.id))?.status).toBe("failed");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

async function waitFor(
  service: TriageRunService,
  caseId: string,
  jobId: string,
  status: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.get(caseId, jobId, actor, false);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${status}`);
}
