import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkstreamList } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { DeterministicMockTriageExecutor, TriageRunService } from "./index.js";
import { MemoryTriageJobStore } from "./store.js";
import { listCaseWorkstreams } from "./workstreams.js";

const lead = { id: "lead", username: "lead" };
const outsider = { id: "outsider", username: "outsider" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-workstreams-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore(), new CatalogService());
  const runs = new TriageRunService({
    cases,
    audit,
    jobs: new MemoryTriageJobStore(),
    executor: new DeterministicMockTriageExecutor(),
  });
  const created = await cases.createCase(lead, { title: "Workstream projection" }, "test");
  const artifact = await cases.addEvidence(
    created.id,
    lead,
    {
      kind: "log",
      filename: "checkout.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("checkout request timed out waiting on inventory\n"),
      summary: "Synthetic checkout timeout excerpt.",
      privacyClass: "share_safe",
    },
    "test",
    true,
    true,
  );
  const snapshot = await cases.createSnapshot(
    created.id,
    lead,
    { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
    "test",
    true,
    true,
  );
  await runs.create(
    created.id,
    lead,
    {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: snapshot.id,
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard.synthetic",
      question: "What caused the checkout timeout and what should we inspect next?",
      policyFingerprint: null,
      taskFingerprint: "task-fingerprint",
      candidates: [
        {
          candidateId: "reviewer-lane",
          role: "reviewer",
          provider: "synthetic",
          profileId: null,
          model: "fixture-reviewer-a",
          version: null,
        },
      ],
    },
    "test",
    true,
    true,
  );
  // The deterministic executor settles lanes on the next tick.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { root, cases, runs, caseId: created.id, evidenceId: artifact.artifact.id };
}

describe("readable case workstreams", () => {
  it("projects one addressable workstream per recorded lane", async () => {
    const f = await fixture();
    try {
      const list = parseWorkstreamList(
        await listCaseWorkstreams({
          cases: f.cases,
          runs: f.runs,
          caseId: f.caseId,
          actor: lead,
          isAdmin: false,
        }),
      );
      expect(list.caseId).toBe(f.caseId);
      expect(list.workstreams).toHaveLength(1);
      const [view] = list.workstreams;
      expect(view?.label).toBe("Reviewer simulation — fixture-reviewer-a");
      expect(view?.operatorLabel).toContain("did not run the named model");
      expect(view?.findings).toBeNull();
      expect(view?.outcome).toContain("no investigative finding or evidence citation");
      expect(view?.purpose).toContain("checkout timeout");
      expect(view?.assignedTo).toBe("lead");
      expect(view?.strategyLabel).toBe("Standard synthetic strategy");
      expect(view?.key).toBe(`${view?.technical.runId}:reviewer-lane`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("never turns frozen inputs into citations for a provider-free simulation", async () => {
    const f = await fixture();
    try {
      const list = await listCaseWorkstreams({
        cases: f.cases,
        runs: f.runs,
        caseId: f.caseId,
        actor: lead,
        isAdmin: false,
      });
      const cited = list.workstreams[0]?.evidenceCited ?? [];
      expect(cited).toEqual([]);
      expect(list.workstreams[0]?.inputs.snapshotEvidenceCount).toBe(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("records chronological activity that names the requester", async () => {
    const f = await fixture();
    try {
      const list = await listCaseWorkstreams({
        cases: f.cases,
        runs: f.runs,
        caseId: f.caseId,
        actor: lead,
        isAdmin: false,
      });
      const activity = list.workstreams[0]?.activity ?? [];
      expect(activity.length).toBeGreaterThanOrEqual(2);
      expect(activity[0]).toMatchObject({ label: "Run queued", actor: "lead" });
      const stamps = activity.map((entry) => entry.at ?? "");
      expect(stamps).toEqual([...stamps].sort());
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns nothing for a caller who cannot read the investigation", async () => {
    const f = await fixture();
    try {
      const list = await listCaseWorkstreams({
        cases: f.cases,
        runs: f.runs,
        caseId: f.caseId,
        actor: outsider,
        isAdmin: false,
      });
      expect(list.workstreams).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an investigation that does not exist", async () => {
    const f = await fixture();
    try {
      const list = await listCaseWorkstreams({
        cases: f.cases,
        runs: f.runs,
        caseId: "00000000-0000-4000-8000-000000000000",
        actor: lead,
        isAdmin: false,
      });
      expect(list.workstreams).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
