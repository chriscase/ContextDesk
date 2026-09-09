import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseInvestigationCoordinationActionSuccess,
  parseExternalRunJudgmentSuccess,
  parseSourceMutationSuccess,
} from "@cd-collab/contracts";
import { FilesystemEvidenceStore, abandonWriteBatchForCrashTest, sha256Hex } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { ExperimentService } from "../modules/experiments/index.js";
import { ImportService, type RunStore } from "../modules/import/index.js";
import { TriageRunService } from "../modules/triage-runs/index.js";
import { StrategyGovernanceService } from "../modules/strategy-governance/index.js";
import { createSqliteRuntime } from "./sqlite.js";

const EXPERIMENT_SUMMARY = JSON.parse(
  readFileSync(new URL("../../../contracts/fixtures/experiment-summary.valid.json", import.meta.url), "utf8"),
) as unknown;

type StoredRun = Parameters<RunStore["insert"]>[0];
type StoredImportIntent = Parameters<RunStore["insertImportSuccessIntent"]>[0];

function judgmentRequest(caseId: string, runId: string, idempotencyKey: string) {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId,
    runId,
    expectedSequence: 0,
    idempotencyKey,
    judgment: "insufficient_evidence" as const,
    links: [],
    rationale: "A human must compare this output with recorded evidence.",
  };
}

function strictStoredRun(caseId: string, id: string): StoredRun {
  return {
    id,
    caseId,
    contributionId: "22222222-2222-4222-8222-222222222222",
    sourceId: "00000000-0000-0000-0000-000000000001",
    outputHash: "a".repeat(64),
    outputText: "strict sqlite output",
    promptHash: null,
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "exact",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: "local:lead",
    importerUsername: "lead",
    operatorId: "local:lead",
    operatorUsername: "lead",
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    createdAt: "2026-09-05T12:00:00.000Z",
    importMode: "manual",
    sourceRevision: 1,
    evidenceArtifactIds: [],
  };
}

function strictStoredIntent(
  caseId: string,
  runId: string,
  idempotencyKey: string,
): StoredImportIntent {
  return {
    caseId,
    actorId: "local:lead",
    idempotencyKey,
    requestDigest: "b".repeat(64),
    runId,
    successJson: "{\"schemaId\":\"cd-collab.external_run_import_success.v1\"}",
    createdAt: "2026-09-05T12:00:00.000Z",
  };
}

function legacyStoredRun(caseId: string, id: string): StoredRun {
  const row = strictStoredRun(caseId, id);
  delete row.importMode;
  delete row.sourceRevision;
  delete row.evidenceArtifactIds;
  return row;
}

