import { randomUUID } from "node:crypto";
import {
  OVERVIEW_ACTIVITY_CAP,
  OVERVIEW_ATTENTION_CAP,
  OVERVIEW_PRESENCE_CAP,
  OVERVIEW_RUNNING_JOB_CAP,
  parseExperimentDecision,
  type TriageJobStatus,
  type TriageJobV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { MemoryExperimentStore, PgExperimentStore, type ExperimentRow } from "../experiments/index.js";
import { MemoryPresenceBackend, PgPresenceBackend } from "../presence/index.js";
import { MemoryTriageJobStore, PgTriageJobStore } from "../triage-runs/index.js";

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const aliceScope = { actorId: "alice", isAdmin: false };
const visibleTitle = async (caseId: string) => (caseId === CASE_A ? "Visible" : null);

function job(input: {
  id: string;
  caseId: string;
  status: TriageJobStatus;
  updatedAt: string;
}): TriageJobV1 {
  return {
    schemaId: "cd-collab.triage_job.v1",
    id: input.id,
    caseId: input.caseId,
    snapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    snapshotFingerprint: "snap-fingerprint",
    requestFingerprint: "request-fingerprint",
    cancellationId: "cancel-1",
    request: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      mode: "deterministic_mock",
      strategyId: "contextdesk.standard",
      question: "PLANTED_QUESTION_TEXT",
      policyFingerprint: null,
      taskFingerprint: "task-fingerprint",
      candidates: [
        {
          candidateId: "cand-1",
          role: "single",
          provider: "synthetic",
          profileId: null,
          model: "synthetic-model",
          version: null,
        },
      ],
    },
    status: input.status,
    candidates: [
      {
        candidateId: "cand-1",
        role: "single",
        provider: "synthetic",
        profileId: null,
        model: "synthetic-model",
        version: null,
        status: input.status,
        benchmarkRunId: null,
        outputHash: null,
        summary: "PLANTED_MODEL_OUTPUT",
        evidenceRefs: ["ev-planted"],
        unknowns: ["usage", "cost"],
        usageStatus: "unknown",
        costStatus: "unknown",
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        privacyClass: "share_safe",
      },
    ],
    sameSnapshot: null,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "uid=alice",
    requestedByUsername: "alice",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    stoppedReason: null,
  };
}

function experiment(id: string, caseId: string, packageId: string): ExperimentRow {
  return {
    id,
    caseId,
    packageId,
    sourceSchemaId: "cd-collab.experiment_package.v1",
    taskFingerprint: `task-${"a".repeat(64)}`,
    snapshotFingerprint: `snap-${"b".repeat(64)}`,
    snapshotProof: {
      basis: "unknown",
      fairnessClass: "unknown",
      lineageClass: "unknown",
    },
    candidates: [],
    agreement: {
      sharedAnchors: [],
      candidateSpecific: [],
      roleConflicts: [],
      notes: ["Agreement is not proof of correctness."],
    },
    createdAt: "2026-08-24T00:00:00.000Z",
    importerId: "uid=alice",
    importerUsername: "alice",
  };
}

