import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHostConnector } from "./connector.js";
import { ComparisonJobRunner } from "./runner.js";
import { sqliteAvailable, SqliteJobStore } from "./sqlite.js";
import { MemoryJobStore, newJobId, payloadHash, PgJobStore } from "./store.js";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";

const SNAP = "snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb";
const TASK = "task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007";

function lanes() {
  return [
    { candidateId: "cand-a", modelLabel: "model-a", profileAlias: "gpt-oss-120b" },
    { candidateId: "cand-b", modelLabel: "model-b", profileAlias: "qwen-3.6-27b" },
    { candidateId: "cand-c", modelLabel: "model-c", profileAlias: "ministral-3-14b-instruct-2512" },
  ];
}

describe("job leases", () => {
  it("acquires, renews, and recovers a stale lease after a crash", async () => {
    const store = new MemoryJobStore();
    const payload = { candidateId: "cand-a", snapshot: SNAP };
    const job = await store.insert({
      id: newJobId(),
      kind: "host_triage_lane",
      leaseOwner: null,
      leaseUntil: null,
      payloadHash: payloadHash(payload),
      payload,
      result: null,
      cancelRequested: false,
    });
    const first = await store.acquire("worker-a", 30);
    expect(first?.id).toBe(job.id);
    expect(first?.status).toBe("leased");
    const renewed = await store.renew(job.id, "worker-a", 5_000);
    expect(renewed?.leaseOwner).toBe("worker-a");

    const recovered = await store.stealStale(
      "worker-b",
      1_000,
      new Date(Date.now() + 60_000),
    );
    expect(recovered?.leaseOwner).toBe("worker-b");
    expect(recovered?.attempts).toBeGreaterThanOrEqual(2);
  });

  it("duplicate submissions with the same payload hash are idempotent", async () => {
    const store = new MemoryJobStore();
    const payload = { candidateId: "cand-a" };
    const hash = payloadHash(payload);
    const first = await store.insert({
      id: newJobId(),
      kind: "host_triage_lane",
      leaseOwner: null,
      leaseUntil: null,
      payloadHash: hash,
      payload,
      result: null,
      cancelRequested: false,
    });
    const second = await store.insert({
      id: newJobId(),
      kind: "host_triage_lane",
      leaseOwner: null,
      leaseUntil: null,
      payloadHash: hash,
      payload,
      result: null,
      cancelRequested: false,
    });
    expect(second.id).toBe(first.id);
  });
});

