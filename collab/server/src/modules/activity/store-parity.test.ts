import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
  formatCompactInvestigationLocator,
  formatInvestigationResourceLocator,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { InvestigationActivityService } from "./service.js";

const INSTALLATION = "inst-syntheticnorth";
const ALICE = { id: "alice", username: "alice" };

async function seed(cases: CaseService): Promise<string> {
  const created = await cases.createCase(ALICE, { title: "Synthetic parity investigation" }, "test");
  await cases.addEvidence(created.id, ALICE, {
    kind: "log",
    filename: "parity.log",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("2026-08-24T00:00:00Z synthetic parity row\n"),
    summary: "Synthetic parity log",
  }, "test");
  await cases.addContribution(created.id, ALICE, {
    kind: "message",
    body: "Please verify the synthetic worker trace.",
  }, "test");
  await cases.appendDomainTimeline(created.id, {
    kind: "triage_job_created",
    actor: ALICE,
    targetId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    clientTime: null,
    serverTime: "2026-08-24T16:00:00.000Z",
    payload: { status: "queued" },
  });
  await cases.appendDomainTimeline(created.id, {
    kind: "external_run_imported",
    actor: ALICE,
    targetId: created.id,
    clientTime: null,
    serverTime: "2026-08-24T16:01:00.000Z",
    payload: { summary: "PLANTED_MODEL_OUTPUT" },
  });
  const intakeBytes = new TextEncoder().encode("2026-08-24T00:00:00Z synthetic parity intake\n");
  const intakeSeed = {
    origin: "files" as const,
    sourceLabel: "Synthetic parity intake",
    privacyClass: "share_safe" as const,
    idempotencyKey: "batch-synthetic-parity-1",
    files: [{
      relativePath: "mailer/parity-intake.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from(intakeBytes).toString("base64"),
    }],
    archiveBase64: null,
  };
  const preview = await cases.previewCorpusIntake(created.id, ALICE, {
    schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
    ...intakeSeed,
  });
  await cases.commitCorpusIntake(created.id, ALICE, {
    schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
    ...intakeSeed,
    previewToken: preview.previewToken,
  }, "test");
  return created.id;
}

