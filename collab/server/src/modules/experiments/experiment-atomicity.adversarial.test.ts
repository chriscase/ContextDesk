import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const here = dirname(fileURLToPath(import.meta.url));
const SUMMARY = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-summary.valid.json"),
    "utf8",
  ),
) as unknown;

const dirs: string[] = [];

afterEach(async () => {
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

async function harness(
  store: MemoryCaseStore = new MemoryCaseStore(),
  audit: MemoryAuditStore = new MemoryAuditStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-experiment-atomic-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const cases = new CaseService(evidence, audit, store);
  const experiments = new MemoryExperimentStore();
  const service = new ExperimentService({ cases, audit, experiments });
  return { cases, service, experiments, audit };
}

describe("experiment mutation atomicity", () => {
  it("rolls back a proposed decision when timeline projection fails", async () => {
    const store = new InjectedFailureStore();
    const { cases, service, experiments, audit } = await harness(store);
    const created = await cases.createCase(ALICE, { title: "Synthetic decision atomicity" }, "test");
    const imported = await service.importEnvelope(created.id, ALICE, SUMMARY, "test", false);
    store.failTimelineKind = "experiment_decision_proposed";
    await expect(
      service.proposeDecision(
        created.id,
        imported.id,
        ALICE,
        {
          text: "Inspect the synthetic timeout path before changing capacity.",
          rationale: "Timeline failure must not leave a durable decision.",
          evidenceRefs: [],
        },
        "test",
        false,
      ),
    ).rejects.toThrow(/injected timeline failure:experiment_decision_proposed/);
    expect(await experiments.listDecisions(imported.id)).toEqual([]);
    const timeline = await cases.listTimeline(created.id);
    expect(timeline.some((event) => event.kind === "experiment_decision_proposed")).toBe(false);
    expect((await audit.list({ action: "experiment_decision_propose" })).length).toBe(0);
  });

  it("rolls back a proposed decision when audit append fails", async () => {
    const audit = new InjectedFailureAudit();
    const { cases, service, experiments } = await harness(new MemoryCaseStore(), audit);
    const created = await cases.createCase(ALICE, { title: "Synthetic decision audit atomicity" }, "test");
    const imported = await service.importEnvelope(created.id, ALICE, SUMMARY, "test", false);
    audit.failAction = "experiment_decision_propose";
    await expect(
      service.proposeDecision(
        created.id,
        imported.id,
        ALICE,
        {
          text: "Inspect the synthetic timeout path before changing capacity.",
          rationale: "Audit failure must not leave a durable decision.",
          evidenceRefs: [],
        },
        "test",
        false,
      ),
    ).rejects.toThrow(/injected audit failure:experiment_decision_propose/);
    expect(await experiments.listDecisions(imported.id)).toEqual([]);
    const timeline = await cases.listTimeline(created.id);
    expect(timeline.some((event) => event.kind === "experiment_decision_proposed")).toBe(false);
    expect((await audit.list({ action: "experiment_decision_propose" })).length).toBe(0);
  });

  it("rolls back an imported experiment when timeline projection fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "experiment_imported";
    const { cases, service, experiments, audit } = await harness(store);
    const created = await cases.createCase(ALICE, { title: "Synthetic import atomicity" }, "test");
    await expect(
      service.importEnvelope(created.id, ALICE, SUMMARY, "test", false),
    ).rejects.toThrow(/injected timeline failure:experiment_imported/);
    expect(await experiments.listByCase(created.id)).toEqual([]);
    const timeline = await cases.listTimeline(created.id);
    expect(timeline.some((event) => event.kind === "experiment_imported")).toBe(false);
    expect((await audit.list({ action: "experiment_import" })).length).toBe(0);
  });
});
