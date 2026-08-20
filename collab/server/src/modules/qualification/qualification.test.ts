import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQualificationReport } from "@cd-collab/contracts";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore } from "../audit/index.js";
import { loadLdapConfig } from "../auth/index.js";
import { CatalogService } from "../catalog/index.js";
import { CaseService } from "../cases/index.js";
import { ExperimentService, MemoryExperimentStore } from "../experiments/index.js";
import { MAX_UPLOAD_BYTES } from "../evidence/index.js";
import { PgJobStore, SqliteJobStore, sqliteAvailable } from "../jobs/index.js";
import { runQualification } from "./harness.js";

const actor = { id: "uid=qual,ou=people,dc=example,dc=test", username: "qual" };

async function withLocal(
  fn: (deps: {
    cases: CaseService;
    experiments: ExperimentService;
    root: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-qual-"));
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
    await fn({ cases, experiments, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("collaborative triage qualification harness", () => {
  it("runs the hermetic eight-step workflow in local memory mode", async () => {
    await withLocal(async ({ cases, experiments }) => {
      const report = await runQualification({ cases, experiments, backend: "memory" });
      const parsed = parseQualificationReport(report);
      expect(parsed.backend).toBe("memory");
      expect(parsed.steps.every((step) => step.status === "passed")).toBe(true);
      expect(parsed.comparison.sharedEvidenceCount).toBeGreaterThan(0);
      expect(parsed.comparison.uniqueEvidenceCount).toBeGreaterThan(0);
      expect(parsed.comparison.disagreementCount).toBeGreaterThan(0);
      expect(parsed.comparison.questionPathCount).toBeGreaterThan(0);
      expect(parsed.comparison.helpfulnessRecorded).toBe(true);
      expect(parsed.comparison.acceptedDecision).toBe(true);
      expect(parsed.lineage.predecessorPackageAlias).toContain("v1");
      expect(parsed.lineage.successorPackageAlias).toContain("v2");
      expect(parsed.liveProfiles.every((profile) => !profile.ran)).toBe(true);
      expect(parsed.liveProfiles.every((profile) => profile.skippedReason !== null)).toBe(true);
    });
  });

  it("refuses oversized, disallowed, and traversing evidence", async () => {
    await withLocal(async ({ cases }) => {
      const created = await cases.createCase(actor, { title: "limits" }, "test");
      await expect(
        cases.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "../../etc/passwd",
            mediaType: "text/plain",
            bytes: Buffer.from("x"),
            summary: "bad name",
          },
          "test",
        ),
      ).rejects.toThrow(/path segment/);
      await expect(
        cases.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "ok.log",
            mediaType: "application/javascript",
            bytes: Buffer.from("x"),
            summary: "bad type",
          },
          "test",
        ),
      ).rejects.toThrow(/allowlisted/);
      await expect(
        cases.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "huge.log",
            mediaType: "text/plain",
            bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
            summary: "too big",
          },
          "test",
        ),
      ).rejects.toThrow(/size cap/);
    });
  });

  it("keeps local auth and LDAP configuration boundaries honest", () => {
    expect(() =>
      loadLdapConfig({ COLLAB_LDAP_URL: "ldap://directory.example.test:389" }),
    ).toThrow(/plaintext LDAP refused/);
    const live = loadLdapConfig({
      COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
    });
    expect(live.verifyTls).toBe(true);
    expect(() =>
      loadLdapConfig({
        COLLAB_LDAP_URL: "ldaps://directory.example.test:636",
        COLLAB_LDAP_TLS_INSECURE: "1",
      }),
    ).toThrow(/COLLAB_LDAP_DEV_MODE/);
  });

  it("does not mark live profiles as ran without configuration", async () => {
    await withLocal(async ({ cases, experiments }) => {
      const report = await runQualification({
        cases,
        experiments,
        backend: "memory",
        liveEnv: { COLLAB_LIVE_PROFILES: "gpt-oss-120b" },
      });
      const grok = report.liveProfiles.find((profile) => profile.alias === "gpt-oss-120b");
      expect(grok?.configured).toBe(true);
      expect(grok?.ran).toBe(false);
      expect(grok?.skippedReason).toBe("opt_in_host_not_invoked_in_hermetic_suite");
    });
  });
});

describe.skipIf(!sqliteAvailable())("sqlite qualification backend", () => {
  it("runs the workflow with a sqlite job ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-qual-sqlite-"));
    const sqlite = new SqliteJobStore(join(dir, "jobs.sqlite"));
    try {
      await withLocal(async ({ cases, experiments }) => {
        const report = await runQualification({
          cases,
          experiments,
          jobs: sqlite,
          backend: "sqlite",
        });
        expect(report.backend).toBe("sqlite");
        expect(report.steps.every((step) => step.status === "passed")).toBe(true);
      });
    } finally {
      sqlite.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!adminUrl())("postgres qualification backend", () => {
  it("runs host comparison leases through PostgreSQL jobs", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const jobs = new PgJobStore(client);
      await withLocal(async ({ cases, experiments }) => {
        const report = await runQualification({
          cases,
          experiments,
          jobs,
          backend: "postgres",
        });
        expect(report.backend).toBe("postgres");
        expect(report.comparison.acceptedDecision).toBe(true);
      });
    });
  });
});
