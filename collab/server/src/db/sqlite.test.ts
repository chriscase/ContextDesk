import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore, sha256Hex } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { createSqliteRuntime } from "./sqlite.js";

describe("SQLite local runtime", () => {
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
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-mutators-"));
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
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-evidence-atomic-"));
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
});
