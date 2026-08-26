import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  formatCompactInvestigationLocator,
  formatInvestigationResourceLocator,
} from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { InvestigationActivityService } from "../activity/index.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import {
  ExperimentService,
  MemoryExperimentStore,
  PgExperimentStore,
  type ExperimentStore,
} from "./index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as unknown;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-experiment-locator-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const store = new MemoryExperimentStore();
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  const activity = new InvestigationActivityService({
    cases,
    installationId: INSTALLATION,
  });
  return { cases, experiments, store, activity };
}

async function seedExperiment(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic experiment locator" }, "test");
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  expect(await store.get(imported.id)).toBeTruthy();
  return { caseId: created.id, experimentId: imported.id };
}

function compact(
  caseId: string,
  kind: "experiment" | "comparison_finding" | "evidence_context" | "interaction_trace",
  resourceId: string,
) {
  return formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: caseId,
    kind,
    resourceId,
  }));
}

async function assertExperimentLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedExperiment>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const items = page.items.filter((item) => item.summary === "recorded a strategy comparison");
  expect(items).toHaveLength(1);
  const item = items[0]!;
  expect(item.locator.kind).toBe("experiment");
  expect(item.locator.resourceId).toBe(seeded.experimentId);
  expect(item.locator.resourceId).not.toBe(seeded.caseId);
  expect(item.humanFinding).toBe(false);
  expect(item.provenanceClass).toBe("imported");
  expect(item.resolvedRoute).toContain("section=candidate-comparison-heading");
  expect(item.resolvedRoute).toContain(`item=${item.locator.resourceId}`);
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(item.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Strategy comparison",
    locator: item.locator,
  });
  await expect(
    activity.resolve(EVE, false, formatCompactInvestigationLocator(item.locator)),
  ).rejects.toMatchObject({ code: "not_found" });

  const confused = [
    compact(seeded.caseId, "comparison_finding", seeded.experimentId),
    compact(seeded.caseId, "evidence_context", seeded.experimentId),
    compact(seeded.caseId, "interaction_trace", seeded.experimentId),
    compact(seeded.caseId, "experiment", seeded.caseId),
  ];
  for (const locator of confused) {
    await expect(activity.resolve(ALICE, false, locator), locator).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(activity.resolve(EVE, false, locator), locator).rejects.toMatchObject({
      code: "not_found",
    });
  }
}

describe("experiment import locators", () => {
  it("addresses the comparison at the experiment id, not comparison_finding, and hides kind-confused ids", async () => {
    const { cases, experiments, store, activity } = await memoryHarness();
    const seeded = await seedExperiment(cases, experiments, store);
    const timeline = await cases.listTimeline(seeded.caseId);
    const events = timeline.filter((event) => event.kind === "experiment_imported");
    expect(events.map((event) => event.targetId)).toEqual([seeded.experimentId]);
    await assertExperimentLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres experiment import locators", () => {
  it("addresses remapped experiments with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-experiment-locator-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = new PgExperimentStore(pool);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      const activity = new InvestigationActivityService({
        cases,
        installationId: INSTALLATION,
      });
      try {
        const seeded = await seedExperiment(cases, experiments, store);
        await assertExperimentLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
