import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { parseInteractionTrace, type InteractionTraceV1 } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore, type AuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import {
  ExperimentConflictError,
  ExperimentService,
  MemoryExperimentStore,
  PgExperimentStore,
  type ExperimentStore,
} from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const QWEN = "cand-qwen-3.6-27b";
const GPT = "cand-gpt-oss-120b";
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as unknown;
const CHAT = JSON.parse(
  readFileSync(join(here, "../../../../contracts/fixtures/interaction-trace.chat.json"), "utf8"),
) as Record<string, unknown>;
const PROGRAMMATIC = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/interaction-trace.programmatic.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function remappedTrace(raw: Record<string, unknown>, candidateId: string): InteractionTraceV1 {
  return parseInteractionTrace({ ...raw, candidateId });
}

function withSlowFindTrace(inner: ExperimentStore, delayMs: number): ExperimentStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "findTrace" && typeof value === "function") {
        return async (experimentId: string, candidateId: string) => {
          const row = await (value as ExperimentStore["findTrace"]).call(
            target,
            experimentId,
            candidateId,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return row;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function memoryHarness() {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-trace-cas-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const store = new MemoryExperimentStore();
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  return { cases, experiments, store, audit };
}

async function seedExperiment(cases: CaseService, experiments: ExperimentService) {
  const created = await cases.createCase(ALICE, { title: "Synthetic trace CAS" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  return { caseId: created.id, experimentId: imported.id };
}

function conflictCode(reason: unknown): string | null {
  return reason instanceof ExperimentConflictError ? reason.code : null;
}

async function assertConcurrentIdenticalFirstTrace(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
  audit: AuditStore,
) {
  const seeded = await seedExperiment(cases, experiments);
  const payload = remappedTrace(CHAT, QWEN);
  const results = await Promise.allSettled([
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      structuredClone(payload),
      "test",
      false,
    ),
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      structuredClone(payload),
      "test",
      false,
    ),
  ]);
  const unexpected = results.filter((row) => row.status === "rejected");
  expect(
    unexpected.map((row) =>
      row.status === "rejected"
        ? `${row.reason instanceof ExperimentConflictError ? row.reason.code : "other"}:${String(row.reason)}`
        : "",
    ),
  ).toEqual([]);
  const fulfilled = results.filter(
    (row): row is PromiseFulfilledResult<InteractionTraceV1> => row.status === "fulfilled",
  );
  expect(fulfilled).toHaveLength(2);
  expect(fulfilled[0]?.value.traceId).toBe(fulfilled[1]?.value.traceId);
  expect(fulfilled[0]?.value.candidateId).toBe(QWEN);
  const traces = await store.listTraces(seeded.experimentId);
  expect(traces.filter((row) => row.candidateId === QWEN)).toHaveLength(1);
  const timeline = await cases.listTimeline(seeded.caseId);
  expect(timeline.filter((event) => event.kind === "experiment_trace_imported")).toHaveLength(1);
  const imported = await audit.list({ action: "experiment_trace_import" });
  const idempotent = await audit.list({ action: "experiment_trace_import_idempotent" });
  expect(imported).toHaveLength(1);
  expect(idempotent).toHaveLength(1);
}

async function assertConcurrentDivergentFirstTrace(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const seeded = await seedExperiment(cases, experiments);
  const results = await Promise.allSettled([
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      remappedTrace(CHAT, QWEN),
      "test",
      false,
    ),
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      remappedTrace(PROGRAMMATIC, QWEN),
      "test",
      false,
    ),
  ]);
  const unexpected = results.filter(
    (row) => row.status === "rejected" && !(row.reason instanceof ExperimentConflictError),
  );
  expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
  const fulfilled = results.filter(
    (row): row is PromiseFulfilledResult<InteractionTraceV1> => row.status === "fulfilled",
  );
  const conflicts = results.filter((row) => row.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(conflicts).toHaveLength(1);
  expect(conflictCode(conflicts[0]?.status === "rejected" ? conflicts[0].reason : null)).toBe(
    "trace_conflict",
  );
  const traces = await store.listTraces(seeded.experimentId);
  expect(traces.filter((row) => row.candidateId === QWEN)).toHaveLength(1);
  const timeline = await cases.listTimeline(seeded.caseId);
  expect(timeline.filter((event) => event.kind === "experiment_trace_imported")).toHaveLength(1);
}

async function assertConcurrentDistinctCandidates(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const seeded = await seedExperiment(cases, experiments);
  const results = await Promise.allSettled([
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      remappedTrace(CHAT, QWEN),
      "test",
      false,
    ),
    experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      remappedTrace(PROGRAMMATIC, GPT),
      "test",
      false,
    ),
  ]);
  const unexpected = results.filter((row) => row.status === "rejected");
  expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
  expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(2);
  const traces = await store.listTraces(seeded.experimentId);
  expect(new Set(traces.map((row) => row.candidateId))).toEqual(new Set([QWEN, GPT]));
  const timeline = await cases.listTimeline(seeded.caseId);
  expect(timeline.filter((event) => event.kind === "experiment_trace_imported")).toHaveLength(2);
}

