import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQualificationReport, renderQualificationSummary } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "../experiments/index.js";
import { MAX_UPLOAD_BYTES } from "../evidence/index.js";
import { inspectLiveProfiles } from "./live.js";
import { runQualification } from "./harness.js";

const actor = { id: "uid=qual,ou=people,dc=example,dc=test", username: "qual" };

async function withMemory(fn: (deps: { cases: CaseService; experiments: ExperimentService }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-qual-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(store, audit, undefined, catalog);
  const experiments = new ExperimentService({ cases, audit, experiments: new MemoryExperimentStore() });
  try {
    await fn({ cases, experiments });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("collaborative triage qualification harness", () => {
  it("runs the hermetic workflow on current Experiment Lab seams", async () => {
    await withMemory(async ({ cases, experiments }) => {
      const report = parseQualificationReport(await runQualification({ cases, experiments, backend: "memory" }));
      expect(report.steps.every((step) => step.status === "passed")).toBe(true);
      expect(report.steps.map((step) => step.id)).toEqual([
        "start_case", "freeze_evidence", "host_owned_lanes", "host_lane_interrupts",
        "import_host_package", "import_external_chat", "compare_and_decide", "export_share_safe", "lineage_rerun",
      ]);
      expect(report.concurrency.sameSnapshot).toBe(true);
      expect(report.concurrency.durableRunCount).toBeGreaterThanOrEqual(2);
      expect(report.comparison.sharedEvidenceCount).toBeGreaterThan(0);
      expect(report.comparison.uniqueEvidenceCount).toBeGreaterThan(0);
      expect(report.comparison.disagreementCount).toBeGreaterThan(0);
      expect(report.comparison.questionPathCount).toBeGreaterThan(0);
      expect(report.comparison.helpfulnessRecorded).toBe(true);
      expect(report.comparison.goldAligned).toBe(true);
      expect(report.comparison.acceptedDecision).toBe(true);
      expect(report.lineage.successorPackageAlias).toContain("v2");
      expect(report.liveProfiles).toHaveLength(4);
      expect(report.liveProfiles.every((profile) => !profile.ran && profile.skippedReason !== null)).toBe(true);
      expect(renderQualificationSummary(report)).toContain("backend=memory");
      expect(JSON.stringify(report)).not.toMatch(/sk-|Bearer |api_key|rawCapture|"prompt"/i);
    });
  });

  it("keeps live profiles honest when configured but no host is invoked", async () => {
    expect(inspectLiveProfiles({}).every((profile) => !profile.ran && profile.skippedReason === "credentials_not_configured")).toBe(true);
    await withMemory(async ({ cases, experiments }) => {
      const report = await runQualification({
        cases,
        experiments,
        backend: "memory",
        liveEnv: {
          COLLAB_LIVE_PROFILES: "gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512",
          COLLAB_LIVE_VERCEL: "1",
        },
      });
      expect(report.liveProfiles.every((profile) => profile.configured && !profile.ran)).toBe(true);
      expect(report.liveProfiles.every((profile) => profile.skippedReason === "opt_in_host_not_invoked_in_hermetic_suite")).toBe(true);
    });
  });

  it("refuses oversized, disallowed, and traversing evidence", async () => {
    await withMemory(async ({ cases }) => {
      const created = await cases.createCase(actor, { title: "limits" }, "test");
      await expect(cases.addEvidence(created.id, actor, {
        kind: "log", filename: "../../etc/passwd", mediaType: "text/plain", bytes: Buffer.from("x"), summary: "bad name",
      }, "test")).rejects.toThrow(/path segment/);
      await expect(cases.addEvidence(created.id, actor, {
        kind: "log", filename: "ok.log", mediaType: "application/javascript", bytes: Buffer.from("x"), summary: "bad type",
      }, "test")).rejects.toThrow(/allowlisted/);
      await expect(cases.addEvidence(created.id, actor, {
        kind: "log", filename: "huge.log", mediaType: "text/plain", bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1), summary: "too big",
      }, "test")).rejects.toThrow(/size cap/);
    });
  });
});
