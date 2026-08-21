import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type {
  LiveQualificationCatalogV1,
  TriageCandidateRunV1,
} from "@cd-collab/contracts";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "../cases/index.js";
import {
  TriageRunService,
  MemoryTriageJobStore,
  type TriageBatchExecutionContext,
  type TriageBatchRunExecutor,
} from "../triage-runs/index.js";
import { runLiveQualification } from "./live-runner.js";

const catalog: LiveQualificationCatalogV1 = {
  schemaId: "cd-collab.live_qualification_catalog.v1",
  privacyClass: "share_safe",
  profiles: [
    {
      alias: "gpt-oss-120b",
      profileId: "employer-gpt-oss-120b",
      modelId: "gpt-oss-120b",
      provider: "employer-gateway",
      label: "Employer GPT OSS",
    },
    {
      alias: "qwen-3.6-27b",
      profileId: "employer-qwen-3.6-27b",
      modelId: "qwen-3.6-27b",
      provider: "employer-gateway",
      label: "Employer Qwen",
    },
    {
      alias: "ministral-3-14b-instruct-2512",
      profileId: "employer-ministral-3-14b-instruct-2512",
      modelId: "ministral-3-14b-instruct-2512",
      provider: "employer-gateway",
      label: "Employer Ministral",
    },
  ],
};

async function fixture(executor: TriageBatchRunExecutor) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-live-runner-"));
  const audit = new MemoryAuditStore();
  const cases = new CaseService(
    new FilesystemEvidenceStore({ rootDir: root }),
    audit,
    undefined,
    new CatalogService(undefined, audit),
  );
  const triageRuns = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    gatewayExecutor: executor,
    profiles: catalog.profiles.map((profile) => ({
      id: profile.profileId,
      label: profile.label,
      provider: profile.provider,
    })),
  });
  return { root, cases, triageRuns };
}

describe("live qualification runner", () => {
  it("does not invoke a bridge without explicit live opt-in", async () => {
    let calls = 0;
    const fx = await fixture({
      executeBatch: async () => {
        calls += 1;
        return [];
      },
    });
    try {
      const report = await runLiveQualification({
        ...fx,
        catalog,
        liveOptIn: false,
        confirmed: false,
        concurrency: 2,
      });
      expect(calls).toBe(0);
      expect(report.verdict).toBe("skipped");
      expect(report.lanes.every((lane) => lane.status === "skipped" && lane.skippedReason === "live_disabled")).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("runs selected profiles through the same-snapshot gateway seam", async () => {
    const observed: { snapshot: string; concurrency: number | undefined }[] = [];
    const executor: TriageBatchRunExecutor = {
      executeBatch: async (context: TriageBatchExecutionContext): Promise<TriageCandidateRunV1[]> => {
        observed.push({ snapshot: context.snapshot.fingerprint, concurrency: context.request.concurrency });
        return context.request.candidates.map((candidate) => ({
          ...candidate,
          status: "completed",
          benchmarkRunId: `durable-${candidate.candidateId}`,
          outputHash: "a".repeat(64),
          summary: "host summary is deliberately not exported",
          evidenceRefs: context.evidence.map((item) => item.evidenceId),
          unknowns: ["usage", "cost"],
          usageStatus: "unknown",
          costStatus: "unknown",
          errorCode: null,
          startedAt: "2026-08-20T00:00:00.000Z",
          finishedAt: "2026-08-20T00:00:01.000Z",
          privacyClass: "owner_only",
        }));
      },
    };
    const fx = await fixture(executor);
    try {
      const report = await runLiveQualification({
        ...fx,
        catalog,
        aliases: ["gpt-oss-120b", "qwen-3.6-27b"],
        liveOptIn: true,
        confirmed: true,
        concurrency: 2,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.concurrency).toBe(2);
      expect(report.verdict).toBe("completed");
      expect(report.concurrency.sameSnapshot).toBe(true);
      expect(report.concurrency.observedMaxActive).toBe(2);
      expect(report.lanes.every((lane) => lane.ran && lane.status === "completed")).toBe(true);
      expect(report.lanes.map((lane) => lane.modelId)).toEqual(["gpt-oss-120b", "qwen-3.6-27b"]);
      expect(JSON.stringify(report)).not.toContain("host summary");
      expect(JSON.stringify(report)).not.toContain("durable-");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports insufficient configured lanes without calling the bridge", async () => {
    let calls = 0;
    const fx = await fixture({
      executeBatch: async () => {
        calls += 1;
        return [];
      },
    });
    try {
      const report = await runLiveQualification({
        ...fx,
        catalog: { ...catalog, profiles: [catalog.profiles[0]!] },
        aliases: ["gpt-oss-120b"],
        liveOptIn: true,
        confirmed: true,
        concurrency: 1,
      });
      expect(calls).toBe(0);
      expect(report.verdict).toBe("skipped");
      expect(report.lanes[0]?.skippedReason).toBe("not_enough_profiles");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