describe("concurrent first interaction traces", () => {
  it("returns the same stored trace for a sequential identical import", async () => {
    const { cases, experiments, store, audit } = await memoryHarness();
    const seeded = await seedExperiment(cases, experiments);
    const payload = remappedTrace(CHAT, QWEN);
    const first = await experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      structuredClone(payload),
      "test",
      false,
    );
    const second = await experiments.importTrace(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      structuredClone(payload),
      "test",
      false,
    );
    expect(second.traceId).toBe(first.traceId);
    expect(await store.listTraces(seeded.experimentId)).toHaveLength(1);
    expect(await audit.list({ action: "experiment_trace_import_idempotent" })).toHaveLength(1);
  });
  it("keeps one first trace and returns the same row for identical concurrent imports", async () => {
    const { cases, experiments, store, audit } = await memoryHarness();
    await assertConcurrentIdenticalFirstTrace(cases, experiments, store, audit);
  });

  it("refuses a forked concurrent first trace as trace_conflict", async () => {
    const { cases, experiments, store } = await memoryHarness();
    await assertConcurrentDivergentFirstTrace(cases, experiments, store);
  });

  it("persists concurrent traces for distinct candidates", async () => {
    const { cases, experiments, store } = await memoryHarness();
    await assertConcurrentDistinctCandidates(cases, experiments, store);
  });
});

describe.skipIf(!adminUrl())("postgres concurrent first interaction traces", () => {
  it("returns the same PostgreSQL trace for a sequential identical import", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-trace-cas-sequential-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = new PgExperimentStore(pool);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        const seeded = await seedExperiment(cases, experiments);
        const payload = remappedTrace(CHAT, QWEN);
        const first = await experiments.importTrace(
          seeded.caseId,
          seeded.experimentId,
          ALICE,
          structuredClone(payload),
          "test",
          false,
        );
        const second = await experiments.importTrace(
          seeded.caseId,
          seeded.experimentId,
          BOB,
          structuredClone(payload),
          "test",
          false,
        );
        expect(second.traceId).toBe(first.traceId);
        expect(await store.listTraces(seeded.experimentId)).toHaveLength(1);
        expect(await audit.list({ action: "experiment_trace_import_idempotent" })).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });
  });
  it("keeps one PostgreSQL trace for identical concurrent first imports", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-trace-cas-identical-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = withSlowFindTrace(new PgExperimentStore(pool), 40);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        await assertConcurrentIdenticalFirstTrace(cases, experiments, store, audit);
      } finally {
        await pool.end();
      }
    });
  });

  it("maps a forked PostgreSQL first trace to trace_conflict instead of a unique-constraint failure", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-trace-cas-divergent-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = withSlowFindTrace(new PgExperimentStore(pool), 40);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        await assertConcurrentDivergentFirstTrace(cases, experiments, store);
      } finally {
        await pool.end();
      }
    });
  });

  it("persists concurrent PostgreSQL traces for distinct candidates", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-trace-cas-distinct-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const store = withSlowFindTrace(new PgExperimentStore(pool), 40);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        await assertConcurrentDistinctCandidates(cases, experiments, store);
      } finally {
        await pool.end();
      }
    });
  });
});
