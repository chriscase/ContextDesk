import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderQualificationSummary, type QualificationBackend, type QualificationReportV1 } from "@cd-collab/contracts";
import { migrateUp } from "./db/migrate.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { adminUrl, withDisposableDb } from "./test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "./modules/audit/index.js";
import { CatalogService, PgCatalogStore } from "./modules/catalog/index.js";
import { CaseService, PgCaseStore } from "./modules/cases/index.js";
import { ExperimentService, MemoryExperimentStore, PgExperimentStore } from "./modules/experiments/index.js";
import { runQualification } from "./modules/qualification/index.js";

function requestedBackend(argv: string[]): QualificationBackend | "all" {
  const idx = argv.indexOf("--backend");
  if (idx >= 0) {
    const value = argv[idx + 1];
    if (value === "memory" || value === "postgres" || value === "all") return value;
    throw new Error("qualify --backend must be memory, postgres, or all");
  }
  return "all";
}

async function runMemory(): Promise<QualificationReportV1> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-qualify-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(store, audit, undefined, catalog);
  const experiments = new ExperimentService({ cases, audit, experiments: new MemoryExperimentStore() });
  try {
    return await runQualification({ cases, experiments, backend: "memory", liveEnv: process.env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runPostgres(): Promise<QualificationReportV1> {
  if (!adminUrl()) throw new Error("postgres qualification requires COLLAB_TEST_ADMIN_URL");
  let report: QualificationReportV1 | undefined;
  await withDisposableDb(async (client) => {
    await migrateUp(client);
    const root = await mkdtemp(join(tmpdir(), "cd-collab-qualify-pg-"));
    const store = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new PgAuditStore(client);
    const catalog = new CatalogService(new PgCatalogStore(client), audit);
    const cases = new CaseService(store, audit, new PgCaseStore(client), catalog);
    const experiments = new ExperimentService({ cases, audit, experiments: new PgExperimentStore(client) });
    try {
      report = await runQualification({ cases, experiments, backend: "postgres", liveEnv: process.env });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  if (!report) throw new Error("postgres qualification produced no report");
  return report;
}

async function main(): Promise<void> {
  const mode = requestedBackend(process.argv.slice(2));
  const reports: QualificationReportV1[] = [];
  if (mode === "memory" || mode === "all") reports.push(await runMemory());
  if (mode === "postgres") {
    reports.push(await runPostgres());
  } else if (mode === "all") {
    if (adminUrl()) reports.push(await runPostgres());
    else process.stderr.write("postgres skipped: COLLAB_TEST_ADMIN_URL not set\n");
  }
  process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
  for (const report of reports) process.stderr.write(`${renderQualificationSummary(report)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "qualification failed"}\n`);
  process.exitCode = 1;
});
