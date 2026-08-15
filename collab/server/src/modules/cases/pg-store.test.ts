import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CaseService } from "./service.js";
import { PgCaseStore } from "./store.js";

describe.skipIf(!adminUrl())("pg-backed case memory", () => {
  it("survives a new CaseService on the same database", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-cases-"));
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new MemoryAuditStore();
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const first = new CaseService(store, audit, new PgCaseStore(client));
        const created = await first.createCase(actor, { title: "Durable fixture" }, "test");
        const note = await first.addContribution(
          created.id,
          actor,
          { kind: "note", body: "revision 1" },
          "test",
        );
        await first.reviseContribution(created.id, note.id, actor, "revision 2", "test");

        const second = new CaseService(store, audit, new PgCaseStore(client));
        const reloaded = await second.getCase(created.id, actor, false);
        expect(reloaded?.title).toBe("Durable fixture");
        const chain = await second.provenance(created.id, note.id);
        expect(chain).toHaveLength(2);
        expect(chain[0]?.body).toBe("revision 1");
        expect(chain[1]?.body).toBe("revision 2");
        expect(chain[1]?.predecessorRevision).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
