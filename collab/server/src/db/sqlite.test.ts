import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { createSqliteRuntime } from "./sqlite.js";

describe("SQLite local runtime", () => {
  it("persists the collaboration stores across a process reopen", async () => {
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-"));
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

  it("rolls Situation state, timeline, audit, and persisted JSON back together", async () => {
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-atomic-"));
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
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-overview-"));
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
});
