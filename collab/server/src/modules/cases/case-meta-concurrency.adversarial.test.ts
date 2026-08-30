import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID } from "@cd-collab/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import {
  CaseService,
  LifecycleChangedError,
  MemoryCaseStore,
  PgCaseStore,
  type CaseStore,
} from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function withSlowUpdateCaseMeta(inner: CaseStore, delayMs: number): CaseStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "updateCaseMeta" && typeof value === "function") {
        return async (row: Parameters<CaseStore["updateCaseMeta"]>[0]) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return (value as CaseStore["updateCaseMeta"]).call(target, row);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface CaseLockBarrier {
  store: CaseStore;
  arm(): { acquired: Promise<void>; release(): void };
}

/** Pause exactly one operation after it owns the case lock, without timers. */
function withCaseLockBarrier(inner: CaseStore): CaseLockBarrier {
  let gate: {
    markAcquired(): void;
    waitForRelease: Promise<void>;
  } | null = null;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "lockCase" && typeof value === "function") {
        return async (id: string) => {
          const row = await (value as CaseStore["lockCase"]).call(target, id);
          const active = gate;
          if (active) {
            gate = null;
            active.markAcquired();
            await active.waitForRelease;
          }
          return row;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    store,
    arm() {
      if (gate) throw new Error("case lock barrier is already armed");
      let markAcquired = () => undefined;
      let release = () => undefined;
      const acquired = new Promise<void>((resolve) => {
        markAcquired = resolve;
      });
      const waitForRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { markAcquired, waitForRelease };
      return { acquired, release };
    },
  };
}

async function memoryHarness(delayMs = 15) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-case-meta-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const barrier = withCaseLockBarrier(withSlowUpdateCaseMeta(new MemoryCaseStore(), delayMs));
  const cases = new CaseService(evidence, audit, barrier.store);
  return { cases, audit, barrier };
}

async function seedCase(cases: CaseService) {
  const created = await cases.createCase(ALICE, { title: "Synthetic mailer timeout hold" }, "test");
  await cases.addParticipant(
    created.id,
    ALICE,
    { identityId: BOB.id, username: BOB.username },
    "test",
  );
  return created;
}

async function assertConcurrentStatusAndHold(cases: CaseService, caseId: string) {
  const [statusWrite, holdWrite] = await Promise.allSettled([
    cases.setStatus(caseId, ALICE, "monitoring", "test"),
    cases.setLegalHold(caseId, BOB, true, "test"),
  ]);
  expect(statusWrite.status).toBe("fulfilled");
  expect(holdWrite.status).toBe("fulfilled");
  const listed = await cases.listCases(ALICE, true);
  const row = listed.find((item) => item.id === caseId);
  expect(row?.status).toBe("monitoring");
  expect(row?.legalHold).toBe(true);
  const timeline = await cases.listTimeline(caseId);
  expect(timeline.some((event) => event.kind === "case_status")).toBe(true);
  expect(timeline.some((event) => event.kind === "legal_hold")).toBe(true);
}