describe("bounded comparison runner", () => {
  it("overlaps up to the concurrency limit and projects request order", async () => {
    const connector = new FakeHostConnector({
      "cand-a": { delayMs: 80 },
      "cand-b": { delayMs: 20 },
      "cand-c": { delayMs: 20 },
    });
    const runner = new ComparisonJobRunner(new MemoryJobStore(), connector, "worker-a");
    const result = await runner.run({
      snapshotFingerprint: SNAP,
      taskFingerprint: TASK,
      lanes: lanes(),
      deadlineMs: 5_000,
      maxConcurrency: 2,
    });
    expect(connector.maxActive).toBe(2);
    expect(connector.maxActive).toBeLessThanOrEqual(2);
    expect(result.results.map((row) => row.candidateId)).toEqual(["cand-a", "cand-b", "cand-c"]);
    expect(result.stopped).toBe("none");
  });

  it("keeps sibling durable results when one lane fails", async () => {
    const connector = new FakeHostConnector({
      "cand-a": { delayMs: 40 },
      "cand-b": { delayMs: 10, fail: true },
      "cand-c": { delayMs: 10 },
    });
    const runner = new ComparisonJobRunner(new MemoryJobStore(), connector, "worker-a");
    const result = await runner.run({
      snapshotFingerprint: SNAP,
      taskFingerprint: TASK,
      lanes: lanes(),
      deadlineMs: 5_000,
      maxConcurrency: 2,
    });
    expect(result.stopped).toBe("lane_failed");
    expect(result.results[0]?.runStatus).toBe("completed");
    expect(result.results[1]?.runStatus).toBe("failed");
  });

  it("cancels in-flight lanes and preserves already-finished work", async () => {
    const connector = new FakeHostConnector({
      "cand-a": { delayMs: 200 },
      "cand-b": { delayMs: 200 },
      "cand-c": { delayMs: 200 },
    });
    const runner = new ComparisonJobRunner(new MemoryJobStore(), connector, "worker-a");
    const abort = new AbortController();
    const pending = runner.run(
      {
        snapshotFingerprint: SNAP,
        taskFingerprint: TASK,
        lanes: lanes(),
        deadlineMs: 5_000,
        maxConcurrency: 2,
      },
      abort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    const result = await pending;
    expect(result.stopped).toBe("cancelled");
    expect(result.results.some((row) => row.runStatus === "cancelled")).toBe(true);
  });

  it("deadline stops admission and records partial results", async () => {
    const connector = new FakeHostConnector({
      "cand-a": { delayMs: 80 },
      "cand-b": { delayMs: 80 },
      "cand-c": { delayMs: 80 },
    });
    const runner = new ComparisonJobRunner(new MemoryJobStore(), connector, "worker-a", 200);
    const result = await runner.run({
      snapshotFingerprint: SNAP,
      taskFingerprint: TASK,
      lanes: lanes(),
      deadlineMs: 25,
      maxConcurrency: 2,
    });
    expect(result.stopped).toBe("deadline");
    expect(result.results.length).toBe(3);
  });

  it("concurrency 1 stays sequential", async () => {
    const connector = new FakeHostConnector({
      "cand-a": { delayMs: 20 },
      "cand-b": { delayMs: 20 },
      "cand-c": { delayMs: 20 },
    });
    const runner = new ComparisonJobRunner(new MemoryJobStore(), connector, "worker-a");
    const result = await runner.run({
      snapshotFingerprint: SNAP,
      taskFingerprint: TASK,
      lanes: lanes(),
      deadlineMs: 5_000,
      maxConcurrency: 1,
    });
    expect(connector.maxActive).toBe(1);
    expect(result.results.map((row) => row.candidateId)).toEqual(["cand-a", "cand-b", "cand-c"]);
  });
});

describe.skipIf(!sqliteAvailable())("sqlite job store", () => {
  it("persists leases across a new store handle on the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-sqlite-jobs-"));
    const path = join(dir, "jobs.sqlite");
    try {
      const first = new SqliteJobStore(path);
      const payload = { candidateId: "cand-sqlite" };
      const inserted = await first.insert({
        id: newJobId(),
        kind: "host_triage_lane",
        leaseOwner: null,
        leaseUntil: null,
        payloadHash: payloadHash(payload),
        payload,
        result: null,
        cancelRequested: false,
      });
      await first.acquire("worker-a", 10);
      first.close();

      const second = new SqliteJobStore(path);
      const recovered = await second.stealStale("worker-b", 1_000, new Date(Date.now() + 50));
      expect(recovered?.id).toBe(inserted.id);
      expect(recovered?.leaseOwner).toBe("worker-b");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!adminUrl())("postgres job store", () => {
  it("acquires a lease through collab_jobs after migration", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgJobStore(client);
      const payload = { candidateId: "cand-pg" };
      await store.insert({
        id: newJobId(),
        kind: "host_triage_lane",
        leaseOwner: null,
        leaseUntil: null,
        payloadHash: payloadHash(payload),
        payload,
        result: null,
        cancelRequested: false,
      });
      const leased = await store.acquire("worker-pg", 1_000);
      expect(leased?.leaseOwner).toBe("worker-pg");
      const done = await store.complete(leased!.id, "worker-pg", { note: "ok" });
      expect(done.status).toBe("completed");
    });
  });
});
