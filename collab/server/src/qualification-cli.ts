import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { MemoryAuditStore } from "./modules/audit/index.js";
import { CatalogService } from "./modules/catalog/index.js";
import { CaseService } from "./modules/cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "./modules/experiments/index.js";
import { inspectLiveProfiles } from "./modules/jobs/index.js";
import { runQualification } from "./modules/qualification/index.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-qualify-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(store, audit, undefined, catalog);
  const experiments = new ExperimentService({
    cases,
    audit,
    experiments: new MemoryExperimentStore(),
  });
  try {
    const report = await runQualification({ cases, experiments, backend: "memory" });
    const live = inspectLiveProfiles(process.env);
    const skipped = live.filter((profile) => !profile.ran).map((profile) => profile.alias);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `qualification backend=${report.backend} steps=${report.steps.length} live_skipped=${skipped.join(",")}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "qualification failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
