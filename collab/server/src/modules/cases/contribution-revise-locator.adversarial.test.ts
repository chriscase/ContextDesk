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
import { CaseService, MemoryCaseStore, PgCaseStore } from "./index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-contrib-revise-locator-"));
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

async function seedRevisedAndTombstoned(cases: CaseService) {
  const created = await cases.createCase(ALICE, { title: "Synthetic mailer timeout notes" }, "test");
  const message = await cases.addContribution(
    created.id,
    ALICE,
    { kind: "message", body: "Queue workers stalled after the synthetic mailer timeout.", privacyClass: "share_safe" },
    "test",
  );
  const revised = await cases.reviseContribution(
    created.id,
    message.id,
    ALICE,
    "Queue workers stalled after the synthetic mailer timeout; inspect the retry budget.",
    "test",
    1,
  );
  const hypothesis = await cases.addContribution(
    created.id,
    ALICE,
    { kind: "hypothesis", body: "The synthetic timeout is a bounded queue stall.", privacyClass: "share_safe" },
    "test",
  );
  const tombstoned = await cases.tombstoneContribution(created.id, hypothesis.id, ALICE, "test");
  return {
    caseId: created.id,
    messageId: message.id,
    revisedRevision: revised.revision,
    hypothesisId: hypothesis.id,
    tombstoneRevision: tombstoned.revision,
  };
}

async function assertReviseAndTombstoneLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedRevisedAndTombstoned>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const revised = page.items.find((item) => item.summary === "revised a discussion comment");
  const omitted = page.items.find((item) => item.summary === "omitted an investigation record");
  expect(revised?.locator.kind).toBe("discussion_message");
  expect(revised?.locator.resourceId).toBe(seeded.messageId);
  expect(revised?.locator.revision).toBe(seeded.revisedRevision);
  expect(omitted?.locator.kind).toBe("hypothesis");
  expect(omitted?.locator.resourceId).toBe(seeded.hypothesisId);
  expect(omitted?.locator.revision).toBe(seeded.tombstoneRevision);
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(revised!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Discussion message",
  });
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(omitted!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Hypothesis",
  });
  await expect(
    activity.resolve(EVE, false, formatCompactInvestigationLocator(revised!.locator)),
  ).rejects.toMatchObject({ code: "not_found" });
  const confused = formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: seeded.caseId,
    kind: "observation",
    resourceId: seeded.messageId,
    revision: seeded.revisedRevision,
  }));
  await expect(activity.resolve(ALICE, false, confused)).rejects.toMatchObject({ code: "not_found" });
}

describe("contribution revise and tombstone locators", () => {
  it("addresses revised comments and omitted hypotheses with their live kinds", async () => {
    const { cases, activity } = await memoryHarness();
    const seeded = await seedRevisedAndTombstoned(cases);
    const timeline = await cases.listTimeline(seeded.caseId);
    const revised = timeline.find((event) => event.kind === "contribution_revised");
    const tombstoned = timeline.find((event) => event.kind === "contribution_tombstoned");
    expect(JSON.parse(revised?.payload ?? "{}").kind).toBe("message");
    expect(JSON.parse(tombstoned?.payload ?? "{}").kind).toBe("hypothesis");
    await assertReviseAndTombstoneLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres contribution revise and tombstone locators", () => {
  it("addresses remapped live kinds with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-contrib-revise-locator-"));
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
        const seeded = await seedRevisedAndTombstoned(cases);
        await assertReviseAndTombstoneLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
