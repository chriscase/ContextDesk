import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import {
  DeterministicMockTriageExecutor,
  TriageRunService,
  type TriageCandidateRunV1,
  type TriageExecutionContext,
  type TriageRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore, PgTriageJobStore } from "./store.js";

const ALICE = { id: "alice", username: "alice" };
const dirs: string[] = [];
const hanging: HangingTriageExecutor[] = [];

afterEach(async () => {
  for (const executor of hanging.splice(0)) executor.release();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class InjectedFailureStore extends MemoryCaseStore {
  failTimelineKind: string | null = null;
  override async appendTimeline(
    caseId: string,
    event: Parameters<MemoryCaseStore["appendTimeline"]>[1],
  ): Promise<Awaited<ReturnType<MemoryCaseStore["appendTimeline"]>>> {
    if (this.failTimelineKind && event.kind === this.failTimelineKind) {
      throw new Error(`injected timeline failure:${event.kind}`);
    }
    return super.appendTimeline(caseId, event);
  }
}

class InjectedFailureAudit extends MemoryAuditStore {
  failAction: string | null = null;
  override async append(
    record: Parameters<MemoryAuditStore["append"]>[0],
  ): ReturnType<MemoryAuditStore["append"]> {
    if (this.failAction && record.action === this.failAction) {
      throw new Error(`injected audit failure:${record.action}`);
    }
    return super.append(record);
  }
}

class CountingTriageExecutor implements TriageRunExecutor {
  calls = 0;
  async execute(
    context: TriageExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1> {
    this.calls += 1;
    return new DeterministicMockTriageExecutor().execute(context, signal);
  }
}

class HangingTriageExecutor implements TriageRunExecutor {
  readonly started: Promise<void>;
  private resolveStarted: () => void;
  private settle: ((error: Error) => void) | null = null;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  release(): void {
    this.settle?.(new Error("test harness released hanging executor"));
    this.settle = null;
  }

  async execute(
    _context: TriageExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1> {
    this.resolveStarted();
    return await new Promise((_resolve, reject) => {
      this.settle = reject;
      const onAbort = () => {
        this.settle = null;
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
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
        role: "reviewer" as const,
        provider: "synthetic",
        profileId: null,
        model: "qwen-3.6-27b",
        version: null,
      },
    ],
  };
}

async function harness(
  store: MemoryCaseStore = new MemoryCaseStore(),
  audit: MemoryAuditStore = new MemoryAuditStore(),
  executor: TriageRunExecutor = new CountingTriageExecutor(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-triage-atomic-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const cases = new CaseService(evidence, audit, store);
  const jobs = new MemoryTriageJobStore();
  const service = new TriageRunService({ cases, audit, jobs, executor });
  const created = await cases.createCase(ALICE, { title: "Synthetic triage atomicity" }, "test");
  const artifact = await cases.addEvidence(
    created.id,
    ALICE,
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
    ALICE,
    { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
    "test",
  );
  return { cases, service, jobs, audit, executor, caseId: created.id, snapshot };
}

async function waitUntilSettled(
  jobs: { get(id: string): Promise<{ status: string } | null> },
  jobId: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await jobs.get(jobId);
    if (job && job.status !== "queued" && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for a terminal triage job");
}

describe("triage mutation atomicity", () => {
  it("rolls back a triage job insert when timeline projection fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "triage_job_created";
    const executor = new CountingTriageExecutor();
    const { cases, service, jobs, audit, caseId, snapshot } = await harness(
      store,
      new MemoryAuditStore(),
      executor,
    );
    await expect(
      service.create(caseId, ALICE, request(snapshot.id), "test", false, true),
    ).rejects.toThrow(/injected timeline failure:triage_job_created/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await jobs.listByCase(caseId)).toEqual([]);
    const timeline = await cases.listTimeline(caseId);
    expect(timeline.some((event) => event.kind === "triage_job_created")).toBe(false);
    expect((await audit.list({ action: "triage_job_create" })).length).toBe(0);
    expect(executor.calls).toBe(0);
  });

  it("rolls back a triage job insert when audit append fails", async () => {
    const audit = new InjectedFailureAudit();
    audit.failAction = "triage_job_create";
    const executor = new CountingTriageExecutor();
    const { cases, service, jobs, caseId, snapshot } = await harness(
      new MemoryCaseStore(),
      audit,
      executor,
    );
    await expect(
      service.create(caseId, ALICE, request(snapshot.id), "test", false, true),
    ).rejects.toThrow(/injected audit failure:triage_job_create/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await jobs.listByCase(caseId)).toEqual([]);
    const timeline = await cases.listTimeline(caseId);
    expect(timeline.some((event) => event.kind === "triage_job_created")).toBe(false);
    expect((await audit.list({ action: "triage_job_create" })).length).toBe(0);
    expect(executor.calls).toBe(0);
  });

  it("rolls back cancel when timeline projection fails", async () => {
    const store = new InjectedFailureStore();
    const executor = new HangingTriageExecutor();
    hanging.push(executor);
    store.failTimelineKind = "triage_job_cancel_requested";
    const { cases, service, jobs, audit, caseId, snapshot } = await harness(
      store,
      new MemoryAuditStore(),
      executor,
    );
    const created = await service.create(caseId, ALICE, request(snapshot.id), "test", false, true);
    await executor.started;
    await expect(
      service.cancel(caseId, created.id, ALICE, "test", false),
    ).rejects.toThrow(/injected timeline failure:triage_job_cancel_requested/);
    const job = await jobs.get(created.id);
    expect(job).not.toBeNull();
    expect(job?.status).not.toBe("cancelled");
    expect(job?.cancelRequestedAt).toBeNull();
    const timeline = await cases.listTimeline(caseId);
    expect(timeline.some((event) => event.kind === "triage_job_cancel_requested")).toBe(false);
    expect((await audit.list({ action: "triage_job_cancel" })).length).toBe(0);
  });

  it("does not keep a completed candidate when candidate-finished timeline fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "triage_candidate_finished";
    const { cases, service, jobs, caseId, snapshot } = await harness(store);
    const created = await service.create(caseId, ALICE, request(snapshot.id), "test", false, true);
    const settled = await waitUntilSettled(jobs, created.id);
    expect(settled.candidates.every((candidate) => candidate.status !== "completed")).toBe(true);
    const timeline = await cases.listTimeline(caseId);
    expect(timeline.some((event) => event.kind === "triage_candidate_finished")).toBe(false);
  });

  it("does not mark a job completed when finish timeline projection fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "triage_job_finished";
    const { cases, service, jobs, audit, caseId, snapshot } = await harness(store);
    const created = await service.create(caseId, ALICE, request(snapshot.id), "test", false, true);
    const settled = await waitUntilSettled(jobs, created.id);
    expect(settled.status).not.toBe("completed");
    const timeline = await cases.listTimeline(caseId);
    expect(timeline.some((event) => event.kind === "triage_job_finished")).toBe(false);
    expect((await audit.list({ action: "triage_job_finish" })).length).toBe(0);
  });
});

describe.skipIf(!adminUrl())("postgres triage mutation atomicity", () => {
  it("rolls back a PostgreSQL triage job insert with the case transaction", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-triage-atomic-"));
      dirs.push(root);
      class InjectedPgCaseStore extends PgCaseStore {
        failTimelineKind: string | null = null;
        override async appendTimeline(
          caseId: string,
          event: Parameters<PgCaseStore["appendTimeline"]>[1],
        ): Promise<Awaited<ReturnType<PgCaseStore["appendTimeline"]>>> {
          if (this.failTimelineKind && event.kind === this.failTimelineKind) {
            throw new Error(`injected timeline failure:${event.kind}`);
          }
          return super.appendTimeline(caseId, event);
        }
      }
      const caseStore = new InjectedPgCaseStore(pool);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      const jobs = new PgTriageJobStore(pool);
      const executor = new CountingTriageExecutor();
      const service = new TriageRunService({ cases, audit, jobs, executor });
      try {
        const created = await cases.createCase(ALICE, { title: "PG triage atomicity" }, "test");
        const artifact = await cases.addEvidence(
          created.id,
          ALICE,
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
          ALICE,
          { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
          "test",
        );
        caseStore.failTimelineKind = "triage_job_created";
        await expect(
          service.create(created.id, ALICE, request(snapshot.id), "test", false, true),
        ).rejects.toThrow(/injected timeline failure:triage_job_created/);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await jobs.listByCase(created.id)).toEqual([]);
        const timeline = await cases.listTimeline(created.id);
        expect(timeline.some((event) => event.kind === "triage_job_created")).toBe(false);
        expect((await audit.list({ action: "triage_job_create" })).length).toBe(0);
        expect(executor.calls).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });

  it("rolls back a PostgreSQL cancel with the case transaction", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-triage-cancel-atomic-"));
      dirs.push(root);
      class InjectedPgCaseStore extends PgCaseStore {
        failTimelineKind: string | null = null;
        override async appendTimeline(
          caseId: string,
          event: Parameters<PgCaseStore["appendTimeline"]>[1],
        ): Promise<Awaited<ReturnType<PgCaseStore["appendTimeline"]>>> {
          if (this.failTimelineKind && event.kind === this.failTimelineKind) {
            throw new Error(`injected timeline failure:${event.kind}`);
          }
          return super.appendTimeline(caseId, event);
        }
      }
      const caseStore = new InjectedPgCaseStore(pool);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      const jobs = new PgTriageJobStore(pool);
      const executor = new HangingTriageExecutor();
      hanging.push(executor);
      const service = new TriageRunService({ cases, audit, jobs, executor });
      try {
        const created = await cases.createCase(ALICE, { title: "PG triage cancel atomicity" }, "test");
        const artifact = await cases.addEvidence(
          created.id,
          ALICE,
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
          ALICE,
          { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
          "test",
        );
        const job = await service.create(created.id, ALICE, request(snapshot.id), "test", false, true);
        await executor.started;
        caseStore.failTimelineKind = "triage_job_cancel_requested";
        await expect(
          service.cancel(created.id, job.id, ALICE, "test", false),
        ).rejects.toThrow(/injected timeline failure:triage_job_cancel_requested/);
        const latest = await jobs.get(job.id);
        expect(latest).not.toBeNull();
        expect(latest?.status).not.toBe("cancelled");
        expect(latest?.cancelRequestedAt).toBeNull();
        const timeline = await cases.listTimeline(created.id);
        expect(timeline.some((event) => event.kind === "triage_job_cancel_requested")).toBe(false);
        expect((await audit.list({ action: "triage_job_cancel" })).length).toBe(0);
      } finally {
        executor.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await pool.end();
      }
    });
  });
});
