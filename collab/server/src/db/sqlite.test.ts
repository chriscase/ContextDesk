import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
} from "@cd-collab/contracts";
import { FilesystemEvidenceStore, abandonWriteBatchForCrashTest, sha256Hex } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { ExperimentService } from "../modules/experiments/index.js";
import { ImportService } from "../modules/import/index.js";
import { TriageRunService } from "../modules/triage-runs/index.js";
import { StrategyGovernanceService } from "../modules/strategy-governance/index.js";
import { createSqliteRuntime } from "./sqlite.js";

const EXPERIMENT_SUMMARY = JSON.parse(
  readFileSync(new URL("../../../contracts/fixtures/experiment-summary.valid.json", import.meta.url), "utf8"),
) as unknown;

describe("SQLite local runtime", () => {
  it("persists strategy policy, preference, and audit atomically across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-strategy-"));
    const path = join(root, "collab.sqlite");
    try {
      const first = createSqliteRuntime(path);
      const governance = new StrategyGovernanceService({
        store: first.strategyGovernance,
        audit: first.audit,
      });
      const policy = await governance.updatePolicy({
        schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
        expectedRevision: 0,
        instance: {
          enabledIds: ["war-room", "investigation-first", "keystone", "beacon"],
          visibleIds: ["war-room", "beacon"],
          defaultId: "war-room",
          selectionMode: "approved_subset",
          approvedIds: ["war-room", "beacon"],
        },
        roleRules: [],
      }, "local:admin", "test");
      await governance.updatePreference({
        schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
        expectedPolicyRevision: policy.revision,
        expectedPreferenceRevision: 0,
        strategyId: "beacon",
      }, "local:alice", ["contributor"], "test");
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopened = new StrategyGovernanceService({
        store: second.strategyGovernance,
        audit: second.audit,
      });
      expect(await reopened.effective("local:alice", ["contributor"])).toMatchObject({
        policyRevision: 1,
        preferenceRevision: 1,
        effectiveId: "beacon",
      });
      expect(await second.audit.list({ action: "ui_strategy_policy_update" })).toHaveLength(1);
      expect(await second.audit.list({ action: "ui_strategy_preference_update" })).toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls strategy policy back across SQLite reopen when audit confirmation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-strategy-rollback-"));
    const path = join(root, "collab.sqlite");
    try {
      const first = createSqliteRuntime(path);
      first.audit.append = async () => {
        throw new Error("injected strategy audit failure");
      };
      const governance = new StrategyGovernanceService({
        store: first.strategyGovernance,
        audit: first.audit,
      });
      await expect(governance.updatePolicy({
        schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
        expectedRevision: 0,
        instance: {
          enabledIds: ["war-room", "beacon"],
          visibleIds: ["war-room", "beacon"],
          defaultId: "war-room",
          selectionMode: "free",
          approvedIds: ["war-room", "beacon"],
        },
        roleRules: [],
      }, "local:admin", "test")).rejects.toThrow(/injected strategy audit failure/u);
      expect((await governance.loadPolicy()).revision).toBe(0);
      first.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedGovernance = new StrategyGovernanceService({
        store: reopened.strategyGovernance,
        audit: reopened.audit,
      });
      expect((await reopenedGovernance.loadPolicy()).revision).toBe(0);
      expect(await reopened.audit.list({ action: "ui_strategy_policy_update" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes unrelated SQLite audit writes outside a failing strategy transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-strategy-interleave-"));
    const path = join(root, "collab.sqlite");
    try {
      const runtime = createSqliteRuntime(path);
      let releaseFailure!: () => void;
      let markAuditReached!: () => void;
      const auditReached = new Promise<void>((resolve) => { markAuditReached = resolve; });
      const failureReleased = new Promise<void>((resolve) => { releaseFailure = resolve; });
      const failingAudit = {
        append: async () => {
          markAuditReached();
          await failureReleased;
          throw new Error("injected delayed strategy audit failure");
        },
        list: (filter?: { action?: string; identity?: string }) => runtime.audit.list(filter),
      };
      const governance = new StrategyGovernanceService({
        store: runtime.strategyGovernance,
        audit: failingAudit,
      });
      const policyWrite = governance.updatePolicy({
        schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
        expectedRevision: 0,
        instance: {
          enabledIds: ["war-room", "beacon"],
          visibleIds: ["war-room", "beacon"],
          defaultId: "war-room",
          selectionMode: "free",
          approvedIds: ["war-room", "beacon"],
        },
        roleRules: [],
      }, "local:admin", "test");
      await auditReached;
      let unrelatedConfirmed = false;
      const unrelatedWrite = runtime.audit.append({
        identity: "local:operator",
        action: "unrelated_operation",
        target: "fixture",
        origin: "test",
        outcome: "success",
      }).then(() => { unrelatedConfirmed = true; });
      await Promise.resolve();
      expect(unrelatedConfirmed).toBe(false);
      releaseFailure();
      await expect(policyWrite).rejects.toThrow(/injected delayed strategy audit failure/u);
      await unrelatedWrite;
      expect((await governance.loadPolicy()).revision).toBe(0);
      expect(await runtime.audit.list({ action: "unrelated_operation" })).toHaveLength(1);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.audit.list({ action: "unrelated_operation" })).toHaveLength(1);
      expect((await new StrategyGovernanceService({
        store: reopened.strategyGovernance,
        audit: reopened.audit,
      }).loadPolicy()).revision).toBe(0);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the collaboration stores across a process reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(first.catalog, first.audit);
      const cases = new CaseService(evidence, first.audit, first.cases, catalog);
      const created = await cases.createCase(actor, {
        title: "SQLite persistence",
        problemStatement: "Synthetic alerts repeat after a fixture restart.",
      }, "test");
      await cases.updateSituation(created.id, actor, {
        affectedParties: "Fixture operators",
        impact: "Synthetic alerts require manual review.",
        scope: "One disposable fixture environment.",
        openQuestions: ["Does the alert stop after the next fixture cycle?"],
      }, 0, "test");
      const session = await first.sessions.create({
        identity: { id: actor.id, username: actor.username, displayName: "Case Lead" },
        groups: ["local:case-lead"],
        ttlMs: 60_000,
      });
      await first.roleStore.set("local:case-lead", "case-lead", actor.id);
      await first.audit.append({
        identity: actor.id,
        action: "sqlite_test",
        target: created.id,
        origin: "test",
        outcome: "success",
      });
      first.state.ping();
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopened = await second.cases.getCase(created.id);
      expect(reopened?.title).toBe("SQLite persistence");
      expect(reopened?.problemStatement).toBe("Synthetic alerts repeat after a fixture restart.");
      expect(reopened?.affectedParties).toBe("Fixture operators");
      expect(reopened?.openQuestions).toEqual([
        "Does the alert stop after the next fixture cycle?",
      ]);
      expect(reopened?.situationVersion).toBe(1);
      expect((await second.sessions.getByToken(session.token))?.identity.username).toBe("lead");
      expect(await second.roleStore.load()).toEqual({
        entries: new Map([["local:case-lead", "case-lead"]]),
      });
      expect((await second.audit.list({ action: "sqlite_test" }))).toHaveLength(1);
      expect((await second.audit.list({ action: "case_situation_update" }))).toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists portable confirmation and actor-scoped replay state across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-portable-"));
    const path = join(root, "collab.sqlite");
    const tokenHash = "11".repeat(32);
    const transportHash = "22".repeat(32);
    const investigationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    try {
      const first = createSqliteRuntime(path);
      await first.applyState.putIntent({
        tokenHash,
        actorId: "actor-synthetic-north",
        installationId: "inst-synthetic-local",
        transportHash,
        semanticFingerprint: "33".repeat(32),
        destinationCatalogDigest: "44".repeat(32),
        identityMapDigest: "55".repeat(32),
        materializedContentDigest: "66".repeat(32),
        collisionPolicy: "remap_deterministic",
        expiresAt: "2042-03-04T12:10:00.000Z",
        appliedInvestigationId: null,
      });
      await first.applyState.markApplied(tokenHash, investigationId);
      first.state.close();

      const second = createSqliteRuntime(path);
      expect(await second.applyState.getIntent(tokenHash)).toMatchObject({
        actorId: "actor-synthetic-north",
        appliedInvestigationId: investigationId,
      });
      expect(await second.applyState.findApplied({
        actorId: "actor-synthetic-north",
        installationId: "inst-synthetic-local",
        transportHash,
      })).toMatchObject({ appliedInvestigationId: investigationId });
      expect(await second.applyState.findApplied({
        actorId: "actor-synthetic-west",
        installationId: "inst-synthetic-local",
        transportHash,
      })).toBeNull();
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls Situation state, timeline, audit, and persisted JSON back together", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const created = await cases.createCase(actor, { title: "Atomic SQLite fixture" }, "test");
      const originalAppend = runtime.audit.append.bind(runtime.audit);
      runtime.audit.append = async (record) => {
        if (record.action === "case_situation_update") {
          throw new Error("synthetic SQLite audit failure");
        }
        return originalAppend(record);
      };

      await expect(cases.updateSituation(created.id, actor, {
        problemStatement: "This update must be rolled back.",
      }, 0, "test")).rejects.toThrow("synthetic SQLite audit failure");
      expect((await runtime.cases.getCase(created.id))?.problemStatement).toBe("");
      expect((await runtime.cases.getCase(created.id))?.situationVersion).toBe(0);
      expect(await runtime.cases.listTimeline(created.id)).toHaveLength(1);
      expect(await runtime.audit.list({ action: "case_situation_update" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect((await reopened.cases.getCase(created.id))?.problemStatement).toBe("");
      expect((await reopened.cases.getCase(created.id))?.situationVersion).toBe(0);
      expect(await reopened.cases.listTimeline(created.id)).toHaveLength(1);
      expect(await reopened.audit.list({ action: "case_situation_update" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not serialize full store state for Overview reads or indexed visibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-overview-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const created = await cases.createCase(actor, { title: "Bounded Overview" }, "test");

      const originalWrite = runtime.state.write.bind(runtime.state);
      let writes = 0;
      runtime.state.write = (key, value) => {
        writes += 1;
        originalWrite(key, value);
      };

      const scope = { actorId: actor.id, isAdmin: false };
      const visibility = await runtime.cases.overviewVisibilityBoundary(scope);
      expect(visibility?.caseTitle(created.id)).toBe("Bounded Overview");
      await runtime.cases.overviewCounts(scope);
      await runtime.cases.listOverviewOpenCases(scope, 12);
      await runtime.cases.listOverviewActivity(scope, 20);
      await runtime.jobs.listOverviewJobs({
        ...scope,
        statuses: ["queued", "running"],
        limit: 20,
        visibility,
      });
      await runtime.experiments.listOverviewProposed({
        ...scope,
        limit: 20,
        visibility,
      });
      expect(writes).toBe(0);

      await runtime.cases.updateCaseMeta({ id: created.id, status: "monitoring", legalHold: false });
      expect(writes).toBe(1);
      runtime.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists contribution, intake batch, and evidence mutations across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-mutators-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(first.catalog, first.audit);
      const cases = new CaseService(evidence, first.audit, first.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite mutator fixture" }, "test");
      const bytes = new TextEncoder().encode("sqlite held evidence\n");
      const uploaded = await cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "held.log",
          mediaType: "text/plain",
          bytes,
          expectedHash: sha256Hex(bytes),
          summary: "Held evidence must survive reopen.",
        },
        "test",
      );
      await first.cases.insertIntakeBatch({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        caseId: created.id,
        idempotencyKey: "intake-syn-0001",
        requestDigest: "c".repeat(64),
        origin: "test",
        sourceLabel: "synthetic-fixture",
        privacyClass: "owner_only",
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        payloadJson: JSON.stringify({ schemaId: "cd-collab.corpus_intake_batch.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      });
      first.state.close();

      const second = createSqliteRuntime(path);
      expect((await second.cases.getArtifact(uploaded.artifact.id))?.contentHash).toBe(sha256Hex(bytes));
      expect(await second.cases.getIntakeBatch(created.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toMatchObject({
        idempotencyKey: "intake-syn-0001",
        requestDigest: "c".repeat(64),
      });
      expect((await second.cases.listLatestRevisions(created.id)).some((row) => row.kind === "upload")).toBe(true);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls held evidence, timeline, and audit back on SQLite reopen after withAtomic failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-evidence-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite evidence rollback" }, "test");
      const originalAppend = runtime.audit.append.bind(runtime.audit);
      runtime.audit.append = async (record) => {
        if (record.action === "evidence_register") {
          throw new Error("synthetic SQLite evidence audit failure");
        }
        return originalAppend(record);
      };
      const bytes = new TextEncoder().encode("must not persist after audit failure\n");
      await expect(cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "held.log",
          mediaType: "text/plain",
          bytes,
          summary: "Rollback this register.",
        },
        "test",
      )).rejects.toThrow("synthetic SQLite evidence audit failure");
      expect(await runtime.cases.listArtifactsByCase(created.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await runtime.audit.list({ action: "evidence_register" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.cases.listArtifactsByCase(created.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await reopened.audit.list({ action: "evidence_register" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists contribution, intake batch, and evidence mutations across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-mutators-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(first.catalog, first.audit);
      const cases = new CaseService(evidence, first.audit, first.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite mutator fixture" }, "test");
      const bytes = new TextEncoder().encode("sqlite held evidence\n");
      const uploaded = await cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "held.log",
          mediaType: "text/plain",
          bytes,
          expectedHash: sha256Hex(bytes),
          summary: "Held evidence must survive reopen.",
        },
        "test",
      );
      await first.cases.insertIntakeBatch({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        caseId: created.id,
        idempotencyKey: "intake-syn-0001",
        requestDigest: "c".repeat(64),
        origin: "test",
        sourceLabel: "synthetic-fixture",
        privacyClass: "owner_only",
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        payloadJson: JSON.stringify({ schemaId: "cd-collab.corpus_intake_batch.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      });
      first.state.close();

      const second = createSqliteRuntime(path);
      expect((await second.cases.getArtifact(uploaded.artifact.id))?.contentHash).toBe(sha256Hex(bytes));
      expect(await second.cases.getIntakeBatch(created.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toMatchObject({
        idempotencyKey: "intake-syn-0001",
        requestDigest: "c".repeat(64),
      });
      expect((await second.cases.listLatestRevisions(created.id)).some((row) => row.kind === "upload")).toBe(true);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls held evidence, timeline, and audit back on SQLite reopen after withAtomic failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-evidence-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite evidence rollback" }, "test");
      const originalAppend = runtime.audit.append.bind(runtime.audit);
      runtime.audit.append = async (record) => {
        if (record.action === "evidence_register") {
          throw new Error("synthetic SQLite evidence audit failure");
        }
        return originalAppend(record);
      };
      const bytes = new TextEncoder().encode("must not persist after audit failure\n");
      await expect(cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "held.log",
          mediaType: "text/plain",
          bytes,
          summary: "Rollback this register.",
        },
        "test",
      )).rejects.toThrow("synthetic SQLite evidence audit failure");
      expect(await runtime.cases.listArtifactsByCase(created.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await runtime.audit.list({ action: "evidence_register" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.cases.listArtifactsByCase(created.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await reopened.audit.list({ action: "evidence_register" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims unreferenced CAS bytes after a promote crash across SQLite reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-pending-write-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    const evidenceRoot = join(root, "evidence");
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: evidenceRoot });
      evidence.addReferencedContentHashSource(() => first.cases.listReferencedContentHashes());
      const catalog = new CatalogService(first.catalog, first.audit);
      const cases = new CaseService(evidence, first.audit, first.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite promote crash fixture" }, "test");
      const keptBytes = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic sqlite kept stall\n");
      const kept = await cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "kept-sqlite.log",
          mediaType: "text/plain",
          bytes: keptBytes,
          summary: "Synthetic SQLite kept stall.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const crashedBytes = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic sqlite crash residue\n");
      const batch = await evidence.beginWriteBatch();
      const crashedMeta = await batch.put(crashedBytes, { contentType: "text/plain" });
      await batch.promote();
      await abandonWriteBatchForCrashTest(batch);
      first.state.close();

      const second = createSqliteRuntime(path);
      const recoveredStore = new FilesystemEvidenceStore({ rootDir: evidenceRoot });
      recoveredStore.addReferencedContentHashSource(() => second.cases.listReferencedContentHashes());
      const recovered = await recoveredStore.recoverUnreferencedWrites();
      expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
      expect(await recoveredStore.head(crashedMeta.hash)).toBeNull();
      expect(await recoveredStore.verify(kept.artifact.contentHash ?? "")).toBe(true);
      expect(await second.cases.listArtifactsByCase(created.id)).toHaveLength(1);
      expect((await second.cases.listTimeline(created.id)).filter((event) => event.kind === "evidence_registered"))
        .toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls a triage job insert back across SQLite reopen after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-triage-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "triage_job_created") {
          throw new Error("injected timeline failure:triage_job_created");
        }
        return originalAppend(caseId, event);
      };
      const service = new TriageRunService({
        cases,
        audit: runtime.audit,
        jobs: runtime.jobs,
      });
      const created = await cases.createCase(actor, { title: "SQLite triage rollback" }, "test");
      const artifact = await cases.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("checkout timeout"),
          summary: "Synthetic checkout timeout.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const snapshot = await cases.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
        "test",
      );
      await expect(
        service.create(
          created.id,
          actor,
          {
            schemaId: "cd-collab.triage_job_request.v1",
            snapshotId: snapshot.id,
            mode: "deterministic_mock",
            strategyId: "contextdesk.standard",
            question: "What happened and what should we inspect next?",
            policyFingerprint: null,
            taskFingerprint: "task-fingerprint",
            candidates: [{
              candidateId: "candidate-1",
              role: "reviewer",
              provider: "synthetic",
              profileId: null,
              model: "qwen-3.6-27b",
              version: null,
            }],
          },
          "test",
          false,
          true,
        ),
      ).rejects.toThrow(/injected timeline failure:triage_job_created/);
      expect(await runtime.jobs.listByCase(created.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "triage_job_created")).toBe(false);
      expect(await runtime.audit.list({ action: "triage_job_create" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.jobs.listByCase(created.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "triage_job_created")).toBe(false);
      expect(await reopened.audit.list({ action: "triage_job_create" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls an experiment insert back across SQLite reopen after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-experiment-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "experiment_imported") {
          throw new Error("injected timeline failure:experiment_imported");
        }
        return originalAppend(caseId, event);
      };
      const service = new ExperimentService({
        cases,
        audit: runtime.audit,
        experiments: runtime.experiments,
      });
      const created = await cases.createCase(actor, { title: "SQLite experiment rollback" }, "test");
      await expect(
        service.importEnvelope(created.id, actor, EXPERIMENT_SUMMARY, "test", false),
      ).rejects.toThrow(/injected timeline failure:experiment_imported/);
      expect(await runtime.experiments.listByCase(created.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "experiment_imported")).toBe(false);
      expect(await runtime.audit.list({ action: "experiment_import" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.experiments.listByCase(created.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "experiment_imported")).toBe(false);
      expect(await reopened.audit.list({ action: "experiment_import" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls an imported run insert back across SQLite reopen after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-import-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "external_run_imported") {
          throw new Error("injected timeline failure:external_run_imported");
        }
        return originalAppend(caseId, event);
      };
      const imports = new ImportService({
        evidence,
        audit: runtime.audit,
        cases,
        catalog,
        runs: runtime.runs,
      });
      const created = await cases.createCase(actor, { title: "SQLite import rollback" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText: "synthetic sqlite imported timeout transcript",
            sourceId: source.id,
            operatorId: "local:operator",
            operatorUsername: "operator",
          },
          "test",
          false,
        ),
      ).rejects.toThrow(/injected timeline failure:external_run_imported/);
      expect(await runtime.runs.listByCase(created.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "external_run_imported")).toBe(false);
      expect(await runtime.audit.list({ action: "external_run_import" })).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.runs.listByCase(created.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "external_run_imported")).toBe(false);
      expect(await reopened.audit.list({ action: "external_run_import" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls corroboration back across SQLite reopen after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-corroborate-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const imports = new ImportService({
        evidence,
        audit: runtime.audit,
        cases,
        catalog,
        runs: runtime.runs,
      });
      const created = await cases.createCase(actor, { title: "SQLite corroboration rollback" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText: "synthetic sqlite imported timeout transcript",
          sourceId: source.id,
          operatorId: "local:operator",
          operatorUsername: "operator",
        },
        "test",
        false,
      );
      const note = await cases.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Synthetic corroborating observation." },
        "test",
      );
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "run_corroboration") {
          throw new Error("injected timeline failure:run_corroboration");
        }
        return originalAppend(caseId, event);
      };
      await expect(
        imports.corroborate(
          created.id,
          imported.id,
          actor,
          { state: "corroborated", links: [{ kind: "contribution", id: note.id }] },
          "test",
          false,
        ),
      ).rejects.toThrow(/injected timeline failure:run_corroboration/);
      expect(await runtime.runs.listCorroborations(imported.id)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "run_corroboration")).toBe(false);
      expect(await runtime.audit.list({ action: "run_corroboration" })).toEqual([]);
      expect((await imports.getRun(created.id, imported.id, actor, false))?.corroborationState).toBe("unverified");
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.runs.listCorroborations(imported.id)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "run_corroboration")).toBe(false);
      expect(await reopened.audit.list({ action: "run_corroboration" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls a first-use human source back across SQLite reopen after contribution timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-catalog-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "contribution_created") {
          throw new Error("injected timeline failure:contribution_created");
        }
        return originalAppend(caseId, event);
      };
      const created = await cases.createCase(actor, { title: "SQLite catalog rollback" }, "test");
      expect((await catalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      await expect(
        cases.addContribution(
          created.id,
          actor,
          { kind: "note", body: "Synthetic sqlite timeout observation before catalog mint." },
          "test",
        ),
      ).rejects.toThrow(/injected timeline failure:contribution_created/);
      expect(await cases.listContributions(created.id, actor, true)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "contribution_created")).toBe(false);
      expect(await runtime.audit.list({ action: "contribution_create" })).toEqual([]);
      expect(await runtime.audit.list({ action: "catalog_create" })).toEqual([]);
      expect((await catalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedCatalog = new CatalogService(reopened.catalog, reopened.audit);
      expect((await reopenedCatalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "contribution_created")).toBe(false);
      expect(await reopened.audit.list({ action: "catalog_create" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls a first-use human source back across SQLite reopen after evidence timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-catalog-evidence-atomic-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "evidence_registered") {
          throw new Error("injected timeline failure:evidence_registered");
        }
        return originalAppend(caseId, event);
      };
      const created = await cases.createCase(actor, { title: "SQLite catalog evidence rollback" }, "test");
      expect((await catalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      await expect(
        cases.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "mailer.log",
            mediaType: "text/plain",
            bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n"),
            summary: "Synthetic mailer timeout.",
            privacyClass: "share_safe",
          },
          "test",
        ),
      ).rejects.toThrow(/injected timeline failure:evidence_registered/);
      expect(await cases.listArtifacts(created.id, actor, true)).toEqual([]);
      expect((await runtime.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await runtime.audit.list({ action: "evidence_register" })).toEqual([]);
      expect(await runtime.audit.list({ action: "catalog_create" })).toEqual([]);
      expect((await catalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedCatalog = new CatalogService(reopened.catalog, reopened.audit);
      expect((await reopenedCatalog.list()).some((source) => source.identityId === actor.id)).toBe(false);
      expect((await reopened.cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(await reopened.audit.list({ action: "catalog_create" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
