import { createHash } from "node:crypto";
import {
  triageJobRequestFingerprint,
  type TriageJobRequestV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import {
  MemoryTriageJobStore,
  PgTriageJobStore,
  TriageJobIdempotencyConflictError,
  type Queryable,
} from "./store.js";

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SNAPSHOT_A = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_A2 = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_B = "33333333-3333-4333-8333-333333333333";
const JOB_A = "44444444-4444-4444-8444-444444444444";
const JOB_A2 = "55555555-5555-4555-8555-555555555555";
const JOB_B = "66666666-6666-4666-8666-666666666666";
const CREATED_AT = "2026-08-20T00:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jobRequest(snapshotId: string): TriageJobRequestV1 {
  return {
    schemaId: "cd-collab.triage_job_request.v1",
    snapshotId,
    mode: "deterministic_mock",
    strategyId: "contextdesk.standard",
    question: "What changed?",
    policyFingerprint: null,
    taskFingerprint: "task-fixture",
    candidates: [{
      candidateId: "candidate-a",
      role: "reviewer",
      provider: "synthetic",
      profileId: null,
      model: "qwen-3.6-27b",
      version: null,
    }],
  };
}

function job(overrides: {
  id?: string;
  caseId?: string;
  snapshotId?: string;
  snapshotFingerprint?: string;
  parentJobId?: string;
} = {}): TriageJobV1 {
  const id = overrides.id ?? JOB_A;
  const caseId = overrides.caseId ?? CASE_A;
  const snapshotId = overrides.snapshotId ?? SNAPSHOT_A;
  const snapshotFingerprint = overrides.snapshotFingerprint ?? "a".repeat(64);
  const request = jobRequest(snapshotId);
  return {
    schemaId: "cd-collab.triage_job.v1",
    id,
    caseId,
    snapshotId,
    snapshotFingerprint,
    requestFingerprint: triageJobRequestFingerprint(snapshotFingerprint, request),
    cancellationId: `cancel-${id}`,
    ...(overrides.parentJobId ? { parentJobId: overrides.parentJobId } : {}),
    request,
    status: "queued",
    candidates: request.candidates.map((candidate) => ({
      ...candidate,
      status: "queued",
      benchmarkRunId: null,
      outputHash: null,
      summary: null,
      evidenceRefs: [],
      unknowns: [],
      usageStatus: "unknown",
      costStatus: "unknown",
      errorCode: null,
      startedAt: null,
      finishedAt: null,
      privacyClass: "owner_only",
    })),
    sameSnapshot: null,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "lead-a",
    requestedByUsername: "lead-a",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    stoppedReason: null,
  };
}

describe("triage job stores", () => {
  it("atomically creates or returns in memory and separates scope from binding", async () => {
    const store = new MemoryTriageJobStore();
    const admission = { scopeDigest: digest("actor-a:case-a:key"), bindingDigest: digest("binding-a") };
    const candidate = job();
    const [first, second] = await Promise.all([
      store.createOrReturn(candidate, admission),
      store.createOrReturn({ ...candidate, id: JOB_A2, cancellationId: `cancel-${JOB_A2}` }, admission),
    ]);
    expect(new Set([first.job.id, second.job.id])).toEqual(new Set([first.job.id]));
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await store.listByCase(CASE_A)).toHaveLength(1);
    await expect(
      store.createOrReturn(
        job({ id: JOB_A2, snapshotId: SNAPSHOT_A2, snapshotFingerprint: "b".repeat(64) }),
        { ...admission, bindingDigest: digest("changed-binding") },
      ),
    ).rejects.toBeInstanceOf(TriageJobIdempotencyConflictError);
    const separate = await store.createOrReturn(
      job({ id: JOB_B }),
      { scopeDigest: digest("actor-b:case-a:key"), bindingDigest: digest("binding-a") },
    );
    expect(separate.created).toBe(true);
    expect(await store.listByCase(CASE_A)).toHaveLength(2);
  });

  it("rejects malformed persisted jobs when memory state is loaded", async () => {
    const store = new MemoryTriageJobStore();
    const valid = job();
    await store.insert(valid);
    const rows = (store as unknown as { jobs: Map<string, TriageJobV1> }).jobs;
    rows.set(valid.id, { ...valid, snapshotId: SNAPSHOT_A2 });
    await expect(store.get(valid.id)).rejects.toThrow(/snapshotId/);
    rows.set(valid.id, { ...valid, requestFingerprint: "b".repeat(64) });
    await expect(store.get(valid.id)).rejects.toThrow(/canonical/);
    rows.set(valid.id, { ...valid, parentJobId: "" });
    await expect(store.get(valid.id)).rejects.toThrow(/must not be empty/);
    rows.set(valid.id, { ...valid, parentJobId: valid.id });
    await expect(store.get(valid.id)).rejects.toThrow(/must not reference/);
  });

  it("rejects PostgreSQL payload/column disagreement", async () => {
    const valid = job();
    const row = {
      id: valid.id,
      case_id: valid.caseId,
      snapshot_id: valid.snapshotId,
      snapshot_fingerprint: valid.snapshotFingerprint,
      request_fingerprint: valid.requestFingerprint,
      status: "failed",
      payload: valid,
      lease_owner: null,
      lease_expires_at: null,
      parent_job_id: null,
      idempotency_scope_digest: null,
      idempotency_binding_digest: null,
    };
    const db: Queryable = {
      query: async () => ({ rows: [row], rowCount: 1 } as never),
    };
    await expect(new PgTriageJobStore(db).get(valid.id)).rejects.toThrow(
      /payload does not match authoritative columns/,
    );
  });
});

