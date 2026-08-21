import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQualificationReport, renderQualificationSummary } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { loadLdapConfig } from "../auth/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { CaseService, PgCaseStore } from "../cases/index.js";
import { MAX_UPLOAD_BYTES } from "../evidence/index.js";
import { ExperimentService, MemoryExperimentStore, PgExperimentStore } from "../experiments/index.js";
import { assertReleaseArtifactSafe } from "../operator/index.js";
import { inspectLiveProfiles } from "./live.js";
import { runQualification } from "./harness.js";

const actor = { id: "uid=qual,ou=people,dc=example,dc=test", username: "qual" };

async function withMemory(
  fn: (deps: { cases: CaseService; experiments: ExperimentService }) => Promise<void>,
): Promise<void> {
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
    await fn({ cases, experiments });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("collaborative triage qualification harness", () => {
  it("runs the hermetic workflow on current Experiment Lab seams", async () => {
    await withMemory(async ({ cases, experiments }) => {
      const report = await runQualification({ cases, experiments, backend: "memory" });
      const parsed = parseQualificationReport(report);
      expect(parsed.backend).toBe("memory");
      expect(parsed.steps.every((step) => step.status === "passed")).toBe(true);
      expect(parsed.steps.map((step) => step.id)).toEqual([
        "start_case",
        "freeze_evidence",
        "host_owned_lanes",
        "host_lane_interrupts",
        "import_host_package",
        "import_external_chat",
        "compare_and_decide",
        "export_share_safe",
        "lineage_rerun",
      ]);
      expect(parsed.concurrency.observedMaxActive).toBeLessThanOrEqual(
        parsed.concurrency.configuredLimit,
      );
      expect(parsed.concurrency.sameSnapshot).toBe(true);
      expect(parsed.concurrency.durableRunCount).toBeGreaterThanOrEqual(2);
      expect(parsed.comparison.sharedEvidenceCount).toBeGreaterThan(0);
      expect(parsed.comparison.uniqueEvidenceCount).toBeGreaterThan(0);
      expect(parsed.comparison.disagreementCount).toBeGreaterThan(0);
      expect(parsed.comparison.questionPathCount).toBeGreaterThan(0);
      expect(parsed.comparison.helpfulnessRecorded).toBe(true);
      expect(parsed.comparison.goldAligned).toBe(true);
      expect(parsed.comparison.acceptedDecision).toBe(true);
      expect(parsed.lineage.predecessorPackageAlias).toContain("v1");
      expect(parsed.lineage.successorPackageAlias).toContain("v2");
      expect(parsed.lineage.predecessorGoldPresent).toBe(true);
      expect(parsed.liveProfiles).toHaveLength(4);
      expect(parsed.liveProfiles.every((profile) => !profile.ran)).toBe(true);
      expect(parsed.liveProfiles.every((profile) => profile.skippedReason !== null)).toBe(true);
      expect(renderQualificationSummary(parsed)).toContain("backend=memory");
      expect(JSON.stringify(parsed)).not.toMatch(/sk-|Bearer |api_key|rawCapture|"prompt"/i);
    });
  });

  it("refuses oversized, disallowed, and traversing evidence", async () => {
    await withMemory(async ({ cases }) => {
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

  it("never marks live profiles as ran without an actual host invocation", async () => {
    expect(
      inspectLiveProfiles({}).every(
        (profile) => !profile.ran && profile.skippedReason === "credentials_not_configured",
      ),
    ).toBe(true);
    await withMemory(async ({ cases, experiments }) => {
      const report = await runQualification({
        cases,
        experiments,
        backend: "memory",
        liveEnv: {
          COLLAB_LIVE_PROFILES: "gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512",
          COLLAB_LIVE_VERCEL: "1",
        },
      });
      expect(report.liveProfiles.every((profile) => profile.configured)).toBe(true);
      expect(report.liveProfiles.every((profile) => !profile.ran)).toBe(true);
      expect(
        report.liveProfiles.every(
          (profile) => profile.skippedReason === "opt_in_host_not_invoked_in_hermetic_suite",
        ),
      ).toBe(true);
    });
  });
});

describe.skipIf(!adminUrl())("postgres qualification backend", () => {
  it("runs the same workflow through existing PostgreSQL case and experiment stores", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "cd-collab-qual-pg-"));
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(client);
      const catalog = new CatalogService(new PgCatalogStore(client), audit);
      const cases = new CaseService(store, audit, new PgCaseStore(client), catalog);
      const experiments = new ExperimentService({
        cases,
        audit,
        experiments: new PgExperimentStore(client),
      });
      try {
        const report = await runQualification({ cases, experiments, backend: "postgres" });
        expect(report.backend).toBe("postgres");
        expect(report.steps.every((step) => step.status === "passed")).toBe(true);
        expect(report.comparison.acceptedDecision).toBe(true);
        expect(report.lineage.successorPackageAlias).toContain("v2");
        expect(report.liveProfiles.every((profile) => !profile.ran)).toBe(true);
        expect(report.liveProfiles.every((profile) => profile.skippedReason !== null)).toBe(true);
        expect(JSON.stringify(report)).not.toMatch(/postgres:\/\//);
        expect(() => assertReleaseArtifactSafe({ reports: [report] })).not.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
