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
  const root = await mkdtemp(join(tmpdir(), "cd-collab-decision-locator-"));
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

async function seedDecisions(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic decision locator" }, "test");
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  const proposed = await experiments.proposeDecision(
    created.id,
    imported.id,
    ALICE,
    {
      text: "Treat inventory timeout as the synthetic cause.",
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
  expect(accepted.id).toBe(proposed.id);
  expect(await store.listDecisions(imported.id)).toHaveLength(2);
  return {
    caseId: created.id,
    experimentId: imported.id,
    proposed,
    accepted,
  };
}

function compact(
  caseId: string,
  kind: "decision_revision" | "experiment" | "gold" | "evidence_item",
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

async function assertDecisionLocators(
  cases: CaseService,
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedDecisions>>,
) {
  const timeline = await cases.listTimeline(seeded.caseId);
  const events = timeline.filter((event) => event.kind.startsWith("experiment_decision_"));
  expect(events.map((event) => event.targetId).sort()).toEqual(
    [seeded.proposed.id, seeded.accepted.id].sort(),
  );
  expect(events.every((event) => event.targetId !== seeded.experimentId)).toBe(true);
  expect(events.every((event) => event.targetId !== seeded.caseId)).toBe(true);
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const proposed = page.items.find((item) => item.activityKind === "decision_proposed");
  const accepted = page.items.find((item) => item.activityKind === "decision_accepted");
  expect(proposed?.locator.kind).toBe("decision_revision");
  expect(accepted?.locator.kind).toBe("decision_revision");
  expect(proposed?.locator.resourceId).toBe(seeded.proposed.id);
  expect(accepted?.locator.resourceId).toBe(seeded.accepted.id);
  expect(proposed?.locator.resourceId).not.toBe(seeded.experimentId);
  expect(accepted?.locator.resourceId).not.toBe(seeded.caseId);
  expect(proposed?.humanFinding).toBe(true);
  expect(accepted?.humanFinding).toBe(true);
  expect(proposed?.resolvedRoute).toContain("section=decision-heading");
  expect(accepted?.resolvedRoute).toContain(`item=${accepted?.locator.resourceId}`);
  for (const item of [proposed, accepted]) {
    await expect(
      activity.resolve(ALICE, false, formatCompactInvestigationLocator(item!.locator)),
    ).resolves.toMatchObject({
      authorized: true,
      resourceLabel: "Decision",
      locator: item!.locator,
    });
    await expect(
      activity.resolve(EVE, false, formatCompactInvestigationLocator(item!.locator)),
    ).rejects.toMatchObject({ code: "not_found" });
  }

  const confused = [
    compact(seeded.caseId, "decision_revision", seeded.experimentId, seeded.proposed.revision),
    compact(seeded.caseId, "decision_revision", seeded.experimentId, seeded.accepted.revision),
    compact(seeded.caseId, "experiment", seeded.proposed.id),
    compact(seeded.caseId, "gold", seeded.proposed.id),
    compact(seeded.caseId, "evidence_item", seeded.proposed.id),
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

describe("experiment decision locators", () => {
  it("addresses each decision at the decision id, not the experiment, and hides kind-confused ids", async () => {
    const { cases, experiments, store, activity } = await memoryHarness();
    const seeded = await seedDecisions(cases, experiments, store);
    await assertDecisionLocators(cases, activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres experiment decision locators", () => {
  it("addresses remapped decisions with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-decision-locator-"));
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
        const seeded = await seedDecisions(cases, experiments, store);
        await assertDecisionLocators(cases, activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