async function assertConcurrentLifecycleActions(
  cases: CaseService,
  audit: MemoryAuditStore | PgAuditStore,
  caseId: string,
) {
  await cases.setStatus(caseId, ALICE, "monitoring", "test");
  const preview = await cases.lifecycleFor(caseId);
  const request = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: caseId,
    action: "archive" as const,
    expected: {
      status: preview.status,
      legalHold: preview.legalHold,
      restoreTarget: preview.restoreTarget,
    },
  };
  const results = await Promise.allSettled([
    cases.applyLifecycleAction(request, ALICE, "test"),
    cases.applyLifecycleAction(request, BOB, "test"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LifecycleChangedError);

  const row = await cases.getCase(caseId, ALICE, true);
  expect(row?.status).toBe("archived");
  const timeline = await cases.listTimeline(caseId);
  expect(
    timeline.filter((event) => {
      if (event.kind !== "case_status") return false;
      return (JSON.parse(event.payload) as { status?: unknown }).status === "archived";
    }),
  ).toHaveLength(1);
  expect(
    (await audit.list({ action: "case_status" })).filter(
      (event) => event.target === `${caseId}:archived`,
    ),
  ).toHaveLength(1);
}

async function assertLifecycleAndHoldSerialize(
  cases: CaseService,
  audit: MemoryAuditStore | PgAuditStore,
  barrier: CaseLockBarrier,
) {
  const holdFirstCase = await seedCase(cases);
  await cases.setStatus(holdFirstCase.id, ALICE, "monitoring", "test");
  const holdFirstPreview = await cases.lifecycleFor(holdFirstCase.id);
  const holdFirstRequest = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: holdFirstCase.id,
    action: "archive" as const,
    expected: {
      status: holdFirstPreview.status,
      legalHold: holdFirstPreview.legalHold,
      restoreTarget: holdFirstPreview.restoreTarget,
    },
  };
  const holdGate = barrier.arm();
  const hold = cases.setLegalHold(holdFirstCase.id, BOB, true, "test");
  await holdGate.acquired;
  const staleArchive = cases.applyLifecycleAction(holdFirstRequest, ALICE, "test");
  holdGate.release();
  const holdFirstResults = await Promise.allSettled([hold, staleArchive]);
  expect(holdFirstResults[0]?.status).toBe("fulfilled");
  expect(holdFirstResults[1]?.status).toBe("rejected");
  expect((holdFirstResults[1] as PromiseRejectedResult).reason).toBeInstanceOf(
    LifecycleChangedError,
  );
  const holdFirstAfter = await cases.getCase(holdFirstCase.id, ALICE, true);
  expect(holdFirstAfter).toMatchObject({ status: "monitoring", legalHold: true });
  const holdFirstTimeline = await cases.listTimeline(holdFirstCase.id);
  expect(
    holdFirstTimeline.filter((event) =>
      event.kind === "case_status"
      && (JSON.parse(event.payload) as { status?: unknown }).status === "archived"),
  ).toHaveLength(0);
  expect(
    (await audit.list({ action: "case_status" })).filter(
      (event) => event.target === `${holdFirstCase.id}:archived`,
    ),
  ).toHaveLength(0);

  const archiveFirstCase = await seedCase(cases);
  await cases.setStatus(archiveFirstCase.id, ALICE, "monitoring", "test");
  const archiveFirstPreview = await cases.lifecycleFor(archiveFirstCase.id);
  const archiveFirstRequest = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: archiveFirstCase.id,
    action: "archive" as const,
    expected: {
      status: archiveFirstPreview.status,
      legalHold: archiveFirstPreview.legalHold,
      restoreTarget: archiveFirstPreview.restoreTarget,
    },
  };
  const archiveGate = barrier.arm();
  const archive = cases.applyLifecycleAction(archiveFirstRequest, ALICE, "test");
  await archiveGate.acquired;
  const laterHold = cases.setLegalHold(archiveFirstCase.id, BOB, true, "test");
  archiveGate.release();
  const archiveFirstResults = await Promise.allSettled([archive, laterHold]);
  expect(archiveFirstResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  const archiveFirstAfter = await cases.getCase(archiveFirstCase.id, ALICE, true);
  expect(archiveFirstAfter).toMatchObject({ status: "archived", legalHold: true });
  const archiveFirstTimeline = await cases.listTimeline(archiveFirstCase.id);
  expect(
    archiveFirstTimeline.filter((event) =>
      event.kind === "case_status"
      && (JSON.parse(event.payload) as { status?: unknown }).status === "archived"),
  ).toHaveLength(1);
  expect(archiveFirstTimeline.filter((event) => event.kind === "legal_hold")).toHaveLength(1);
  expect(
    (await audit.list({ action: "case_status" })).filter(
      (event) => event.target === `${archiveFirstCase.id}:archived`,
    ),
  ).toHaveLength(1);
}

describe("concurrent case status and legal hold", () => {
  it("keeps both Alice status and Bob legal-hold writes", async () => {
    const { cases } = await memoryHarness();
    const created = await seedCase(cases);
    await assertConcurrentStatusAndHold(cases, created.id);
  });

  it("serializes duplicate lifecycle commands so only one can commit", async () => {
    const { cases, audit } = await memoryHarness();
    const created = await seedCase(cases);
    await assertConcurrentLifecycleActions(cases, audit, created.id);
  });

  it("serializes lifecycle actions against legal-hold mutation in either lock order", async () => {
    const { cases, audit, barrier } = await memoryHarness(0);
    await assertLifecycleAndHoldSerialize(cases, audit, barrier);
  });
});

describe.skipIf(!adminUrl())("postgres concurrent case status and legal hold", () => {
  it("keeps both writes instead of clobbering the other column", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-case-meta-"));
      dirs.push(root);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const barrier = withCaseLockBarrier(withSlowUpdateCaseMeta(new PgCaseStore(pool), 25));
      const cases = new CaseService(evidence, audit, barrier.store);
      try {
        const created = await seedCase(cases);
        await assertConcurrentStatusAndHold(cases, created.id);
        const lifecycleCase = await seedCase(cases);
        await assertConcurrentLifecycleActions(cases, audit, lifecycleCase.id);
        await assertLifecycleAndHoldSerialize(cases, audit, barrier);
      } finally {
        await pool.end();
      }
    });
  });
});
