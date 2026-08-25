import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-upload-locator-"));
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

async function seedUpload(cases: CaseService) {
  const created = await cases.createCase(ALICE, { title: "Synthetic mailer timeout evidence" }, "test");
  const uploaded = await cases.addEvidence(created.id, ALICE, {
    kind: "log",
    filename: "mailer.log",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n"),
    summary: "Synthetic mailer timeout log",
    privacyClass: "share_safe",
  }, "test");
  return {
    caseId: created.id,
    artifactId: uploaded.artifact.id,
    summaryId: uploaded.summary.id,
  };
}

async function assertUploadLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedUpload>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  expect(page.items.some((item) => item.summary === "recorded an evidence upload")).toBe(false);
  const evidence = page.items.filter((item) => item.activityKind === "evidence_added");
  expect(evidence.length).toBeGreaterThan(0);
  expect(evidence.every((item) => item.locator.kind === "evidence_item")).toBe(true);
  expect(evidence.every((item) => item.locator.resourceId === seeded.artifactId)).toBe(true);
  expect(evidence.every((item) => item.locator.resourceId !== seeded.summaryId)).toBe(true);
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(evidence[0]!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
  });
  const confused = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: seeded.caseId,
    kind: "evidence_item",
    resourceId: seeded.summaryId,
  }));
  await expect(activity.resolve(ALICE, false, confused)).rejects.toMatchObject({ code: "not_found" });
  await expect(activity.resolve(EVE, false, confused)).rejects.toMatchObject({ code: "not_found" });
}

describe("evidence upload locators", () => {
  it("addresses added evidence at the artifact id, not the upload contribution", async () => {
    const { cases, activity } = await memoryHarness();
    const seeded = await seedUpload(cases);
    await assertUploadLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres evidence upload locators", () => {
  it("hides upload contribution ids from evidence_item resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-upload-locator-"));
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
        const seeded = await seedUpload(cases);
        await assertUploadLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