describe("overview store helpers stay bounded in memory", () => {
  it("caps jobs, activity, presence, and proposed decisions without a hidden case", async () => {
    const jobs = new MemoryTriageJobStore();
    const experiments = new MemoryExperimentStore();
    const presence = new MemoryPresenceBackend();
    const cases = new MemoryCaseStore();
    await cases.insertCase({
      id: CASE_A,
      title: "Visible",
      severity: "medium",
      status: "open",
      legalHold: false,
      retentionClass: "standard",
      createdAt: "2026-08-24T00:00:00.000Z",
      createdBy: "alice",
      createdByUsername: "alice",
      participants: [{ identityId: "alice", username: "alice" }],
    });
    await cases.insertCase({
      id: CASE_B,
      title: "Hidden",
      severity: "high",
      status: "open",
      legalHold: false,
      retentionClass: "standard",
      createdAt: "2026-08-24T00:00:00.000Z",
      createdBy: "eve",
      createdByUsername: "eve",
      participants: [{ identityId: "eve", username: "eve" }],
    });

    const counts = await cases.overviewCounts(aliceScope);
    expect(counts.status.open).toBe(1);
    expect(counts.severity.medium).toBe(1);
    expect(counts.severity.high).toBe(0);
    const open = await cases.listOverviewOpenCases(aliceScope, 12);
    expect(open.map((row) => row.title)).toEqual(["Visible"]);

    for (let index = 0; index < OVERVIEW_RUNNING_JOB_CAP + 5; index += 1) {
      await jobs.insert(
        job({
          id: randomUUID(),
          caseId: CASE_A,
          status: "queued",
          updatedAt: `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await jobs.insert(
      job({
        id: randomUUID(),
        caseId: CASE_B,
        status: "queued",
        updatedAt: "2026-08-24T00:01:00.000Z",
      }),
    );
    const boundedJobs = await jobs.listOverviewJobs({
      ...aliceScope,
      statuses: ["queued", "running"],
      limit: OVERVIEW_RUNNING_JOB_CAP,
      visibleCaseTitle: visibleTitle,
    });
    expect(boundedJobs).toHaveLength(OVERVIEW_RUNNING_JOB_CAP);
    expect(boundedJobs.every((row) => row.job.caseId === CASE_A)).toBe(true);

    for (let index = 0; index < OVERVIEW_ATTENTION_CAP + 5; index += 1) {
      const experimentId = randomUUID();
      await experiments.insert(experiment(experimentId, CASE_A, `pkg-${index}`));
      await experiments.insertDecision(
        parseExperimentDecision({
          schemaId: "cd-collab.experiment_decision.v1",
          id: randomUUID(),
          experimentId,
          status: "proposed",
          revision: 1,
          predecessorRevision: null,
          text: "PLANTED_DECISION_TEXT",
          rationale: "PLANTED_DECISION_RATIONALE",
          evidenceRefs: ["ev-planted"],
          packageId: `pkg-${index}`,
          authorId: "alice",
          authorUsername: "alice",
          createdAt: `2026-08-24T00:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const hiddenExperiment = randomUUID();
    await experiments.insert(experiment(hiddenExperiment, CASE_B, "pkg-hidden"));
    await experiments.insertDecision(
      parseExperimentDecision({
        schemaId: "cd-collab.experiment_decision.v1",
        id: randomUUID(),
        experimentId: hiddenExperiment,
        status: "proposed",
        revision: 1,
        predecessorRevision: null,
        text: "hidden",
        rationale: "hidden",
        evidenceRefs: [],
        packageId: "pkg-hidden",
        authorId: "eve",
        authorUsername: "eve",
        createdAt: "2026-08-24T00:02:00.000Z",
      }),
    );
    const proposed = await experiments.listOverviewProposed({
      ...aliceScope,
      limit: OVERVIEW_ATTENTION_CAP,
      visibleCaseTitle: visibleTitle,
    });
    expect(proposed).toHaveLength(OVERVIEW_ATTENTION_CAP);
    expect(proposed.every((row) => row.caseId === CASE_A)).toBe(true);

    for (let index = 0; index < OVERVIEW_PRESENCE_CAP + 4; index += 1) {
      await presence.touch(CASE_A, { id: `alice-${index}`, username: `alice-${index}` }, "case_board");
    }
    await presence.touch(CASE_B, { id: "eve", username: "eve" }, "experiment_lab");
    const visiblePresence = await presence.listOverviewPresence({
      ...aliceScope,
      limit: OVERVIEW_PRESENCE_CAP,
      visibleCaseTitle: visibleTitle,
    });
    expect(visiblePresence).toHaveLength(OVERVIEW_PRESENCE_CAP);
    expect(visiblePresence.every((row) => row.caseId === CASE_A)).toBe(true);

    for (let index = 0; index < OVERVIEW_ACTIVITY_CAP + 5; index += 1) {
      await cases.appendTimeline(CASE_A, {
        kind: "case_note",
        actor: { id: "alice", username: "alice" },
        targetId: CASE_A,
        clientTime: null,
        payload: { body: "PLANTED_TIMELINE_PAYLOAD" },
      });
    }
    await cases.appendTimeline(CASE_B, {
      kind: "case_note",
      actor: { id: "eve", username: "eve" },
      targetId: CASE_B,
      clientTime: null,
      payload: { body: "hidden timeline body" },
    });
    const recent = await cases.listOverviewActivity(aliceScope, OVERVIEW_ACTIVITY_CAP);
    expect(recent).toHaveLength(OVERVIEW_ACTIVITY_CAP);
    expect(recent.every((row) => row.caseId === CASE_A)).toBe(true);
    expect(recent.every((row) => !("payload" in row))).toBe(true);
  });
});

describe("overview PostgreSQL helpers emit bounded SQL", () => {
  it("joins visibility with LIMIT and never fans in an unbounded case-id array", async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [] };
      },
    };
    const ignoredTitle = async () => null;
    await new PgCaseStore(db as never).overviewCounts(aliceScope);
    await new PgCaseStore(db as never).listOverviewOpenCases(aliceScope, 12);
    await new PgCaseStore(db as never).listOverviewActivity(aliceScope, 20);
    await new PgTriageJobStore(db as never).listOverviewJobs({
      ...aliceScope,
      statuses: ["queued", "running"],
      limit: 20,
      visibleCaseTitle: ignoredTitle,
    });
    await new PgExperimentStore(db as never).listOverviewProposed({
      ...aliceScope,
      limit: 20,
      authorId: "alice",
      visibleCaseTitle: ignoredTitle,
    });
    await new PgPresenceBackend(db as never).listOverviewPresence({
      ...aliceScope,
      limit: 20,
      visibleCaseTitle: ignoredTitle,
    });
    expect(statements).toHaveLength(6);
    for (const sql of statements) {
      expect(sql).toMatch(/case_participants/);
      expect(sql).not.toMatch(/ANY\(\$\d+::uuid\[\]\)/);
    }
    expect(statements[1]).toMatch(/LIMIT \$4/);
    expect(statements[2]).toMatch(/LIMIT \$3/);
    expect(statements[3]).toMatch(/LIMIT \$4/);
    expect(statements[4]).toMatch(/LIMIT \$5/);
    expect(statements[5]).toMatch(/LIMIT \$3/);
    expect(statements[5]).toMatch(/FROM case_presence cp/);
    expect(statements[5]).toMatch(/p\.case_id = cp\.case_id/);
    expect(statements[5]).toMatch(/ORDER BY cp\.last_seen_at DESC/);
    expect(statements[5]).not.toMatch(/DELETE FROM case_presence/);
  });
});

