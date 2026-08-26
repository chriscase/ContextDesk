import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TriageCandidateRunV1, TriageCandidateStatus } from "@cd-collab/contracts";
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
  type TriageExecutionContext,
  type TriageRunExecutor,
} from "./index.js";
import { MemoryTriageJobStore } from "./store.js";

const actor = { id: "lead", username: "lead" };
const TERMINAL = ["completed", "partial", "failed", "timed_out", "cancelled"];

async function fixture(options: {
  executor?: TriageRunExecutor;
  gatewayExecutor?: TriageBatchRunExecutor;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-gateway-reliability-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore(), new CatalogService());
  const service = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.gatewayExecutor ? { gatewayExecutor: options.gatewayExecutor } : {}),
  });
  const created = await cases.createCase(actor, { title: "Gateway reliability" }, "test");
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
  return { root, cases, service, caseId: created.id, snapshot };
}

function request(snapshotId: string, candidateIds: string[]) {
  return {
    schemaId: "cd-collab.triage_job_request.v1" as const,
    snapshotId,
    mode: "deterministic_mock" as const,
    strategyId: "contextdesk.standard",
    question: "What happened and what should we inspect next?",
    policyFingerprint: null,
    taskFingerprint: "task-fingerprint",
    candidates: candidateIds.map((candidateId) => ({
      candidateId,
      role: "reviewer",
      provider: "synthetic",
      profileId: null,
      model: "qwen-3.6-27b",
      version: null,
    })),
  };
}

