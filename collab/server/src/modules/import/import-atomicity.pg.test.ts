import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  parseExternalRunImportSuccess,
  parseSourceMutationSuccess,
  type ExternalRunImportRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgAuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { CaseService, PgCaseStore } from "../cases/index.js";
import { ImportService, PgRunStore } from "./index.js";

const ACTOR = { id: "local:alice", username: "alice" };

function strictRequest(caseId: string, sourceId: string): ExternalRunImportRequestV1 {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
    importMode: "manual",
    caseId,
    sourceId,
    expectedSourceRevision: 1,
    outputText: "PostgreSQL atomic import",
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "exact",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    evidenceArtifactIds: [],
    snapshotBinding: null,
    visibilityNote: null,
    operator: null,
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    idempotencyKey: "strict-pg-import-0001",
  };
}

describe.skipIf(!adminUrl())("PostgreSQL strict external-run import atomicity", () => {
  it("locks case, replay intent, and source in one case transaction and replays once", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const sql: string[] = [];
      pool.on("connect", (connected) => {
        const originalQuery = connected.query.bind(connected);
        connected.query = ((...args: Parameters<typeof connected.query>) => {
          sql.push(typeof args[0] === "string" ? args[0] : String(args[0]));
          return originalQuery(...args);
        }) as typeof connected.query;
      });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-strict-import-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const runs = new PgRunStore(pool);
      const imports = new ImportService({ evidence, audit, cases, catalog, runs });
      try {
        const created = await cases.createCase(ACTOR, { title: "PG strict import" }, "test");
        const source = parseSourceMutationSuccess(await catalog.applyCreate(ACTOR, {
          schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
          name: "PG strict assistant",
          kind: "external-tool",
          description: null,
          identityId: null,
          expectedRevision: 0,
          idempotencyKey: "strict-pg-source-0001",
        }, "test")).applied;
        sql.length = 0;

        const request = strictRequest(created.id, source.id);
        const fresh = await imports.importRunStrict(
          created.id,
          ACTOR,
          request,
          "test",
          false,
          { canReadPrivate: true, canSeeDirectoryIdentities: false },
        );
        expect(parseExternalRunImportSuccess(fresh).replayed).toBe(false);

        const caseLock = sql.findIndex((statement) =>
          statement.includes("SELECT id FROM cases WHERE id = $1 FOR UPDATE"));
        const intentLock = sql.findIndex((statement) =>
          statement.includes("FROM external_run_import_success_intents")
          && statement.includes("FOR UPDATE"));
        const sourceLock = sql.findIndex((statement) =>
          statement.includes("SELECT id FROM catalog_sources WHERE id = $1 FOR UPDATE"));
        expect(caseLock).toBeGreaterThanOrEqual(0);
        expect(intentLock).toBeGreaterThan(caseLock);
        expect(sourceLock).toBeGreaterThan(intentLock);
        expect(sql.filter((statement) => statement === "BEGIN")).toHaveLength(1);
        expect(sql.filter((statement) => statement === "COMMIT")).toHaveLength(1);

        const replay = await imports.importRunStrict(
          created.id,
          ACTOR,
          { ...request, expectedSourceRevision: 99 },
          "test",
          false,
          { canReadPrivate: true, canSeeDirectoryIdentities: false },
        );
        expect(parseExternalRunImportSuccess(replay).replayed).toBe(true);
        expect(replay.applied.id).toBe(fresh.applied.id);
        expect(await runs.listByCase(created.id)).toHaveLength(1);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
