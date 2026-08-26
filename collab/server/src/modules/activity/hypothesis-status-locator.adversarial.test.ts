import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { formatCompactInvestigationLocator } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { InvestigationActivityService } from "./index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-hypothesis-status-locator-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const activity = new InvestigationActivityService({
    cases,
    installationId: INSTALLATION,
  });
  return { cases, activity };
}

async function seedSupersededHypothesis(cases: CaseService) {
  const created = await cases.createCase(ALICE, { title: "Synthetic mailer timeout hypotheses" }, "test");
  const hypothesis = await cases.addContribution(
    created.id,
    ALICE,
    {
      kind: "hypothesis",
      body: "The synthetic timeout is a bounded queue stall.",
      privacyClass: "share_safe",
    },
    "test",
  );
  const statused = await cases.setHypothesisStatus(
    created.id,
    hypothesis.id,
    ALICE,
    "superseded",
    [],
    "test",
  );
  return {
    caseId: created.id,
    hypothesisId: hypothesis.id,
    revision: statused.revision,
  };
}

async function assertSupersededHypothesisLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedSupersededHypothesis>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const superseded = page.items.find((item) => item.summary === "superseded a working hypothesis");
  expect(superseded?.locator.kind).toBe("hypothesis");
  expect(superseded?.locator.resourceId).toBe(seeded.hypothesisId);
  expect(superseded?.locator.revision).toBe(seeded.revision);
  expect(superseded?.activityKind).toBe("hypothesis_updated");
  expect(page.items.filter((item) => item.activityKind === "decision_superseded")).toEqual([]);
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(superseded!.locator)),
  ).resolves.toMatchObject({ authorized: true, resourceLabel: "Hypothesis" });
  await expect(
    activity.resolve(EVE, false, formatCompactInvestigationLocator(superseded!.locator)),
  ).rejects.toMatchObject({ code: "not_found" });
}

describe("hypothesis status locators", () => {
  it("does not project a superseded hypothesis as a superseded decision", async () => {
    const { cases, activity } = await memoryHarness();
    const seeded = await seedSupersededHypothesis(cases);
    await assertSupersededHypothesisLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres hypothesis status locators", () => {
  it("keeps superseded hypotheses off decision_superseded with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-hypothesis-status-locator-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const activity = new InvestigationActivityService({
        cases,
        installationId: INSTALLATION,
      });
      try {
        const seeded = await seedSupersededHypothesis(cases);
        await assertSupersededHypothesisLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