describe.skipIf(!adminUrl())("overview PostgreSQL helpers on a disposable database", () => {
  it("returns only requested-case presence and proposed decisions with a LIMIT", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      await client.query(
        `INSERT INTO cases (
           id, title, severity, status, legal_hold, retention_class,
           created_at, created_by, created_by_username
         ) VALUES
         ($1, 'Visible', 'medium', 'open', false, 'standard', now(), 'alice', 'alice'),
         ($2, 'Hidden', 'high', 'open', false, 'standard', now(), 'eve', 'eve')`,
        [CASE_A, CASE_B],
      );
      await client.query(
        `INSERT INTO case_participants (case_id, identity_id, username, added_by)
         VALUES ($1, 'alice', 'alice', 'alice'), ($2, 'eve', 'eve', 'eve')`,
        [CASE_A, CASE_B],
      );
      const cases = new PgCaseStore(client);
      const counts = await cases.overviewCounts(aliceScope);
      expect(counts.status.open).toBe(1);
      expect((await cases.listOverviewOpenCases(aliceScope, 12)).map((row) => row.id)).toEqual([
        CASE_A,
      ]);

      const presence = new PgPresenceBackend(client);
      await presence.touch(CASE_A, { id: "alice", username: "alice" }, "case_board");
      await presence.touch(CASE_B, { id: "eve", username: "eve" }, "experiment_lab");
      const visible = await presence.listOverviewPresence({
        ...aliceScope,
        limit: OVERVIEW_PRESENCE_CAP,
        visibleCaseTitle: visibleTitle,
      });
      expect(visible.map((row) => row.username)).toEqual(["alice"]);

      const experiments = new PgExperimentStore(client);
      const visibleExperiment = randomUUID();
      const hiddenExperiment = randomUUID();
      await experiments.insert(experiment(visibleExperiment, CASE_A, "pkg-visible"));
      await experiments.insert(experiment(hiddenExperiment, CASE_B, "pkg-hidden"));
      await experiments.insertDecision(
        parseExperimentDecision({
          schemaId: "cd-collab.experiment_decision.v1",
          id: randomUUID(),
          experimentId: visibleExperiment,
          status: "proposed",
          revision: 1,
          predecessorRevision: null,
          text: "visible proposal",
          rationale: "synthetic",
          evidenceRefs: [],
          packageId: "pkg-visible",
          authorId: "alice",
          authorUsername: "alice",
          createdAt: "2026-08-24T00:00:00.000Z",
        }),
      );
      await experiments.insertDecision(
        parseExperimentDecision({
          schemaId: "cd-collab.experiment_decision.v1",
          id: randomUUID(),
          experimentId: hiddenExperiment,
          status: "proposed",
          revision: 1,
          predecessorRevision: null,
          text: "hidden proposal",
          rationale: "synthetic",
          evidenceRefs: [],
          packageId: "pkg-hidden",
          authorId: "eve",
          authorUsername: "eve",
          createdAt: "2026-08-24T00:00:01.000Z",
        }),
      );
      const proposed = await experiments.listOverviewProposed({
        ...aliceScope,
        limit: OVERVIEW_ATTENTION_CAP,
        visibleCaseTitle: visibleTitle,
      });
      expect(proposed).toHaveLength(1);
      expect(proposed[0]?.caseId).toBe(CASE_A);
    });
  });
});
