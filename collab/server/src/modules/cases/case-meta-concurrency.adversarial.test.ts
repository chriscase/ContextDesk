import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore, type CaseStore } from "./index.js";

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

async function memoryHarness(delayMs = 15) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-case-meta-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const store = withSlowUpdateCaseMeta(new MemoryCaseStore(), delayMs);
  const cases = new CaseService(evidence, audit, store);
  return { cases, audit };
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

describe("concurrent case status and legal hold", () => {
  it("keeps both Alice status and Bob legal-hold writes", async () => {
    const { cases } = await memoryHarness();
    const created = await seedCase(cases);
    await assertConcurrentStatusAndHold(cases, created.id);
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
      const store = withSlowUpdateCaseMeta(new PgCaseStore(pool), 25);
      const cases = new CaseService(evidence, audit, store);
      try {
        const created = await seedCase(cases);
        await assertConcurrentStatusAndHold(cases, created.id);
      } finally {
        await pool.end();
      }
    });
  });
});
