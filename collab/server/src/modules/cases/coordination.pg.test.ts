import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  parseInvestigationCoordinationActionSuccess,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgAuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import {
  CaseService,
  InvestigationCoordinationRefusedError,
  PgCaseStore,
} from "./index.js";

describe.skipIf(!adminUrl())("PostgreSQL investigation coordination", () => {
  it("serializes concurrent claims and persists exact actor-scoped replay", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-coordination-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const audit = new PgAuditStore(pool);
      const store = new PgCaseStore(pool);
      const cases = new CaseService(
        evidence,
        audit,
        store,
        new CatalogService(new PgCatalogStore(pool), audit),
      );
      const alice = { id: "local:alice", username: "alice" };
      const bob = { id: "local:bob", username: "bob" };
      try {
        const created = await cases.createCase(alice, { title: "PG coordination" }, "test");
        await cases.addParticipant(created.id, alice, {
          identityId: bob.id,
          username: bob.username,
        }, "test");
        const command = (actor: typeof alice, key: string) => cases.coordinateInvestigation(
          created.id,
          actor,
          false,
          {
            schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
            investigationId: created.id,
            action: "claim_self",
            expectedRevision: 0,
            idempotencyKey: key,
          },
          "test",
        );
        const results = await Promise.allSettled([
          command(alice, "pg-coord-alice"),
          command(bob, "pg-coord-bob-01"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const refused = results.find((result) => result.status === "rejected");
        expect(refused).toMatchObject({
          status: "rejected",
          reason: expect.any(InvestigationCoordinationRefusedError),
        });
        const success = results.find(
          (result): result is PromiseFulfilledResult<string> => result.status === "fulfilled",
        )!;
        expect(parseInvestigationCoordinationActionSuccess(JSON.parse(success.value)).applied.revision)
          .toBe(1);
        const winner = success.value.includes("local:alice") ? alice : bob;
        const winnerKey = winner === alice ? "pg-coord-alice" : "pg-coord-bob-01";
        const replay = await command(winner, winnerKey);
        expect(replay).toBe(success.value);
        expect((await store.listTimeline(created.id)).filter(
          (event) => event.kind === "investigation_coordination_changed",
        )).toHaveLength(1);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