describe("investigation activity memory store", () => {
  it("survives CaseService reload against the same memory store", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-activity-mem-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const store = new MemoryCaseStore();
    try {
      const firstService = new CaseService(evidence, audit, store);
      const caseId = await seed(firstService);
      const first = new InvestigationActivityService({
        cases: firstService,
        installationId: INSTALLATION,
      });
      const before = await first.listPage({ actor: ALICE, isAdmin: false, caseId });
      const reloadedCases = new CaseService(evidence, audit, store);
      const reloaded = new InvestigationActivityService({
        cases: reloadedCases,
        installationId: INSTALLATION,
      });
      const after = await reloaded.listPage({ actor: ALICE, isAdmin: false, caseId });
      expect(reloaded.canonicalPageBytes(after)).toBe(first.canonicalPageBytes(before));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!adminUrl())("investigation activity PostgreSQL parity", () => {
  it("matches memory projection bytes and survives a new CaseService", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const pgRoot = await mkdtemp(join(tmpdir(), "cd-collab-activity-pg-"));
      const memRoot = await mkdtemp(join(tmpdir(), "cd-collab-activity-mem-"));
      try {
        const pgEvidence = new FilesystemEvidenceStore({ rootDir: pgRoot });
        const memEvidence = new FilesystemEvidenceStore({ rootDir: memRoot });
        const pgAudit = new PgAuditStore(pool);
        const memAudit = new MemoryAuditStore();
        const pgCases = new CaseService(
          pgEvidence,
          pgAudit,
          new PgCaseStore(pool),
          new CatalogService(new PgCatalogStore(pool), pgAudit),
        );
        const memCases = new CaseService(memEvidence, memAudit, new MemoryCaseStore());
        const memId = await seed(memCases);
        const pgCreated = await pgCases.createCase(
          ALICE,
          { title: "Synthetic parity investigation" },
          "test",
        );
        const memPage = await new InvestigationActivityService({
          cases: memCases,
          installationId: INSTALLATION,
        }).listPage({ actor: ALICE, isAdmin: false, caseId: memId });
        await pgCases.addEvidence(pgCreated.id, ALICE, {
          kind: "log",
          filename: "parity.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("2026-08-24T00:00:00Z synthetic parity row\n"),
          summary: "Synthetic parity log",
        }, "test");
        await pgCases.addContribution(pgCreated.id, ALICE, {
          kind: "message",
          body: "Please verify the synthetic worker trace.",
        }, "test");
        await pgCases.appendDomainTimeline(pgCreated.id, {
          kind: "triage_job_created",
          actor: ALICE,
          targetId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          clientTime: null,
          serverTime: "2026-08-24T16:00:00.000Z",
          payload: { status: "queued" },
        });
        await pgCases.appendDomainTimeline(pgCreated.id, {
          kind: "external_run_imported",
          actor: ALICE,
          targetId: pgCreated.id,
          clientTime: null,
          serverTime: "2026-08-24T16:01:00.000Z",
          payload: { summary: "PLANTED_MODEL_OUTPUT" },
        });
        const intakeBytes = new TextEncoder().encode("2026-08-24T00:00:00Z synthetic parity intake\n");
        const intakeSeed = {
          origin: "files" as const,
          sourceLabel: "Synthetic parity intake",
          privacyClass: "share_safe" as const,
          idempotencyKey: "batch-synthetic-parity-1",
          files: [{
            relativePath: "mailer/parity-intake.log",
            mediaType: "text/plain",
            contentBase64: Buffer.from(intakeBytes).toString("base64"),
          }],
          archiveBase64: null,
        };
        const preview = await pgCases.previewCorpusIntake(pgCreated.id, ALICE, {
          schemaId: CORPUS_INTAKE_PREVIEW_SCHEMA_ID,
          ...intakeSeed,
        });
        const batch = await pgCases.commitCorpusIntake(pgCreated.id, ALICE, {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          ...intakeSeed,
          previewToken: preview.previewToken,
        }, "test");
        const pgActivity = new InvestigationActivityService({
          cases: pgCases,
          installationId: INSTALLATION,
        });
        const pgPage = await pgActivity.listPage({
          actor: ALICE,
          isAdmin: false,
          caseId: pgCreated.id,
        });
        expect(pgPage.items.map((item) => item.activityKind).sort())
          .toEqual(memPage.items.map((item) => item.activityKind).sort());
        expect(pgPage.items.every((item) => item.humanFinding === false || item.activityKind === "comment_added"))
          .toBe(true);
        const intake = pgPage.items.find((item) => item.summary === "committed a log intake batch");
        expect(intake?.locator.kind).toBe("intake_batch");
        expect(intake?.locator.resourceId).toBe(batch.id);
        expect(intake?.humanFinding).toBe(false);
        await expect(
          pgActivity.resolve(ALICE, false, formatCompactInvestigationLocator(intake!.locator)),
        ).resolves.toMatchObject({ authorized: true, resourceLabel: "Intake batch" });
        await expect(
          pgActivity.resolve({ id: "eve", username: "eve" }, false, formatCompactInvestigationLocator(intake!.locator)),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(
          pgActivity.resolve(
            ALICE,
            false,
            formatCompactInvestigationLocator(formatInvestigationResourceLocator({
              installationId: INSTALLATION,
              investigationId: pgCreated.id,
              kind: "evidence_item",
              resourceId: batch.id,
            })),
          ),
        ).rejects.toMatchObject({ code: "not_found" });
        const reloaded = new InvestigationActivityService({
          cases: new CaseService(
            pgEvidence,
            pgAudit,
            new PgCaseStore(pool),
            new CatalogService(new PgCatalogStore(pool), pgAudit),
          ),
          installationId: INSTALLATION,
        });
        const afterRestart = await reloaded.listPage({
          actor: ALICE,
          isAdmin: false,
          caseId: pgCreated.id,
        });
        expect(reloaded.canonicalPageBytes(afterRestart)).toBe(pgActivity.canonicalPageBytes(pgPage));
      } finally {
        await pool.end();
        await rm(pgRoot, { recursive: true, force: true });
        await rm(memRoot, { recursive: true, force: true });
      }
    });
  });
});
