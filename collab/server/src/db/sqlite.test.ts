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
      const created = await cases.createCase(actor, { title: "SQLite persistence" }, "test");
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
      expect((await second.sessions.getByToken(session.token))?.identity.username).toBe("lead");
      expect(await second.roleStore.load()).toEqual({
        entries: new Map([["local:case-lead", "case-lead"]]),
      });
      expect((await second.audit.list({ action: "sqlite_test" }))).toHaveLength(1);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
