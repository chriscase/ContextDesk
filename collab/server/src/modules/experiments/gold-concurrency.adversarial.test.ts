import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { GOLD_IS_HUMAN_BENCHMARK, type GoldReferenceV1 } from "@cd-collab/contracts";
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
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(
    join(here, "../../../../contracts/fixtures/experiment-package.valid.json"),
    "utf8",
  ),
) as unknown;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function withSlowListGolds(inner: ExperimentStore, delayMs: number): ExperimentStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "listGolds" && typeof value === "function") {
        return async (experimentId: string) => {
          const rows = await (value as ExperimentStore["listGolds"]).call(target, experimentId);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return rows;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function memoryHarness(delayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-gold-cas-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const cases = new CaseService(evidence, audit, new MemoryCaseStore());
  const inner = new MemoryExperimentStore();
  const store = delayMs > 0 ? withSlowListGolds(inner, delayMs) : inner;
  const experiments = new ExperimentService({ cases, audit, experiments: store });
  return { cases, experiments, store, audit };
}

async function seedAccepted(
  cases: CaseService,
  experiments: ExperimentService,
) {
  const created = await cases.createCase(ALICE, { title: "Synthetic gold CAS" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  const imported = await experiments.importEnvelope(created.id, ALICE, PACKAGE, "test", false);
  const proposed = await experiments.proposeDecision(
    created.id,
    imported.id,
    ALICE,
    {
      text: "Treat inventory timeout as the synthetic benchmark cause.",
      rationale: "Human decision over the synthetic checkout comparison.",
      evidenceRefs: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    },
    "test",
    false,
  );
  const accepted = await experiments.acceptDecision(
    created.id,
    imported.id,
    ALICE,
    proposed.revision,
    "test",
    false,
  );
  return { caseId: created.id, experimentId: imported.id, accepted };
}

function aliceFirstGold(decisionId: string, revision: number) {
  return {
    decisionId,
    expectedRevision: revision,
    expectedGoldVersion: 0,
    evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    notes: [GOLD_IS_HUMAN_BENCHMARK, "Alice's concurrent first benchmark."],
  };
}

function bobFirstGold(decisionId: string, revision: number) {
  return {
    decisionId,
    expectedRevision: revision,
    expectedGoldVersion: 0,
    evidenceAnchors: ["ev-demo-checkout-log"],
    notes: [GOLD_IS_HUMAN_BENCHMARK, "Bob's concurrent first benchmark."],
  };
}

function conflictCode(reason: unknown): string | null {
  return reason instanceof ExperimentConflictError ? reason.code : null;
}

async function assertConcurrentIdenticalFirstGold(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
  audit: AuditStore,
) {
  const seeded = await seedAccepted(cases, experiments);
  const input = aliceFirstGold(seeded.accepted.id, seeded.accepted.revision);
  const results = await Promise.allSettled([
    experiments.promoteGold(seeded.caseId, seeded.experimentId, ALICE, input, "test", false),
    experiments.promoteGold(seeded.caseId, seeded.experimentId, BOB, input, "test", false),
  ]);
  const unexpected = results.filter(
    (row) => row.status === "rejected" && !(row.reason instanceof ExperimentConflictError),
  );
  expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
  const fulfilled = results.filter(
    (row): row is PromiseFulfilledResult<GoldReferenceV1> => row.status === "fulfilled",
  );
  expect(fulfilled).toHaveLength(2);
  expect(fulfilled[0]?.value.goldId).toBe(fulfilled[1]?.value.goldId);
  expect(fulfilled[0]?.value.version).toBe(1);
  const golds = await store.listGolds(seeded.experimentId);
  expect(golds).toHaveLength(1);
  expect(golds[0]?.version).toBe(1);
  const timeline = await cases.listTimeline(seeded.caseId);
  expect(timeline.filter((event) => event.kind === "experiment_gold_promoted")).toHaveLength(1);
  const promote = await audit.list({ action: "experiment_gold_promote" });
  const idempotent = await audit.list({ action: "experiment_gold_promote_idempotent" });
  expect(promote).toHaveLength(1);
  expect(idempotent).toHaveLength(1);
}

async function assertConcurrentDivergentFirstGold(
  cases: CaseService,
  experiments: ExperimentService,
  store: ExperimentStore,
) {
  const seeded = await seedAccepted(cases, experiments);
  const results = await Promise.allSettled([
    experiments.promoteGold(
      seeded.caseId,
      seeded.experimentId,
      ALICE,
      aliceFirstGold(seeded.accepted.id, seeded.accepted.revision),
      "test",
      false,
    ),
    experiments.promoteGold(
      seeded.caseId,
      seeded.experimentId,
      BOB,
      bobFirstGold(seeded.accepted.id, seeded.accepted.revision),
      "test",
      false,
    ),
  ]);
  const unexpected = results.filter(
    (row) => row.status === "rejected" && !(row.reason instanceof ExperimentConflictError),
  );
  expect(unexpected.map((row) => (row.status === "rejected" ? String(row.reason) : ""))).toEqual([]);
  const fulfilled = results.filter(
    (row): row is PromiseFulfilledResult<GoldReferenceV1> => row.status === "fulfilled",
  );
  const conflicts = results.filter((row) => row.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(conflicts).toHaveLength(1);
  expect(conflictCode(conflicts[0]?.status === "rejected" ? conflicts[0].reason : null)).toBe(
    "stale_gold",
  );
  expect(fulfilled[0]?.value.version).toBe(1);
  const golds = await store.listGolds(seeded.experimentId);
  expect(golds).toHaveLength(1);
  expect(new Set(golds.map((row) => row.version)).size).toBe(1);
  const timeline = await cases.listTimeline(seeded.caseId);
  expect(timeline.filter((event) => event.kind === "experiment_gold_promoted")).toHaveLength(1);
}

describe("concurrent first gold promotions", () => {
  it("keeps one first version and returns the same gold for identical concurrent promotes", async () => {
    const { cases, experiments, store, audit } = await memoryHarness();
    await assertConcurrentIdenticalFirstGold(cases, experiments, store, audit);
  });

  it("refuses a forked concurrent first gold as stale_gold", async () => {
    const { cases, experiments, store } = await memoryHarness();
    await assertConcurrentDivergentFirstGold(cases, experiments, store);
  });
});

describe.skipIf(!adminUrl())("postgres concurrent first gold promotions", () => {
  it("keeps one PostgreSQL gold version for identical concurrent first promotes", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-gold-cas-identical-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const inner = new PgExperimentStore(pool);
      const store = withSlowListGolds(inner, 40);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        await assertConcurrentIdenticalFirstGold(cases, experiments, store, audit);
      } finally {
        await pool.end();
      }
    });
  });

  it("maps a forked PostgreSQL first gold to stale_gold instead of a unique-constraint failure", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-gold-cas-divergent-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool));
      const inner = new PgExperimentStore(pool);
      const store = withSlowListGolds(inner, 40);
      const experiments = new ExperimentService({ cases, audit, experiments: store });
      try {
        await assertConcurrentDivergentFirstGold(cases, experiments, store);
      } finally {
        await pool.end();
      }
    });
  });
});
