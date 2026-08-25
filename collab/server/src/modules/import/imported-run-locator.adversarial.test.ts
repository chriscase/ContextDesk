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
import { ImportService, MemoryRunStore, PgRunStore } from "./index.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };
const EVE = { id: "eve", username: "eve" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-imported-run-locator-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(evidence, audit, new MemoryCaseStore(), catalog);
  const imports = new ImportService({
    evidence,
    audit,
    cases,
    catalog,
    runs: new MemoryRunStore(),
  });
  const activity = new InvestigationActivityService({
    cases,
    installationId: INSTALLATION,
  });
  return { cases, catalog, imports, activity };
}

async function seedImportedRun(
  cases: CaseService,
  catalog: CatalogService,
  imports: ImportService,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic imported-run locator" }, "test");
  const uploaded = await cases.addEvidence(created.id, ALICE, {
    kind: "log",
    filename: "mailer.log",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n"),
    summary: "Synthetic mailer timeout log",
    privacyClass: "share_safe",
  }, "test");
  const snapshot = await cases.createSnapshot(
    created.id,
    ALICE,
    { evidenceIds: [uploaded.artifact.id], visibility: "share_safe" },
    "test",
  );
  const source = await catalog.create(
    ALICE,
    { name: "Synthetic assistant", kind: "external-tool", description: "Synthetic only" },
    "test",
  );
  const imported = await imports.importRun(
    created.id,
    ALICE,
    {
      outputText: "A synthetic queue stall may follow worker saturation.",
      promptText: "Inspect the synthetic queue evidence.",
      sourceId: source.id,
      operatorId: ALICE.id,
      operatorUsername: ALICE.username,
      promptCompleteness: "exact",
      outputCompleteness: "exact",
      workflowCompleteness: "partial",
      evidenceVisibility: "complete",
      snapshotBinding: snapshot.fingerprint,
      provider: "openai-compatible",
      model: "qwen-3.6-27b",
      privacyClass: "share_safe",
    },
    "test",
    false,
  );
  await imports.corroborate(
    created.id,
    imported.id,
    ALICE,
    { state: "corroborated", links: [{ kind: "artifact", id: uploaded.artifact.id }] },
    "test",
    false,
  );
  return {
    caseId: created.id,
    runId: imported.id,
    snapshotId: snapshot.id,
  };
}

function compact(
  caseId: string,
  kind: "imported_ai_run" | "evidence_context" | "evidence_item" | "experiment",
  resourceId: string,
) {
  return formatCompactInvestigationLocator(formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: caseId,
    kind,
    resourceId,
  }));
}

async function assertImportedRunLocators(
  activity: InvestigationActivityService,
  seeded: Awaited<ReturnType<typeof seedImportedRun>>,
) {
  const page = await activity.listPage({ actor: ALICE, isAdmin: false, caseId: seeded.caseId });
  const imported = page.items.find((item) => item.summary === "imported analysis was recorded");
  const corroboration = page.items.find((item) => item.summary === "reviewed imported analysis");
  const frozen = page.items.find((item) => item.activityKind === "evidence_frozen");
  expect(imported?.locator.kind).toBe("imported_ai_run");
  expect(imported?.locator.resourceId).toBe(seeded.runId);
  expect(imported?.locator.resourceId).not.toBe(seeded.caseId);
  expect(imported?.locator.resourceId).not.toBe(seeded.snapshotId);
  expect(imported?.humanFinding).toBe(false);
  expect(imported?.provenanceClass).toBe("ai_generated");
  expect(imported?.resolvedRoute).toContain("/capture");
  expect(imported?.resolvedRoute).toContain("section=triage-capture");
  expect(imported?.resolvedRoute).toContain("kind=imported-run");
  expect(imported?.resolvedRoute).toContain(`item=${encodeURIComponent(seeded.runId)}`);
  expect(corroboration?.locator.kind).toBe("imported_ai_run");
  expect(corroboration?.locator.resourceId).toBe(seeded.runId);
  expect(corroboration?.humanFinding).toBe(false);
  expect(corroboration?.resolvedRoute).toContain("section=triage-capture");
  expect(corroboration?.resolvedRoute).toContain("kind=imported-run");
  expect(frozen?.locator.kind).toBe("evidence_context");
  expect(frozen?.locator.resourceId).toBe(seeded.snapshotId);
  expect(frozen?.locator.resourceId).not.toBe(seeded.runId);
  expect(frozen?.resolvedRoute).toContain("section=triage-evidence-board");
  expect(frozen?.resolvedRoute).toContain("kind=snapshot");
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(imported!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Imported analysis",
    locator: imported!.locator,
  });
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(corroboration!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Imported analysis",
  });
  await expect(
    activity.resolve(ALICE, false, formatCompactInvestigationLocator(frozen!.locator)),
  ).resolves.toMatchObject({
    authorized: true,
    resourceLabel: "Evidence context",
  });
  await expect(
    activity.resolve(EVE, false, formatCompactInvestigationLocator(imported!.locator)),
  ).rejects.toMatchObject({ code: "not_found" });

  const confused = [
    compact(seeded.caseId, "evidence_context", seeded.runId),
    compact(seeded.caseId, "imported_ai_run", seeded.snapshotId),
    compact(seeded.caseId, "imported_ai_run", seeded.caseId),
    compact(seeded.caseId, "evidence_item", seeded.runId),
    compact(seeded.caseId, "experiment", seeded.runId),
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

describe("imported-run locators", () => {
  it("addresses imported analysis at imported_ai_run, not evidence_context, and hides kind-confused ids", async () => {
    const { cases, catalog, imports, activity } = await memoryHarness();
    const seeded = await seedImportedRun(cases, catalog, imports);
    const timeline = await cases.listTimeline(seeded.caseId);
    expect(timeline.filter((event) => event.kind === "external_run_imported").map((event) => event.targetId))
      .toEqual([seeded.runId]);
    expect(timeline.filter((event) => event.kind === "run_corroboration").map((event) => event.targetId))
      .toEqual([seeded.runId]);
    await assertImportedRunLocators(activity, seeded);
  });
});

describe.skipIf(!adminUrl())("postgres imported-run locators", () => {
  it("addresses remapped imported runs with the same kind-strict resolve", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-imported-run-locator-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const imports = new ImportService({
        evidence,
        audit,
        cases,
        catalog,
        runs: new PgRunStore(pool),
      });
      const activity = new InvestigationActivityService({
        cases,
        installationId: INSTALLATION,
      });
      try {
        const seeded = await seedImportedRun(cases, catalog, imports);
        await assertImportedRunLocators(activity, seeded);
      } finally {
        await pool.end();
      }
    });
  });
});