describe.skipIf(!adminUrl())("PostgreSQL triage job integrity", () => {
  it("enforces atomic idempotency and same-case parent lineage", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      await client.query(
        `INSERT INTO cases (id, title, severity, status, created_by, created_by_username)
         VALUES ($1, 'case-a', 'low', 'open', 'lead-a', 'lead-a'),
                ($2, 'case-b', 'low', 'open', 'lead-b', 'lead-b')`,
        [CASE_A, CASE_B],
      );
      await client.query(
        `INSERT INTO snapshots (
           id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
           protocol_version, fairness_class, status, created_at, created_by
         ) VALUES
           ($1, $2, $3, NULL, '[]'::jsonb, 'owner_only', 'v1', 'same_snapshot', 'frozen', $7, 'lead-a'),
           ($4, $2, $5, $1, '[]'::jsonb, 'owner_only', 'v1', 'same_snapshot', 'frozen', $7, 'lead-a'),
           ($6, $8, $9, NULL, '[]'::jsonb, 'owner_only', 'v1', 'same_snapshot', 'frozen', $7, 'lead-b')`,
        [
          SNAPSHOT_A,
          CASE_A,
          "a".repeat(64),
          SNAPSHOT_A2,
          "b".repeat(64),
          SNAPSHOT_B,
          CREATED_AT,
          CASE_B,
          "c".repeat(64),
        ],
      );
      const store = new PgTriageJobStore(client);
      await store.insert(job());
      const child = job({
        id: JOB_A2,
        snapshotId: SNAPSHOT_A2,
        snapshotFingerprint: "b".repeat(64),
        parentJobId: JOB_A,
      });
      const admission = {
        scopeDigest: digest("lead-a:case-a:private-key"),
        bindingDigest: digest("lead-a:case-a:parent:target:mode"),
      };
      const [first, retry] = await Promise.all([
        store.createOrReturn(child, admission),
        store.createOrReturn(
          { ...child, id: JOB_B, cancellationId: `cancel-${JOB_B}` },
          admission,
        ),
      ]);
      expect(first.job.id).toBe(retry.job.id);
      expect([first.created, retry.created].sort()).toEqual([false, true]);
      await expect(
        store.createOrReturn(
          { ...child, id: JOB_B, cancellationId: `cancel-${JOB_B}` },
          { ...admission, bindingDigest: digest("changed") },
        ),
      ).rejects.toBeInstanceOf(TriageJobIdempotencyConflictError);

      const crossCase = job({
        id: JOB_B,
        caseId: CASE_B,
        snapshotId: SNAPSHOT_B,
        snapshotFingerprint: "c".repeat(64),
        parentJobId: JOB_A,
      });
      await expect(store.insert(crossCase)).rejects.toThrow();
      const persisted = await client.query<{
        idempotency_scope_digest: string;
        idempotency_binding_digest: string;
        parent_job_id: string;
      }>(
        `SELECT idempotency_scope_digest, idempotency_binding_digest, parent_job_id
         FROM triage_jobs WHERE id = $1`,
        [first.job.id],
      );
      expect(persisted.rows[0]).toEqual({
        idempotency_scope_digest: admission.scopeDigest,
        idempotency_binding_digest: admission.bindingDigest,
        parent_job_id: JOB_A,
      });
      expect(JSON.stringify(persisted.rows[0])).not.toContain("private-key");
    });
  });
});
