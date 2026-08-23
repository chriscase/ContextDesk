import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { triageJobRequestFingerprint, type TriageJobV1 } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { createSqliteRuntime } from "./sqlite.js";

describe("SQLite local runtime", () => {
  it("persists the collaboration stores across a process reopen", async () => {
    const root = await mkdtemp(join("/tmp", "cd-collab-sqlite-"));
    const path = join(root, "collab.sqlite");
    const actor = { id: "local:lead", username: "lead" };
    try {
      const first = createSqliteRuntime(path);
      const evidence = new FilesystemEvidenceStore({ rootDir: join(root, "evidence") });
      const catalog = new CatalogService(first.catalog, first.audit);
      const cases = new CaseService(evidence, first.audit, first.cases, catalog);
      const created = await cases.createCase(actor, { title: "SQLite persistence" }, "test");
      const snapshot = await cases.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [], visibility: "owner_only" },
        "test",
      );
      const request = {
        schemaId: "cd-collab.triage_job_request.v1" as const,
        snapshotId: snapshot.id,
        mode: "deterministic_mock" as const,
        strategyId: "contextdesk.standard",
        question: "What changed?",
        policyFingerprint: null,
        taskFingerprint: "sqlite-task",
        candidates: [{
          candidateId: "sqlite-candidate",
          role: "reviewer",
          provider: "synthetic",
          profileId: null,
          model: "qwen-3.6-27b",
          version: null,
        }],
      };
      const makeJob = (id: string): TriageJobV1 => ({
        schemaId: "cd-collab.triage_job.v1",
        id,
        caseId: created.id,
        snapshotId: snapshot.id,
        snapshotFingerprint: snapshot.fingerprint,
        requestFingerprint: triageJobRequestFingerprint(snapshot.fingerprint, request),
        cancellationId: randomUUID(),
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
        requestedBy: actor.id,
        requestedByUsername: actor.username,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        stoppedReason: null,
      });
      const rawKey = "sqlite-private-idempotency-key";
      const admission = {
        scopeDigest: createHash("sha256").update(`actor:case:${rawKey}`).digest("hex"),
        bindingDigest: createHash("sha256").update("actor:case:parent:target:mode").digest("hex"),
      };
      const firstAdmission = await first.jobs.createOrReturn(makeJob(randomUUID()), admission);
      expect(firstAdmission.created).toBe(true);
      const session = await first.sessions.create({
        identity: { id: actor.id, username: actor.username, displayName: "Case Lead" },
        groups: ["local:case-lead"],
        ttlMs: 60_000,
      });
      await first.roleStore.set("local:case-lead", "case-lead", actor.id);
      await first.audit.append({
        identity: actor.id,
        action: "sqlite_test",
        target: created.id,
        origin: "test",
        outcome: "success",
      });
      first.state.ping();
      first.state.close();

      const second = createSqliteRuntime(path);
      const reopened = await second.cases.getCase(created.id);
      expect(reopened?.title).toBe("SQLite persistence");
      expect((await second.sessions.getByToken(session.token))?.identity.username).toBe("lead");
      expect(await second.roleStore.load()).toEqual({
        entries: new Map([["local:case-lead", "case-lead"]]),
      });
      expect((await second.audit.list({ action: "sqlite_test" }))).toHaveLength(1);
      const reopenedAdmission = await second.jobs.createOrReturn(makeJob(randomUUID()), admission);
      expect(reopenedAdmission.created).toBe(false);
      expect(reopenedAdmission.job.id).toBe(firstAdmission.job.id);
      expect(await second.jobs.listByCase(created.id)).toHaveLength(1);
      const persistedJobs = second.state.db.prepare(
        "SELECT payload FROM collab_state WHERE key = 'jobs'",
      ).get() as { payload: string };
      expect(persistedJobs.payload).not.toContain(rawKey);
      second.state.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
