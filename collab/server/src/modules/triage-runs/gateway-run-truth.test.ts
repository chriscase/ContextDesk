import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRIAGE_EXECUTABLE_MAX_CANDIDATES,
  TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
  TRIAGE_MAX_PROGRESS_EVENTS,
  TRIAGE_PROGRESS_EVENTS_PER_LANE,
  triageProgressEventBudget,
  triageRunObservation,
  type TriageCandidateRunV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  TriageRunConflictError,
  TriageRunService,
  type TriageBatchExecutionContext,
  type TriageBatchRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore } from "./store.js";

/**
 * A job store that can refuse claims, holding a run in `queued`.
 *
 * "Cancelled before dispatch" has to be established, not hoped for: without
 * this, whether the worker claims the run before the cancel lands is a matter
 * of microtask ordering, and the test would pass or fail for reasons unrelated
 * to the behaviour under test. It refuses rather than blocks on purpose — the
 * claim runs inside the same atomic section a cancel needs, so a claim held
 * open would deadlock the cancel it is meant to let through, which is a
 * property of the test harness and not of the system.
 */
class RefusingClaimStore extends MemoryTriageJobStore {
  private refusing = false;

  refuseClaims(): void {
    this.refusing = true;
  }

  allowClaims(): void {
    this.refusing = false;
  }

  override async claimQueued(
    id: string,
    startedAt: string,
    workerId: string,
    leaseExpiresAt: string,
  ) {
    if (this.refusing) return null;
    return super.claimQueued(id, startedAt, workerId, leaseExpiresAt);
  }
}

/** Waits for a condition the runtime reaches on its own schedule. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition never held: ${label}`);
}
import { MAX_UPLOAD_BYTES } from "../evidence/index.js";

const actor = { id: "lead", username: "lead" };
const TERMINAL = ["completed", "partial", "failed", "timed_out", "cancelled"];

/**
 * A provider-free gateway stand-in.
 *
 * It contacts nothing and reads no evidence bytes. Every reliability property
 * under test here is a host property — admission arithmetic, durable state,
 * lease ownership, cancellation ordering — so a synthetic executor is not a
 * weaker test of them, it is the only one that isolates them.
 */
class SyntheticGateway implements TriageBatchRunExecutor {
  readonly calls: string[] = [];
  constructor(
    private readonly behaviour: (
      context: TriageBatchExecutionContext,
      signal: AbortSignal,
    ) => Promise<TriageCandidateRunV1[]>,
  ) {}