async function settle(service: TriageRunService, caseId: string, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await service.get(caseId, jobId, actor, false);
    if (job && TERMINAL.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job never settled");
}

/** Gives each lane a fixed terminal outcome, the way an unreliable gateway does. */
function laneOutcomes(outcomes: Record<string, TriageCandidateStatus>): TriageRunExecutor {
  return {
    execute: async (context: TriageExecutionContext): Promise<TriageCandidateRunV1> => {
      const status = outcomes[context.candidate.candidateId] ?? "failed";
      return {
        ...context.candidate,
        status,
        benchmarkRunId: null,
        outputHash: status === "completed" ? "output-hash" : null,
        summary: status === "completed" ? "Synthetic result." : null,
        evidenceRefs: [],
        unknowns: status === "completed" ? ["usage", "cost"] : ["result"],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: status === "completed" ? null : status,
        startedAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:01.000Z",
        privacyClass: "owner_only",
      };
    },
  };
}

describe("triage outcomes on a slow or unreliable gateway", () => {
  it("does not report partial when a deadline and an error left no result", async () => {
    const fx = await fixture({ executor: laneOutcomes({ slow: "timed_out", broken: "failed" }) });
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["slow", "broken"]),
        "test",
        false,
        true,
      );
      const job = await settle(fx.service, fx.caseId, created.id);
      expect(job.candidates.map((candidate) => candidate.status)).toEqual(["timed_out", "failed"]);
      expect(job.status).toBe("failed");
      expect(job.candidates.every((candidate) => candidate.outputHash === null)).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports timed_out only when every lane missed its deadline", async () => {
    const fx = await fixture({ executor: laneOutcomes({ a: "timed_out", b: "timed_out" }) });
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a", "b"]),
        "test",
        false,
        true,
      );
      expect((await settle(fx.service, fx.caseId, created.id)).status).toBe("timed_out");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("keeps partial for a run in which a lane really did produce a result", async () => {
    const fx = await fixture({ executor: laneOutcomes({ good: "completed", slow: "timed_out" }) });
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["good", "slow"]),
        "test",
        false,
        true,
      );
      const job = await settle(fx.service, fx.caseId, created.id);
      expect(job.status).toBe("partial");
      expect(job.candidates[0]?.outputHash).toBe("output-hash");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("attributes a resultless cancelled run to the cancellation, not to partial results", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: TriageRunExecutor = {
      execute: async (context: TriageExecutionContext): Promise<TriageCandidateRunV1> => {
        if (context.candidate.candidateId === "broken") throw new Error("gateway refused the lane");
        await held;
        throw new Error("cancelled");
      },
    };
    const fx = await fixture({ executor });
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["broken", "slow"]),
        "test",
        false,
        true,
      );
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const job = await fx.service.get(fx.caseId, created.id, actor, false);
        if (job?.candidates[0]?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await fx.service.cancel(fx.caseId, created.id, actor, "test", false);
      release?.();
      const job = await settle(fx.service, fx.caseId, created.id);
      expect(job.status).toBe("cancelled");
      expect(job.stoppedReason).toBe("cancel_requested");
      expect(job.candidates.some((candidate) => candidate.status === "failed")).toBe(true);
    } finally {
      release?.();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("records a gateway that never admitted a lane as executed by no lane", async () => {
    const gatewayExecutor: TriageBatchRunExecutor = {
      executeBatch: async (_context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> => {
        throw new Error("gateway runner could not start");
      },
    };
    const fx = await fixture({ gatewayExecutor });
    try {
      const created = await fx.service.create(
        fx.caseId,
        actor,
        {
          ...request(fx.snapshot.id, ["a", "b"]),
          mode: "gateway" as const,
          candidates: request(fx.snapshot.id, ["a", "b"]).candidates.map((candidate) => ({
            ...candidate,
            provider: "openai-compatible",
            profileId: "profile:host",
          })),
        },
        "test",
        false,
        true,
      );
      const job = await settle(fx.service, fx.caseId, created.id);
      expect(job.status).toBe("failed");
      // No lane ever started, so nothing may imply the gateway was reached.
      expect(job.candidates.every((candidate) => candidate.startedAt === null)).toBe(true);
      expect(job.candidates.every((candidate) => candidate.summary === null)).toBe(true);
      expect(job.candidates.every((candidate) => candidate.outputHash === null)).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("duplicate in-flight triage attempts", () => {
  function slowExecutor(hold: Promise<void>): TriageRunExecutor {
    return {
      execute: async (context: TriageExecutionContext): Promise<TriageCandidateRunV1> => {
        await hold;
        return {
          ...context.candidate,
          status: "completed",
          benchmarkRunId: null,
          outputHash: "output-hash",
          summary: "Synthetic result.",
          evidenceRefs: [],
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
          privacyClass: "owner_only",
        };
      },
    };
  }

  it("refuses a second identical attempt while the first is still in flight", async () => {
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture({ executor: slowExecutor(hold) });
    try {
      const first = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a"]),
        "test",
        false,
        true,
      );
      await expect(
        fx.service.create(fx.caseId, actor, request(fx.snapshot.id, ["a"]), "test", false, true),
      ).rejects.toBeInstanceOf(TriageRunConflictError);
      // The refusal names the run already in flight so the operator can open it.
      await expect(
        fx.service.create(fx.caseId, actor, request(fx.snapshot.id, ["a"]), "test", false, true),
      ).rejects.toThrow(first.id);
      expect((await fx.service.list(fx.caseId, actor, false)).length).toBe(1);
      release?.();
      await settle(fx.service, fx.caseId, first.id);
    } finally {
      release?.();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("does not refuse concurrent attempts that differ in any requested detail", async () => {
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture({ executor: slowExecutor(hold) });
    try {
      const first = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a"]),
        "test",
        false,
        true,
      );
      const different = await fx.service.create(
        fx.caseId,
        actor,
        { ...request(fx.snapshot.id, ["a"]), question: "A different question entirely?" },
        "test",
        false,
        true,
      );
      expect(different.id).not.toBe(first.id);
      expect(different.requestFingerprint).not.toBe(first.requestFingerprint);
      release?.();
      await settle(fx.service, fx.caseId, first.id);
      await settle(fx.service, fx.caseId, different.id);
    } finally {
      release?.();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("allows an explicit rerun that names the run it repeats", async () => {
    let release: (() => void) | null = null;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture({ executor: slowExecutor(hold) });
    try {
      const parent = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a"]),
        "test",
        false,
        true,
      );
      // Declaring lineage makes this an informed second attempt, not an accident.
      const rerun = await fx.service.create(
        fx.caseId,
        actor,
        { ...request(fx.snapshot.id, ["a"]), parentJobId: parent.id },
        "test",
        false,
        true,
      );
      expect(rerun.parentJobId).toBe(parent.id);
      // A repeat of that same rerun is an accident again, and is refused.
      await expect(
        fx.service.create(
          fx.caseId,
          actor,
          { ...request(fx.snapshot.id, ["a"]), parentJobId: parent.id },
          "test",
          false,
          true,
        ),
      ).rejects.toThrow(rerun.id);
      release?.();
      await settle(fx.service, fx.caseId, parent.id);
      await settle(fx.service, fx.caseId, rerun.id);
    } finally {
      release?.();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("allows the same attempt again once the earlier one has settled", async () => {
    const fx = await fixture({ executor: laneOutcomes({ a: "failed" }) });
    try {
      const first = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a"]),
        "test",
        false,
        true,
      );
      await settle(fx.service, fx.caseId, first.id);
      // Retrying a failed gateway run is the point; only the in-flight window is guarded.
      const retry = await fx.service.create(
        fx.caseId,
        actor,
        request(fx.snapshot.id, ["a"]),
        "test",
        false,
        true,
      );
      expect(retry.id).not.toBe(first.id);
      await settle(fx.service, fx.caseId, retry.id);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