describe("SQLite local runtime", () => {
  it("persists coordination projection and exact success replay across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-coordination-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const cases = new CaseService(
        evidence,
        first.audit,
        first.cases,
        new CatalogService(first.catalog, first.audit),
      );
      const created = await cases.createCase(actor, { title: "SQLite coordination" }, "test");
      const input = {
        schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
        investigationId: created.id,
        action: "claim_self" as const,
        expectedRevision: 0,
        idempotencyKey: "sqlite-coord-01",
      };
      const originalJson = await cases.coordinateInvestigation(
        created.id,
        actor,
        false,
        input,
        "test",
      );
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(originalJson)).applied.revision)
        .toBe(1);
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopenedCases = new CaseService(
        evidence,
        second.audit,
        second.cases,
        new CatalogService(second.catalog, second.audit),
      );
      expect((await second.cases.getInvestigationCoordination(created.id))?.revision).toBe(1);
      const replayJson = await reopenedCases.coordinateInvestigation(
        created.id,
        actor,
        false,
        { ...input, expectedRevision: 99, clientTime: "2026-09-04T20:00:00Z" },
        "test",
      );
      expect(replayJson).toBe(originalJson);
      expect((await second.cases.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls coordination projection and success intent back across SQLite reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-coordination-rollback-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const cases = new CaseService(
        evidence,
        first.audit,
        first.cases,
        new CatalogService(first.catalog, first.audit),
      );
      const created = await cases.createCase(actor, { title: "SQLite coordination rollback" }, "test");
      const originalAppend = first.audit.append.bind(first.audit);
      first.audit.append = async (record) => {
        if (record.action === "investigation_coordination_changed") {
          throw new Error("synthetic coordination audit failure");
        }
        return originalAppend(record);
      };
      await expect(cases.coordinateInvestigation(
        created.id,
        actor,
        false,
        {
          schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
          investigationId: created.id,
          action: "claim_self",
          expectedRevision: 0,
          idempotencyKey: "sqlite-coord-rollback",
        },
        "test",
      )).rejects.toThrow("synthetic coordination audit failure");
      first.state.close();

      const second = createSqliteRuntime(path);
      expect(await second.cases.getInvestigationCoordination(created.id)).toBeNull();
      expect(await second.cases.getInvestigationCoordinationSuccessIntent(
        created.id,
        actor.id,
        "sqlite-coord-rollback",
      )).toBeNull();
      expect((await second.cases.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(0);
      expect(await second.audit.list({ action: "investigation_coordination_changed" })).toEqual([]);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists and rolls back strict run markers and replay intents with the case transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-strict-import-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const cases = new CaseService(
        evidence,
        first.audit,
        first.cases,
        new CatalogService(first.catalog, first.audit),
      );
      const created = await cases.createCase(actor, { title: "SQLite strict import" }, "test");
      const durableRun = strictStoredRun(
        created.id,
        "33333333-3333-4333-8333-333333333333",
      );
      const durableIntent = strictStoredIntent(created.id, durableRun.id, "sqlite-import-01");
      await cases.withAtomic(async () => {
        await first.runs.insert(durableRun);
        await first.runs.insertImportSuccessIntent(durableIntent);
      });
      first.state.close();

      const second = createSqliteRuntime(path);
      expect(await second.runs.get(durableRun.id)).toMatchObject({
        importMode: "manual",
        sourceRevision: 1,
        evidenceArtifactIds: [],
      });
      expect(await second.runs.lockImportSuccessIntent(
        durableIntent.caseId,
        durableIntent.actorId,
        durableIntent.idempotencyKey,
      )).toEqual(durableIntent);
      const reopenedCases = new CaseService(
        evidence,
        second.audit,
        second.cases,
        new CatalogService(second.catalog, second.audit),
      );
      const rolledBackRun = strictStoredRun(
        created.id,
        "44444444-4444-4444-8444-444444444444",
      );
      const rolledBackIntent = strictStoredIntent(
        created.id,
        rolledBackRun.id,
        "sqlite-import-rollback",
      );
      await expect(reopenedCases.withAtomic(async () => {
        await second.runs.insert(rolledBackRun);
        await second.runs.insertImportSuccessIntent(rolledBackIntent);
        throw new Error("synthetic strict import rollback");
      })).rejects.toThrow("synthetic strict import rollback");
      second.state.close();

      const third = createSqliteRuntime(path);
      expect(await third.runs.get(durableRun.id)).not.toBeNull();
      expect(await third.runs.get(rolledBackRun.id)).toBeNull();
      expect(await third.runs.lockImportSuccessIntent(
        rolledBackIntent.caseId,
        rolledBackIntent.actorId,
        rolledBackIntent.idempotencyKey,
      )).toBeNull();
      third.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens a pre-judgment run store and durably accepts its first judgment", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-legacy-run-"));
    const path = join(root, "collab.sqlite");
    const caseId = "11111111-1111-4111-8111-111111111111";
    const run = legacyStoredRun(caseId, "33333333-3333-4333-8333-333333333333");
    const encodedMap = (entries: unknown[][]) => ({
      __cd_collab_state_type: "map",
      entries,
    });
    try {
      const seed = createSqliteRuntime(path);
      const legacyPayload = {
        runs: encodedMap([[run.id, run]]),
        events: encodedMap([[run.id, []]]),
      };
      seed.state.db.prepare(
        `INSERT INTO collab_state (key, payload, updated_at) VALUES (?, ?, ?)`,
      ).run("runs", JSON.stringify(legacyPayload), "2026-09-05T12:00:00.000Z");
      seed.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.runs.get(run.id)).toEqual(run);
      expect(await reopened.runs.lockImportSuccessIntent(
        caseId,
        "local:lead",
        "legacy-import-01",
      )).toBeNull();
      await reopened.runs.appendJudgment({
        caseId,
        runId: run.id,
        seq: 1,
        judgment: "insufficient_evidence",
        actorId: "local:lead",
        actorUsername: "lead",
        links: [],
        rationale: null,
        recordedAt: "2026-09-09T12:00:00.000Z",
      });
      reopened.state.close();

      const persisted = createSqliteRuntime(path);
      expect(await persisted.runs.listJudgments(run.id)).toMatchObject([{
        caseId,
        runId: run.id,
        seq: 1,
        judgment: "insufficient_evidence",
      }]);
      persisted.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("fails closed when the persisted strategy policy fingerprint is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-strategy-corrupt-"));
    const path = join(root, "collab.sqlite");
    try {
      const first = createSqliteRuntime(path);
      const governance = new StrategyGovernanceService({
        store: first.strategyGovernance,
        audit: first.audit,
      });
      await governance.updatePolicy({
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
      const persisted = structuredClone(first.state.read("ui_strategy_governance")) as {
        policy: { fingerprint: string };
      };
      persisted.policy.fingerprint = "sha256:corrupted";
      first.state.write("ui_strategy_governance", persisted);
      first.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedGovernance = new StrategyGovernanceService({
        store: reopened.strategyGovernance,
        audit: reopened.audit,
      });
      await expect(reopenedGovernance.loadPolicy()).rejects.toThrow(/fingerprint/u);
      await expect(reopenedGovernance.effective("local:alice", ["contributor"]))
        .rejects.toThrow(/fingerprint/u);
      reopened.state.close();
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

  it("persists a judgment and exact replay across SQLite reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-run-judgment-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    const runId = "33333333-3333-4333-8333-333333333333";
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const imports = new ImportService({ evidence, audit: runtime.audit, cases, catalog, runs: runtime.runs });
      const created = await cases.createCase(actor, { title: "SQLite run judgment" }, "test");
      await runtime.runs.insert(strictStoredRun(created.id, runId));
      const request = judgmentRequest(created.id, runId, "sqlite-judgment-01");
      const fresh = await imports.addRunJudgment(created.id, runId, actor, request, "test", false);
      expect(parseExternalRunJudgmentSuccess(fresh).replayed).toBe(false);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedEvidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const reopenedCatalog = new CatalogService(reopened.catalog, reopened.audit);
      const reopenedCases = new CaseService(
        reopenedEvidence,
        reopened.audit,
        reopened.cases,
        reopenedCatalog,
      );
      const reopenedImports = new ImportService({
        evidence: reopenedEvidence,
        audit: reopened.audit,
        cases: reopenedCases,
        catalog: reopenedCatalog,
        runs: reopened.runs,
      });
      expect(await reopened.runs.listJudgments(runId)).toHaveLength(1);
      const replay = await reopenedImports.addRunJudgment(
        created.id,
        runId,
        actor,
        { ...request, expectedSequence: 99 },
        "test",
        false,
      );
      expect(parseExternalRunJudgmentSuccess(replay).replayed).toBe(true);
      expect(await reopened.runs.listJudgments(runId)).toHaveLength(1);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls a judgment and replay intent back across SQLite reopen after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-run-judgment-rollback-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    const runId = "33333333-3333-4333-8333-333333333333";
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const imports = new ImportService({ evidence, audit: runtime.audit, cases, catalog, runs: runtime.runs });
      const created = await cases.createCase(actor, { title: "SQLite judgment rollback" }, "test");
      await runtime.runs.insert(strictStoredRun(created.id, runId));
      const originalAppend = runtime.cases.appendTimeline.bind(runtime.cases);
      runtime.cases.appendTimeline = async (caseId, event) => {
        if (event.kind === "external_run_judgment_recorded") {
          throw new Error("injected timeline failure:external_run_judgment_recorded");
        }
        return originalAppend(caseId, event);
      };
      await expect(imports.addRunJudgment(
        created.id,
        runId,
        actor,
        judgmentRequest(created.id, runId, "sqlite-judgment-rollback-01"),
        "test",
        false,
      )).rejects.toThrow(/injected timeline failure:external_run_judgment_recorded/);
      expect(await runtime.runs.listJudgments(runId)).toEqual([]);
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      expect(await reopened.runs.listJudgments(runId)).toEqual([]);
      expect((await reopened.cases.listTimeline(created.id)).some(
        (event) => event.kind === "external_run_judgment_recorded",
      )).toBe(false);
      expect(await reopened.audit.list({ action: "external_run_judgment_recorded" })).toEqual([]);
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

  it("persists source revision, success intent, and exact replay across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-catalog-cas-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    const request = {
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name: "SQLite assistant",
      kind: "external-tool" as const,
      description: null,
      identityId: null,
      expectedRevision: 0 as const,
      idempotencyKey: "src-sqlite-create",
    };
    try {
      const first = createSqliteRuntime(path);
      const catalog = new CatalogService(first.catalog, first.audit);
      const created = parseSourceMutationSuccess(await catalog.applyCreate(actor, request, "test"));
      expect(created.applied.revision).toBe(1);
      const retired = parseSourceMutationSuccess(
        await catalog.applyRetire(
          actor,
          {
            schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
            sourceId: created.sourceId,
            expectedRevision: 1,
            idempotencyKey: "src-sqlite-retire",
          },
          "test",
        ),
      );
      expect(retired.appliedRevision).toBe(2);
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopened = new CatalogService(second.catalog, second.audit);
      const stored = await reopened.get(created.sourceId);
      expect(stored?.revision).toBe(2);
      expect(stored?.lifecycle).toBe("retired");
      const replay = parseSourceMutationSuccess(await reopened.applyCreate(actor, request, "test"));
      expect(replay.replayed).toBe(true);
      expect(replay.sourceId).toBe(created.sourceId);
      expect(replay.applied.revision).toBe(1);
      expect((await second.audit.list({ action: "catalog_create" })).filter((row) => row.target === created.sourceId)).toHaveLength(1);
      expect((await second.audit.list({ action: "catalog_retire" })).filter((row) => row.target === created.sourceId)).toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls source revision, success intent, and audit back across SQLite reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-catalog-cas-rollback-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      first.catalog.insertSuccessIntent = async () => {
        throw new Error("synthetic catalog intent failure");
      };
      const catalog = new CatalogService(first.catalog, first.audit);
      await expect(
        catalog.applyCreate(
          actor,
          {
            schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
            name: "SQLite boom",
            kind: "external-tool",
            description: null,
            identityId: null,
            expectedRevision: 0,
            idempotencyKey: "src-sqlite-rollback",
          },
          "test",
        ),
      ).rejects.toThrow("synthetic catalog intent failure");
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopened = new CatalogService(second.catalog, second.audit);
      expect((await reopened.list()).some((source) => source.name === "SQLite boom")).toBe(false);
      expect(await second.catalog.getSuccessIntent(actor.id, "src-sqlite-rollback")).toBeNull();
      expect(await second.audit.list({ action: "catalog_create" })).toEqual([]);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("joins a nested catalog mutation into the SQLite case transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-catalog-nested-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const runtime = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(runtime.catalog, runtime.audit);
      const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite nested catalog" }, "test");
      await expect(
        cases.withAtomic(async () => {
          await catalog.applyCreate(
            actor,
            {
              schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
              name: "Nested sqlite source",
              kind: "external-tool",
              description: null,
              identityId: null,
              expectedRevision: 0,
              idempotencyKey: "src-sqlite-nested",
            },
            "test",
          );
          throw new Error("injected nested case transaction failure");
        }),
      ).rejects.toThrow(/injected nested case transaction failure/);
      expect((await catalog.list()).some((source) => source.name === "Nested sqlite source")).toBe(
        false,
      );
      expect(await runtime.catalog.getSuccessIntent(actor.id, "src-sqlite-nested")).toBeNull();
      expect(await runtime.audit.list({ action: "catalog_create" })).toEqual([]);
      expect(await cases.getCase(created.id, actor, true)).not.toBeNull();
      runtime.state.close();

      const reopened = createSqliteRuntime(path);
      const reopenedCatalog = new CatalogService(reopened.catalog, reopened.audit);
      expect(
        (await reopenedCatalog.list()).some((source) => source.name === "Nested sqlite source"),
      ).toBe(false);
      expect(await reopened.catalog.getSuccessIntent(actor.id, "src-sqlite-nested")).toBeNull();
      expect(await reopened.audit.list({ action: "catalog_create" })).toEqual([]);
      reopened.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