  async executeBatch(
    context: TriageBatchExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1[]> {
    this.calls.push(context.jobId);
    return this.behaviour(context, signal);
  }
}

function settled(
  context: TriageBatchExecutionContext,
  status: TriageCandidateRunV1["status"] = "completed",
): TriageCandidateRunV1[] {
  return context.request.candidates.map((candidate) => ({
    ...candidate,
    status,
    benchmarkRunId: null,
    outputHash: null,
    summary: null,
    evidenceRefs: [],
    unknowns: [],
    usageStatus: "unknown" as const,
    costStatus: "unknown" as const,
    errorCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    privacyClass: "owner_only" as const,
  }));
}

/**
 * Replays the whole documented lane protocol: an admission event and then a
 * settlement event for every lane, which is exactly what the progress budget
 * has to be able to carry.
 */
async function emitFullLaneProtocol(
  context: TriageBatchExecutionContext,
): Promise<TriageCandidateRunV1[]> {
  const results = settled(context);
  for (const result of results) {
    await context.onCandidateStarted?.(result.candidateId);
  }
  for (const result of results) {
    await context.onCandidate?.(result);
  }
  return results;
}

async function fixture(options: {
  gatewayExecutor?: TriageBatchRunExecutor;
  evidenceBytes?: number;
  workerLeaseMs?: number;
  workerId?: string;
  jobs?: MemoryTriageJobStore;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-gateway-run-truth-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore(), new CatalogService());
  const jobs = options.jobs ?? new MemoryTriageJobStore();
  const service = new TriageRunService({
    cases,
    audit,
    jobs,
    ...(options.gatewayExecutor ? { gatewayExecutor: options.gatewayExecutor } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.workerLeaseMs ? { workerLeaseMs: options.workerLeaseMs } : {}),
  });
  const created = await cases.createCase(actor, { title: "Gateway run truth" }, "test");
  // Synthetic filler bytes only; nothing here is derived from real data.
  //
  // Evidence intake caps a single upload well below the gateway's whole-run
  // budget, and that cap belongs to intake rather than to this lane, so the
  // aggregate boundary is reached the way a real investigation reaches it: by
  // freezing several in-bounds artifacts into one snapshot.
  const total = options.evidenceBytes ?? 64;
  const chunks: number[] = [];
  let remaining = total;
  while (remaining > MAX_UPLOAD_BYTES) {
    chunks.push(MAX_UPLOAD_BYTES);
    remaining -= MAX_UPLOAD_BYTES;
  }
  chunks.push(remaining);
  const evidenceIds: string[] = [];
  for (const [index, size] of chunks.entries()) {
    const artifact = await cases.addEvidence(
      created.id,
      actor,
      {
        kind: "log",
        filename: `checkout-${index}.log`,
        mediaType: "text/plain",
        bytes: new Uint8Array(size).fill(0x61),
        summary: `Synthetic checkout log ${index}.`,
        privacyClass: "share_safe",
      },
      "test",
    );
    evidenceIds.push(artifact.artifact.id);
  }
  const snapshot = await cases.createSnapshot(
    created.id,
    actor,
    { evidenceIds, visibility: "share_safe" },
    "test",
  );
  return { root, cases, jobs, service, caseId: created.id, snapshot, evidenceBytes: total };
}

function gatewayRequest(snapshotId: string, laneCount: number, parentJobId?: string) {
  return {
    schemaId: "cd-collab.triage_job_request.v1" as const,
    snapshotId,
    mode: "gateway" as const,
    strategyId: "contextdesk.standard",
    question: "What happened and what should we inspect next?",
    policyFingerprint: null,
    taskFingerprint: "task-fingerprint",
    ...(parentJobId ? { parentJobId } : {}),
    candidates: Array.from({ length: laneCount }, (_, index) => ({
      candidateId: `lane-${index}`,
      role: `reviewer-${index}`,
      provider: "synthetic",
      profileId: "profile:synthetic",
      model: `synthetic-model-${index}`,
      version: null,
    })),
  };
}

/** The persisted facts the shared observation reads, and nothing else. */
function observationOf(job: TriageJobV1) {
  return {
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    parentJobId: job.parentJobId ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    lastProgressAt: job.lastProgressAt ?? null,
    failure: job.failure ?? null,
    candidates: job.candidates.map((candidate) => ({
      status: candidate.status,
      role: candidate.role,
      candidateId: candidate.candidateId,
      startedAt: candidate.startedAt,
    })),
  };
}

async function settle(service: TriageRunService, caseId: string, jobId: string): Promise<TriageJobV1> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = await service.get(caseId, jobId, actor, true);
    if (job && TERMINAL.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("triage job never settled");
}

describe("advertised lane capacity is executable lane capacity", () => {
  it("reports a ceiling it can actually carry", async () => {
    const { root, service } = await fixture({
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
    });
    try {
      const capabilities = service.capabilities();
      expect(capabilities.gatewayMaxCandidates).toBe(TRIAGE_EXECUTABLE_MAX_CANDIDATES);
      expect(capabilities.progressEventsPerLane).toBe(TRIAGE_PROGRESS_EVENTS_PER_LANE);
      expect(capabilities.maxProgressEvents).toBe(TRIAGE_MAX_PROGRESS_EVENTS);
      expect(
        triageProgressEventBudget(capabilities.gatewayMaxCandidates),
      ).toBeLessThanOrEqual(capabilities.maxProgressEvents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 8 was the largest count the old fixed sixteen-event ceiling could carry;
  // 9 was the smallest advertised count it killed; 16 was the advertised top.
  for (const lanes of [1, 8, 9, 16]) {
    it(`runs a ${lanes}-lane comparison to completion with every progress event delivered`, async () => {
      const gateway = new SyntheticGateway(emitFullLaneProtocol);
      const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
      try {
        const created = await service.create(
          caseId,
          actor,
          // A single-lane run is not a gateway comparison; it is still the
          // exact lower capacity boundary and must run in the mode that
          // accepts it.
          lanes === 1
            ? { ...gatewayRequest(snapshot.id, 1), mode: "deterministic_mock" as const, candidates: gatewayRequest(snapshot.id, 1).candidates.map((c) => ({ ...c, profileId: null })) }
            : gatewayRequest(snapshot.id, lanes),
          "test",
          true,
          true,
        );
        const job = await settle(service, caseId, created.id);
        expect(job.candidates).toHaveLength(lanes);
        expect(job.status).toBe("completed");
        expect(job.candidates.every((candidate) => candidate.status === "completed")).toBe(true);
        expect(job.stoppedReason).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("refuses one lane past the executable ceiling before any record exists", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
    try {
      await expect(
        service.create(
          caseId,
          actor,
          gatewayRequest(snapshot.id, TRIAGE_EXECUTABLE_MAX_CANDIDATES + 1),
          "test",
          true,
          true,
        ),
      ).rejects.toBeInstanceOf(TriageRunConflictError);
      // Refused at the door: no job row, and no provider work of any kind.
      expect(await service.list(caseId, actor, true)).toHaveLength(0);
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("an over-budget evidence payload", () => {
  const overBudget = TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES + 1;

  it("fails with the specific budget contract, not a generic runner error", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: gateway,
      evidenceBytes: overBudget,
    });
    try {
      const created = await service.create(
        caseId,
        actor,
        gatewayRequest(snapshot.id, 2),
        "test",
        true,
        true,
      );
      const job = await settle(service, caseId, created.id);
      expect(job.status).toBe("failed");
      expect(job.stoppedReason).toBe("evidence_budget_exceeded");
      expect(job.failure).toEqual({
        code: "evidence_budget_exceeded",
        scope: "aggregate",
        allowedBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
        actualBytes: overBudget,
      });
      for (const candidate of job.candidates) {
        expect(candidate.errorCode).toBe("evidence_budget_exceeded");
        expect(candidate.errorCode).not.toBe("runner_error");
      }
      // Refused on the host: the gateway was never called at all.
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives the operator a bounded explanation with both numbers in it", async () => {
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
      evidenceBytes: overBudget,
    });
    try {
      const created = await service.create(
        caseId,
        actor,
        gatewayRequest(snapshot.id, 2),
        "test",
        true,
        true,
      );
      const job = await settle(service, caseId, created.id);
      const view = triageRunObservation(
        {
          ...job,
          parentJobId: job.parentJobId ?? null,
          candidates: job.candidates.map((candidate) => ({
            status: candidate.status,
            role: candidate.role,
            candidateId: candidate.candidateId,
            startedAt: candidate.startedAt,
          })),
        },
        Date.now(),
      );
      expect(view.state).toBe("failed");
      expect(view.nextAction).toContain("8 MiB");
      expect(view.nextAction).toContain("Nothing was sent to a provider");
      expect(view.nextAction.length).toBeLessThanOrEqual(320);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs normally at exactly the aggregate bound", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: gateway,
      evidenceBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
    });
    try {
      const created = await service.create(
        caseId,
        actor,
        gatewayRequest(snapshot.id, 2),
        "test",
        true,
        true,
      );
      const job = await settle(service, caseId, created.id);
      expect(job.status).toBe("completed");
      expect(job.failure ?? null).toBeNull();
      expect(gateway.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs normally one byte under the aggregate bound", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: gateway,
      evidenceBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES - 1,
    });
    try {
      const created = await service.create(
        caseId,
        actor,
        gatewayRequest(snapshot.id, 2),
        "test",
        true,
        true,
      );
      const job = await settle(service, caseId, created.id);
      expect(job.status).toBe("completed");
      expect(job.failure ?? null).toBeNull();
      expect(gateway.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a slow gateway stays understandable and recoverable", () => {
  it("keeps a queued run readable as queued with nothing to read", async () => {
    // A gateway that never returns: the run is claimed and then simply waits.
    const never = new SyntheticGateway(
      (_context, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: never });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const view = triageRunObservation(observationOf(created), Date.parse(created.createdAt) + 1_000);
      expect(["queued", "running"]).toContain(view.state);
      expect(view.completed).toBe(0);
      expect(view.total).toBe(2);
      expect(view.nextAction).toContain("Nothing has been sent for you to read.");
      await service.cancel(caseId, created.id, actor, "test", true);
      await settle(service, caseId, created.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advances last-progress only on real lane movement, never on a heartbeat", async () => {
    let admitted: (() => void) | null = null;
    const admittedOnce = new Promise<void>((resolve) => { admitted = resolve; });
    const slow = new SyntheticGateway(async (context, signal) => {
      const results = settled(context);
      await context.onCandidateStarted?.(results[0]!.candidateId);
      admitted?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      return results;
    });
    const { root, service, jobs, caseId, snapshot } = await fixture({ gatewayExecutor: slow });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await admittedOnce;
      const afterAdmission = await jobs.get(created.id);
      expect(afterAdmission?.lastProgressAt).toBeTruthy();
      // A heartbeat renewal must move the lease and updatedAt but leave the
      // progress stamp alone: that difference is what makes "stalled" real.
      const renewed = await jobs.renewLease(
        created.id,
        afterAdmission!.workerId!,
        new Date(Date.now() + 120_000).toISOString(),
      );
      expect(renewed).toBe(true);
      const afterHeartbeat = await jobs.get(created.id);
      expect(afterHeartbeat?.lastProgressAt).toBe(afterAdmission?.lastProgressAt);
      expect(Date.parse(afterHeartbeat!.leaseExpiresAt!))
        .toBeGreaterThan(Date.parse(afterAdmission!.leaseExpiresAt!));
      // Read far enough past the last movement and the run is stalled, even
      // though its lease is live.
      const stalled = triageRunObservation(
        observationOf(afterHeartbeat!),
        Date.parse(afterHeartbeat!.lastProgressAt!) + 120_000,
      );
      expect(stalled.state).toBe("stalled");
      await service.cancel(caseId, created.id, actor, "test", true);
      await settle(service, caseId, created.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives a reconnecting reader the same state without starting duplicate work", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const settledJob = await settle(service, caseId, created.id);
      // "Reload": a second read of the same record, with no session state.
      const reread = await service.get(caseId, created.id, actor, true);
      const at = Date.now();
      expect(triageRunObservation(observationOf(reread!), at))
        .toEqual(triageRunObservation(observationOf(settledJob), at));
      // Observing did not dispatch anything a second time.
      expect(gateway.calls).toEqual([created.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("worker leases and the reaper", () => {
  it("settles a run abandoned by a dead host without inventing a result", async () => {
    // A host that died mid-run leaves a claimed record with a lease nobody is
    // renewing. A second host must settle it honestly rather than leave it
    // reading as busy forever — and must not manufacture a lane result.
    const jobs = new MemoryTriageJobStore();
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, cases, service, caseId, snapshot } = await fixture({ jobs, gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await settle(service, caseId, created.id);
      const abandonedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const abandoned: TriageJobV1 = {
        ...(await jobs.get(created.id))!,
        id: "00000000-0000-4000-8000-00000000dead",
        status: "running",
        startedAt: abandonedAt,
        finishedAt: null,
        lastProgressAt: abandonedAt,
        updatedAt: abandonedAt,
        stoppedReason: null,
        workerId: "triage-worker:dead-host",
        leaseExpiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        candidates: (await jobs.get(created.id))!.candidates.map((candidate) => ({
          ...candidate,
          status: "running" as const,
          startedAt: abandonedAt,
          finishedAt: null,
          outputHash: null,
          summary: null,
          evidenceRefs: [],
        })),
      };
      await jobs.insert(abandoned);

      // The record reads as stalled to anyone looking at it right now.
      expect(triageRunObservation(observationOf(abandoned), Date.now()).state).toBe("stalled");

      // A fresh host starts up and reaps it.
      const reaper = new TriageRunService({
        cases,
        audit: new MemoryAuditStore(),
        jobs,
        gatewayExecutor: gateway,
        workerId: "triage-worker:fresh-host",
      });
      await reaper.recoverPending();

      const settledAbandoned = await jobs.get(abandoned.id);
      expect(settledAbandoned?.status).toBe("failed");
      expect(settledAbandoned?.stoppedReason).toBe("worker_lease_expired");
      for (const candidate of settledAbandoned!.candidates) {
        expect(candidate.errorCode).toBe("worker_lease_expired");
        expect(candidate.outputHash).toBeNull();
        expect(candidate.summary).toBeNull();
        expect(candidate.evidenceRefs).toEqual([]);
      }
      // Reaping is not re-running: the dead host's work was not re-dispatched.
      expect(gateway.calls).toEqual([created.id]);
      // And the reaped run reads as terminal, not as stalled, from then on.
      expect(triageRunObservation(observationOf(settledAbandoned!), Date.now()).state).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent when a second host reaps the same abandoned run", async () => {
    const jobs = new MemoryTriageJobStore();
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, cases, service, caseId, snapshot } = await fixture({ jobs, gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await settle(service, caseId, created.id);
      const source = (await jobs.get(created.id))!;
      const abandonedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      await jobs.insert({
        ...source,
        id: "00000000-0000-4000-8000-0000000dead2",
        status: "running",
        startedAt: abandonedAt,
        finishedAt: null,
        lastProgressAt: abandonedAt,
        updatedAt: abandonedAt,
        stoppedReason: null,
        workerId: "triage-worker:dead-host",
        leaseExpiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        candidates: source.candidates.map((candidate) => ({
          ...candidate,
          status: "running" as const,
          startedAt: abandonedAt,
          finishedAt: null,
        })),
      });
      const reaper = (id: string) => new TriageRunService({
        cases,
        audit: new MemoryAuditStore(),
        jobs,
        gatewayExecutor: gateway,
        workerId: id,
      });
      await reaper("triage-worker:first").recoverPending();
      const first = await jobs.get("00000000-0000-4000-8000-0000000dead2");
      await reaper("triage-worker:second").recoverPending();
      const second = await jobs.get("00000000-0000-4000-8000-0000000dead2");
      expect(second?.status).toBe("failed");
      expect(second?.finishedAt).toBe(first?.finishedAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to let a stale worker publish over a settled run", async () => {
    const jobs = new MemoryTriageJobStore();
    const { root, service, caseId, snapshot } = await fixture({
      jobs,
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
    });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const done = await settle(service, caseId, created.id);
      expect(done.status).toBe("completed");
      // A worker that woke up late tries to write its own view of the run.
      await expect(
        jobs.update({
          ...done,
          status: "running",
          finishedAt: null,
          workerId: "some-other-worker",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).rejects.toThrow();
      const after = await service.get(caseId, created.id, actor, true);
      expect(after?.status).toBe("completed");
      expect(after?.finishedAt).toBe(done.finishedAt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("cancellation races and late acknowledgements", () => {
  it("cancels before dispatch without ever calling the gateway", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const jobs = new RefusingClaimStore();
    jobs.refuseClaims();
    const { root, service, caseId, snapshot } = await fixture({ jobs, gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      // No worker took this run, so nothing can have been dispatched from it.
      expect((await jobs.get(created.id))?.status).toBe("queued");
      const cancelled = await service.cancel(caseId, created.id, actor, "test", true);
      expect(cancelled.status).toBe("cancelled");
      jobs.allowClaims();
      const final = await settle(service, caseId, created.id);
      expect(final.status).toBe("cancelled");
      expect(final.candidates.every((candidate) => candidate.status === "cancelled")).toBe(true);
      expect(final.candidates.every((candidate) => candidate.startedAt === null)).toBe(true);
      // Nothing was ever sent: the refusal happened entirely on the host.
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a cancel that races the worker claim instead of losing it", async () => {
    // The reflex on a slow gateway is to cancel the instant after launching,
    // which lands exactly while the worker is claiming the run.
    const gateway = new SyntheticGateway(
      (_context, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const jobs = new MemoryTriageJobStore();
    const { root, service, caseId, snapshot } = await fixture({ jobs, gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      // Cancel only once a worker owns the run, so the cancel is written
      // against a record whose lease ownership differs from the copy the
      // authorization read returned.
      let claimed = await jobs.get(created.id);
      for (let attempt = 0; attempt < 400 && claimed?.status !== "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        claimed = await jobs.get(created.id);
      }
      expect(claimed?.status).toBe("running");
      expect(claimed?.workerId).toBeTruthy();
      const cancelled = await service.cancel(caseId, created.id, actor, "test", true);
      expect(cancelled.status).toBe("cancelled");
      const final = await settle(service, caseId, created.id);
      expect(final.status).toBe("cancelled");
      expect(final.stoppedReason).toBe("cancel_requested");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a late lane result resurrect a cancelled run", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let admitted: (() => void) | null = null;
    const admittedOnce = new Promise<void>((resolve) => { admitted = resolve; });
    const racing = new SyntheticGateway(async (context) => {
      const results = settled(context);
      await context.onCandidateStarted?.(results[0]!.candidateId);
      admitted?.();
      await held;
      // The acknowledgement arrives after the operator already cancelled.
      for (const result of results) await context.onCandidate?.(result);
      return results;
    });
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: racing });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await admittedOnce;
      const cancelled = await service.cancel(caseId, created.id, actor, "test", true);
      expect(cancelled.status).toBe("cancelled");
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = await service.get(caseId, created.id, actor, true);
      expect(after?.status).toBe("cancelled");
      expect(after?.finishedAt).toBe(cancelled.finishedAt);
      expect(after?.candidates.some((candidate) => candidate.status === "completed")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a completed run completed when a cancel arrives at the finish line", async () => {
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
    });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const done = await settle(service, caseId, created.id);
      expect(done.status).toBe("completed");
      const afterCancel = await service.cancel(caseId, created.id, actor, "test", true);
      expect(afterCancel.status).toBe("completed");
      expect(afterCancel.cancelRequestedAt).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("duplicate requests and retry", () => {
  it("refuses a second identical launch while the first is still in flight", async () => {
    const gateway = new SyntheticGateway(
      (_context, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
    try {
      const first = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await until(() => gateway.calls.length > 0, "first run dispatched");
      await expect(
        service.create(caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true),
      ).rejects.toBeInstanceOf(TriageRunConflictError);
      // One record, one dispatch: the reload-and-relaunch reflex costs nothing.
      expect(await service.list(caseId, actor, true)).toHaveLength(1);
      expect(gateway.calls).toEqual([first.id]);
      await service.cancel(caseId, first.id, actor, "test", true);
      await settle(service, caseId, first.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows an explicit retry that names the run it repeats", async () => {
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
    try {
      const first = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await settle(service, caseId, first.id);
      const retry = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2, first.id), "test", true, true,
      );
      expect(retry.parentJobId).toBe(first.id);
      const done = await settle(service, caseId, retry.id);
      expect(done.status).toBe("completed");
      expect(gateway.calls).toEqual([first.id, retry.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a repeat of the same retry while that retry is in flight", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const gateway = new SyntheticGateway(async (context) => {
      const results = settled(context);
      if (context.request.parentJobId) await held;
      return results;
    });
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: gateway });
    try {
      const first = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      await settle(service, caseId, first.id);
      const retry = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2, first.id), "test", true, true,
      );
      await expect(
        service.create(caseId, actor, gatewayRequest(snapshot.id, 2, first.id), "test", true, true),
      ).rejects.toBeInstanceOf(TriageRunConflictError);
      release?.();
      await settle(service, caseId, retry.id);
      expect(gateway.calls).toEqual([first.id, retry.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("what an operator is shown never carries run content", () => {
  it("keeps a queued run that timed out waiting readable and resultless", async () => {
    // A gateway that refuses every claim leaves the run queued indefinitely.
    // The reader must be told nothing is available rather than shown a spinner
    // that implies work is happening.
    const gateway = new SyntheticGateway(emitFullLaneProtocol);
    const jobs = new RefusingClaimStore();
    jobs.refuseClaims();
    const { root, service, caseId, snapshot } = await fixture({ jobs, gatewayExecutor: gateway });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const longWait = Date.parse(created.createdAt) + 30 * 60_000;
      const view = triageRunObservation(observationOf((await jobs.get(created.id))!), longWait);
      expect(view.state).toBe("queued");
      expect(view.completed).toBe(0);
      expect(view.lane).toBeNull();
      expect(view.elapsedMs).toBeGreaterThanOrEqual(30 * 60_000);
      expect(view.nextAction).toContain("Nothing has been sent for you to read.");
      expect(gateway.calls).toHaveLength(0);
      await service.cancel(caseId, created.id, actor, "test", true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores only numbers for an evidence refusal, never host or provider text", async () => {
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
      evidenceBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES + 1,
    });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const job = await settle(service, caseId, created.id);
      // The whole durable failure record: a code, a scope, and two integers.
      expect(Object.keys(job.failure ?? {}).sort())
        .toEqual(["actualBytes", "allowedBytes", "code", "scope"]);
      const serialized = JSON.stringify(job);
      // No filesystem path, stack frame, or host detail rode along with it.
      expect(serialized).not.toMatch(/\/(tmp|home|usr|var)\//);
      expect(serialized).not.toMatch(/\bat [A-Za-z]+ \(/);
      expect(serialized).not.toMatch(/node_modules/);
      expect(serialized).not.toMatch(/Error:/);
      for (const candidate of job.candidates) {
        expect(candidate.summary).toBeNull();
        expect(candidate.outputHash).toBeNull();
        expect(candidate.evidenceRefs).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps usage and cost reported as unknown rather than estimated", async () => {
    const { root, service, caseId, snapshot } = await fixture({
      gatewayExecutor: new SyntheticGateway(emitFullLaneProtocol),
    });
    try {
      const capabilities = service.capabilities();
      expect(capabilities.usageAvailable).toBe(false);
      expect(capabilities.costAvailable).toBe(false);
      expect(capabilities.unavailable.join(" ")).toContain("cost");
      expect(capabilities.cancellationSupported).toBe(true);
      expect(capabilities.retrySemantics).toBe("explicit_rerun_idempotent");
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 2), "test", true, true,
      );
      const job = await settle(service, caseId, created.id);
      for (const candidate of job.candidates) {
        expect(candidate.usageStatus).toBe("unknown");
        expect(candidate.costStatus).toBe("unknown");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never turns lane agreement into a finding", async () => {
    // Every lane returning the same thing is still not evidence of anything,
    // and the record must keep saying so.
    const identical = new SyntheticGateway(async (context) => {
      const results = settled(context).map((result) => ({
        ...result,
        outputHash: "identical-output-hash",
        summary: "the same conclusion",
      }));
      for (const result of results) await context.onCandidateStarted?.(result.candidateId);
      for (const result of results) await context.onCandidate?.(result);
      return results;
    });
    const { root, service, caseId, snapshot } = await fixture({ gatewayExecutor: identical });
    try {
      const created = await service.create(
        caseId, actor, gatewayRequest(snapshot.id, 3), "test", true, true,
      );
      const job = await settle(service, caseId, created.id);
      expect(job.status).toBe("completed");
      expect(job.agreementNotice).toBe("Agreement is not proof of correctness.");
      const serialized = JSON.stringify(job);
      expect(serialized).not.toMatch(/winner|consensus|majority|verdict|confirmed_by/i);
      const view = triageRunObservation(observationOf(job), Date.now());
      expect(view.nextAction).toContain("agreement between lanes is not proof");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
