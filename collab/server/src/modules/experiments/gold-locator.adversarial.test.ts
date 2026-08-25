import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  formatCompactInvestigationLocator,
  formatInvestigationResourceLocator,
  GOLD_IS_HUMAN_BENCHMARK,
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
  const root = await mkdtemp(join(tmpdir(), "cd-collab-gold-locator-"));
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

async function seedAcceptedGold(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic gold locator" }, "test");
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  const proposed = await experiments.proposeDecision(
    created.id,
    imported.id,
    ALICE,
    {
      text: "Treat inventory timeout as the synthetic benchmark cause.",
      rationale: "Human decision over the synthetic checkout comparison.",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
    "test",
    false,
  );
  const accepted = await experiments.acceptDecision(
    created.id,
    imported.id,
    ALICE,
    proposed.revision,
    "test",
    false,
  );
  const gold = await experiments.promoteGold(
    created.id,
    imported.id,
    ALICE,
    {
      decisionId: accepted.id,
      expectedRevision: accepted.revision,
      evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      notes: [GOLD_IS_HUMAN_BENCHMARK, "Synthetic benchmark only."],
    },
    "test",
    false,
  );
  const next = await experiments.promoteGold(
    created.id,
    imported.id,
    ALICE,
    {
      decisionId: accepted.id,
      expectedRevision: accepted.revision,
      expectedGoldVersion: gold.version,
      evidenceAnchors: ["ev-demo-checkout-log"],
      notes: [GOLD_IS_HUMAN_BENCHMARK, "Narrower synthetic benchmark."],
    },
    "test",
    false,
  );
  expect(next.goldId).not.toBe(gold.goldId);
  expect(await store.listGolds(imported.id)).toHaveLength(2);
  return {
    caseId: created.id,
    experimentId: imported.id,
    decisionId: accepted.id,
    gold,
    next,
  };
}

function compact(
  caseId: string,
  kind: "gold" | "decision_revision" | "evidence_item",
  resourceId: string,
  revision?: number,
) {
  return formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: caseId,
    kind,
    resourceId,
    ...(kind === "decision_revision" || revision !== undefined ? { revision: revision ?? 0 } : {}),
  }));
}

async function assertGoldLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedAcceptedGold>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const goldItems = page.items.filter((item) =>
    item.summary === "recorded an accepted outcome benchmark",
  );
  expect(goldItems).toHaveLength(2);
  expect(goldItems.map((item) => item.locator.resourceId).sort()).toEqual(
    [seeded.gold.goldId, seeded.next.goldId].sort(),
  );
  for (const item of goldItems) {
    expect(item.locator.kind).toBe("gold");
    expect(item.locator.resourceId).not.toBe(seeded.experimentId);
    expect(item.locator.resourceId).not.toBe(seeded.decisionId);
    expect(item.locator.resourceId).not.toBe(seeded.caseId);
    expect(item.humanFinding).toBe(true);
    expect(item.resolvedRoute).toContain("section=decision-heading");
    expect(item.resolvedRoute).toContain(`item=${item.locator.resourceId}`);
    await expect(
      activity.resolve(ALICE, false, formatCompactInvestigationLocator(item.locator)),
    ).resolves.toMatchObject({
      authorized: true,
      resourceLabel: "Outcome benchmark",
      locator: item.locator,
    });
    await expect(
      activity.resolve(EVE, false, formatCompactInvestigationLocator(item.locator)),
    ).rejects.toMatchObject({ code: "not_found" });
  }
  expect(new Set(goldItems.map((item) => item.locator.resourceId)).size).toBe(2);

  const confused = [
    compact(seeded.caseId, "decision_revision", seeded.gold.goldId, seeded.gold.version),
    compact(seeded.caseId, "decision_revision", seeded.experimentId, 0),
    compact(seeded.caseId, "gold", seeded.experimentId),
    compact(seeded.caseId, "gold", seeded.decisionId),
    compact(seeded.caseId, "gold", seeded.caseId),
    compact(seeded.caseId, "evidence_item", seeded.gold.goldId),
  ];
  for (const locator of confused) {
    await expect(activity.resolve(ALICE, false, locator)).rejects.toMatchObject({ code: "not_found" });
    await expect(activity.resolve(EVE, false, locator)).rejects.toMatchObject({ code: "not_found" });
  }
}

describe("experiment gold locators", () => {
  it("addresses each gold snapshot, not the experiment or decision, and hides kind-confused ids", async () => {
    const { cases, experiments, store, activity } = await memoryHarness();
    const seeded = await seedAcceptedGold(cases, experiments, store);
    const timeline = await cases.listTimeline(seeded.caseId);
    const goldEvents = timeline.filter((event) => event.kind === "experiment_gold_promoted");
    expect(goldEvents.map((event) => event.targetId).sort()).toEqual(
      [seeded.gold.goldId, seeded.next.goldId].sort(),
    );
    await assertGoldLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres experiment gold locators", () => {
  it("addresses remapped gold snapshots with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-gold-locator-"));
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
        const seeded = await seedAcceptedGold(cases, experiments, store);
        await assertGoldLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
