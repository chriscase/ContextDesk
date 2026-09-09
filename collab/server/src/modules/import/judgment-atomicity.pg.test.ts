import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  parseExternalRunJudgmentSuccess,
  type ExternalRunJudgmentRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { PgAuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  PgCaseStore,
} from "../cases/index.js";
import {
  ExternalRunJudgmentConflictError,
  ImportService,
} from "./service.js";
import { PgRunStore, type FrozenRunRow } from "./store.js";

const ACTOR = { id: "local:alice", username: "alice" };
const RUN_ID = "33333333-3333-4333-8333-333333333333";

function request(
  caseId: string,
  idempotencyKey: string,
  expectedSequence = 0,
): ExternalRunJudgmentRequestV1 {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId,
    runId: RUN_ID,
    expectedSequence,
    idempotencyKey,
    judgment: "insufficient_evidence",
    links: [],
    rationale: "A human must compare this output with recorded evidence.",
  };
}

describe.skipIf(!adminUrl())("PostgreSQL external-run judgment atomicity", () => {
  it("serializes concurrent CAS and same-key replay behind the case row", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 6 });
      const sql: { connection: number; transaction: number; statement: string }[] = [];
      let nextConnection = 0;
      pool.on("connect", (connected) => {
        const connection = ++nextConnection;
        let transaction = 0;
        const originalQuery = connected.query.bind(connected);
        connected.query = ((...args: Parameters<typeof connected.query>) => {
          const statement = typeof args[0] === "string" ? args[0] : String(args[0]);
          if (statement === "BEGIN") transaction += 1;
          sql.push({
            connection,
            transaction,
            statement,
          });
          return originalQuery(...args);
        }) as typeof connected.query;
      });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-run-judgment-"));
      try {
        const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
        const audit = new PgAuditStore(pool);
        const catalog = new CatalogService(new PgCatalogStore(pool), audit);
        const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
        const runs = new PgRunStore(pool);
        const imports = new ImportService({ evidence, audit, cases, catalog, runs });
        const created = await cases.createCase(ACTOR, { title: "PG run judgment" }, "test");
        const source = await catalog.ensureHumanSource(ACTOR);
        const contribution = await cases.addContribution(
          created.id,
          ACTOR,
          { kind: "note", body: "Imported run fixture." },
          "test",
        );
        await runs.insert(storedRun(created.id, contribution.id, source.id));
        sql.length = 0;

        const sameKey = request(created.id, "judgment-pg-same-01");
        const sameKeyResults = await Promise.all([
          imports.addRunJudgment(created.id, RUN_ID, ACTOR, sameKey, "test", false),
          imports.addRunJudgment(created.id, RUN_ID, ACTOR, sameKey, "test", false),
        ]);
        expect(sameKeyResults.map((row) => parseExternalRunJudgmentSuccess(row).replayed).sort())
          .toEqual([false, true]);
        expect(await runs.listJudgments(RUN_ID)).toHaveLength(1);

        const mutationTransactions = new Set(
          sql.filter(({ statement }) => statement.includes("pg_advisory_xact_lock"))
            .map(({ connection, transaction }) => `${connection}:${transaction}`),
        );
        expect(mutationTransactions.size).toBe(2);
        const transactionTraces = [...mutationTransactions].map((transactionKey) => {
          const statements = sql.filter(({ connection, transaction }) =>
            `${connection}:${transaction}` === transactionKey)
            .map((row) => row.statement);
          const caseLock = statements.findIndex((statement) =>
            statement.includes("SELECT id FROM cases WHERE id = $1 FOR UPDATE"));
          const advisory = statements.findIndex((statement) =>
            statement.includes("pg_advisory_xact_lock")
            && statement.includes("hashtextextended"));
          const intentRead = statements.findIndex((statement) =>
            statement.includes("FROM external_run_judgment_success_intents"));
          const runReload = statements.findIndex((statement, index) =>
            index > intentRead && statement.includes("FROM imported_runs WHERE id = $1"));
          expect(caseLock).toBeGreaterThanOrEqual(0);
          expect(advisory).toBeGreaterThan(caseLock);
          expect(intentRead).toBeGreaterThan(advisory);
          expect(statements[intentRead]).not.toContain("FOR UPDATE");
          return { statements, intentRead, runReload };
        });
        const freshWrites = transactionTraces.filter(({ statements }) =>
          statements.some((statement) => statement.includes("INSERT INTO external_run_judgments")),
        );
        const replays = transactionTraces.filter(({ statements }) =>
          !statements.some((statement) => statement.includes("INSERT INTO external_run_judgments")),
        );
        expect(freshWrites).toHaveLength(1);
        expect(replays).toHaveLength(1);
        const freshWrite = freshWrites[0];
        const replay = replays[0];
        if (!freshWrite || !replay) throw new Error("expected one fresh write and one replay");
        expect(freshWrite.runReload).toBeGreaterThan(freshWrite.intentRead);
        expect(replay.runReload).toBe(-1);

        const contenders = await Promise.allSettled([
          imports.addRunJudgment(
            created.id,
            RUN_ID,
            ACTOR,
            request(created.id, "judgment-pg-cas-a", 1),
            "test",
            false,
          ),
          imports.addRunJudgment(
            created.id,
            RUN_ID,
            ACTOR,
            request(created.id, "judgment-pg-cas-b", 1),
            "test",
            false,
          ),
        ]);
        expect(contenders.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        const rejection = contenders.find((row) => row.status === "rejected");
        expect(rejection?.status === "rejected" ? rejection.reason : null)
          .toBeInstanceOf(ExternalRunJudgmentConflictError);
        expect((await runs.listJudgments(RUN_ID)).map((row) => row.seq)).toEqual([1, 2]);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("rolls back pre-commit failure and replays after an interrupted COMMIT response", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      let interruptNextCommit = false;
      const pool = new Pool({ connectionString: url, max: 4 });
      pool.on("connect", (connected) => {
        const originalQuery = connected.query.bind(connected);
        connected.query = (async (...args: Parameters<typeof connected.query>) => {
          const statement = typeof args[0] === "string" ? args[0] : String(args[0]);
          const result = await originalQuery(...args);
          if (statement === "COMMIT" && interruptNextCommit) {
            interruptNextCommit = false;
            throw new Error("synthetic interrupted COMMIT response");
          }
          return result;
        }) as typeof connected.query;
      });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-run-judgment-outcome-"));
      try {
        const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
        const audit = new PgAuditStore(pool);
        const catalog = new CatalogService(new PgCatalogStore(pool), audit);
        const caseStore = new PgCaseStore(pool);
        const cases = new CaseService(evidence, audit, caseStore, catalog);
        const runs = new PgRunStore(pool);
        const imports = new ImportService({ evidence, audit, cases, catalog, runs });
        const created = await cases.createCase(ACTOR, { title: "PG judgment outcome" }, "test");
        const source = await catalog.ensureHumanSource(ACTOR);
        const contribution = await cases.addContribution(
          created.id,
          ACTOR,
          { kind: "note", body: "Imported run fixture." },
          "test",
        );
        await runs.insert(storedRun(created.id, contribution.id, source.id));

        const originalTimeline = cases.appendDomainTimeline.bind(cases);
        cases.appendDomainTimeline = async (caseId, event) => {
          if (event.kind === "external_run_judgment_recorded") {
            throw new Error("synthetic judgment timeline failure");
          }
          return originalTimeline(caseId, event);
        };
        await expect(imports.addRunJudgment(
          created.id,
          RUN_ID,
          ACTOR,
          request(created.id, "judgment-pg-rollback-01"),
          "test",
          false,
        )).rejects.toThrow(/synthetic judgment timeline failure/);
        expect(await runs.listJudgments(RUN_ID)).toEqual([]);
        cases.appendDomainTimeline = originalTimeline;

        const payload = request(created.id, "judgment-pg-unknown-01");
        interruptNextCommit = true;
        await expect(imports.addRunJudgment(
          created.id,
          RUN_ID,
          ACTOR,
          payload,
          "test",
          false,
        )).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
        expect(await runs.listJudgments(RUN_ID)).toHaveLength(1);
        const replay = await imports.addRunJudgment(
          created.id,
          RUN_ID,
          ACTOR,
          payload,
          "test",
          false,
        );
        expect(parseExternalRunJudgmentSuccess(replay).replayed).toBe(true);
        expect(await runs.listJudgments(RUN_ID)).toHaveLength(1);
        expect((await caseStore.listTimeline(created.id)).filter(
          (event) => event.kind === "external_run_judgment_recorded",
        )).toHaveLength(1);
        expect((await audit.list({ action: "external_run_judgment_recorded" })).filter(
          (event) => event.outcome === "success",
        )).toHaveLength(1);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

function storedRun(caseId: string, contributionId: string, sourceId: string): FrozenRunRow {
  return {
    id: RUN_ID,
    caseId,
    contributionId,
    sourceId,
    outputHash: "a".repeat(64),
    outputText: "PostgreSQL external output",
    promptHash: null,
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "exact",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: ACTOR.id,
    importerUsername: ACTOR.username,
    operatorId: ACTOR.id,
    operatorUsername: ACTOR.username,
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    createdAt: "2026-09-09T12:00:00.000Z",
  };
}
