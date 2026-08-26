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
const BOB = { id: "bob", username: "bob" };
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
  const root = await mkdtemp(join(tmpdir(), "cd-collab-helpfulness-locator-"));
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

async function seedHelpfulness(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic helpfulness locator" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  const aliceScore = await experiments.recordHelpfulness(
    created.id,
    imported.id,
    ALICE,
    {
      candidateId: "cand-qwen-3.6-27b",
      dimension: "evidence_support",
      score: 3,
      rationale: "Alice: the synthetic checkout log is the useful lead.",
      evidenceRefs: ["ev-demo-checkout-log"],
    },
    "test",
    false,
  );
  const bobScore = await experiments.recordHelpfulness(
    created.id,
    imported.id,
    BOB,
    {
      candidateId: "cand-gpt-oss-120b",
      dimension: "evidence_support",
      score: 2,
      rationale: "Bob: inventory timeout still lags the checkout log.",
      evidenceRefs: ["ev-demo-inventory-timeout"],
    },
    "test",
    false,
  );
  expect(aliceScore.id).not.toBe(bobScore.id);
  expect(await store.listObservations(imported.id)).toHaveLength(2);
  return {
    caseId: created.id,
    experimentId: imported.id,
    aliceScore,
    bobScore,
  };
}

function compact(
  caseId: string,
  kind: "helpfulness" | "comparison_finding" | "gold" | "evidence_item",
  resourceId: string,
) {
  return formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: caseId,
    kind,
    resourceId,
  }));
}

async function assertHelpfulnessLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedHelpfulness>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const items = page.items.filter((item) => item.summary === "recorded a comparison observation");
  expect(items).toHaveLength(2);
  expect(items.map((item) => item.locator.resourceId).sort()).toEqual(
    [seeded.aliceScore.id, seeded.bobScore.id].sort(),
  );
  for (const item of items) {
    expect(item.locator.kind).toBe("helpfulness");
    expect(item.locator.resourceId).not.toBe(seeded.experimentId);
    expect(item.locator.resourceId).not.toBe(seeded.caseId);
    expect(item.humanFinding).toBe(false);
    expect(item.resolvedRoute).toContain("section=cross-exam-heading");
    expect(item.resolvedRoute).toContain(`item=${item.locator.resourceId}`);
    await expect(
      activity.resolve(ALICE, false, formatCompactInvestigationLocator(item.locator)),
    ).resolves.toMatchObject({
      authorized: true,
      resourceLabel: "Comparison observation",
      locator: item.locator,
    });
    await expect(
      activity.resolve(EVE, false, formatCompactInvestigationLocator(item.locator)),
    ).rejects.toMatchObject({ code: "not_found" });
  }
  expect(new Set(items.map((item) => item.locator.resourceId)).size).toBe(2);

  const confused = [
    compact(seeded.caseId, "comparison_finding", seeded.aliceScore.id),
    compact(seeded.caseId, "helpfulness", seeded.experimentId),
    compact(seeded.caseId, "helpfulness", seeded.caseId),
    compact(seeded.caseId, "gold", seeded.aliceScore.id),
    compact(seeded.caseId, "evidence_item", seeded.aliceScore.id),
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

describe("experiment helpfulness locators", () => {
  it("addresses each observation, not the experiment, and hides kind-confused ids", async () => {
    const { cases, experiments, store, activity } = await memoryHarness();
    const seeded = await seedHelpfulness(cases, experiments, store);
    const timeline = await cases.listTimeline(seeded.caseId);
    const events = timeline.filter((event) => event.kind === "experiment_helpfulness_recorded");
    expect(events.map((event) => event.targetId).sort()).toEqual(
      [seeded.aliceScore.id, seeded.bobScore.id].sort(),
    );
    await assertHelpfulnessLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres experiment helpfulness locators", () => {
  it("addresses remapped helpfulness observations with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-helpfulness-locator-"));
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
        const seeded = await seedHelpfulness(cases, experiments, store);
        await assertHelpfulnessLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
