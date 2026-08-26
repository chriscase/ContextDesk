import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIAGE_PROGRESS_EVENTS_PER_LANE, triageProgressEventBudget } from "@cd-collab/contracts";
import type { TriageBatchExecutionContext } from "./service.js";
import { RustBridgeTriageExecutor } from "./runner.js";

const PREFIX = "contextdesk.collab_triage_progress ";
const JOB = "job-progress-budget";
const CASE = "case-progress-budget";
const SNAPSHOT = "snapshot-progress-budget";
const FINGERPRINT = "f".repeat(64);

function contextFor(laneCount: number): TriageBatchExecutionContext {
  return {
    jobId: JOB,
    requestedBy: "lead",
    createdAt: "2026-08-20T00:00:00.000Z",
    case: {
      schemaId: "cd-collab.case.v1",
      id: CASE,
      title: "Progress budget",
      status: "open",
      createdAt: "2026-08-20T00:00:00.000Z",
      createdBy: "lead",
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
    snapshot: {
      schemaId: "cd-collab.snapshot.v1",
      id: SNAPSHOT,
      caseId: CASE,
      fingerprint: FINGERPRINT,
      parentSnapshotId: null,
      evidence: [],
      visibility: "share_safe",
      protocolVersion: "snapshot-v1",
      fairnessClass: "same_snapshot",
      status: "frozen",
      createdAt: "2026-08-20T00:00:00.000Z",
      createdBy: "lead",
    },
    request: {
      schemaId: "cd-collab.triage_job_request.v1",
      snapshotId: SNAPSHOT,
      mode: "gateway",
      strategyId: "contextdesk.standard",
      question: "What should we inspect next?",
      policyFingerprint: null,
      taskFingerprint: "task-progress-budget",
      candidates: Array.from({ length: laneCount }, (_, index) => ({
        candidateId: `candidate-${index}`,
        role: `reviewer-${index}`,
        provider: "openai-compatible",
        profileId: "profile:test",
        model: `synthetic-model-${index}`,
        version: null,
      })),
    },
    evidence: [],
  };
}

/** A provider-free stand-in for the host bridge that speaks the lane protocol. */
async function fakeBridge(
  root: string,
  laneCount: number,
  options: { extraProgressEvents?: number } = {},
): Promise<string> {
  const command = join(root, "bridge.mjs");
  const lines: string[] = [];
  for (let index = 0; index < laneCount; index += 1) {
    lines.push(`${PREFIX}${JSON.stringify({
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_started",
      job_id: JOB,
      case_id: CASE,
      collab_snapshot_id: SNAPSHOT,
      collab_snapshot_fingerprint: FINGERPRINT,
      candidate_id: `candidate-${index}`,
    })}`);
  }
  for (let index = 0; index < laneCount; index += 1) {
    lines.push(`${PREFIX}${JSON.stringify({
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_persisted",
      job_id: JOB,
      case_id: CASE,
      collab_snapshot_id: SNAPSHOT,
      collab_snapshot_fingerprint: FINGERPRINT,
      candidate: {
        candidate_id: `candidate-${index}`,
        status: "completed",
        run_id: `run-${index}`,
        output_hash: `out-${index}`,
        summary: `lane ${index} settled`,
        evidence_refs: [],
      },
    })}`);
  }
  // A misbehaving bridge that keeps talking past its own lane set.
  for (let extra = 0; extra < (options.extraProgressEvents ?? 0); extra += 1) {
    lines.push(`${PREFIX}${JSON.stringify({
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_started",
      job_id: JOB,
      case_id: CASE,
      collab_snapshot_id: SNAPSHOT,
      collab_snapshot_fingerprint: FINGERPRINT,
      candidate_id: `candidate-${extra}`,
    })}`);
  }
  const output = JSON.stringify({
    ok: true,
    data: {
      schema_id: "cd-collab.triage_run_result.v1",
      action: "collab_triage_run",
      job_id: JOB,
      case_id: CASE,
      collab_snapshot_id: SNAPSHOT,
      collab_snapshot_fingerprint: FINGERPRINT,
      same_snapshot: true,
      candidates: Array.from({ length: laneCount }, (_, index) => ({
        candidate_id: `candidate-${index}`,
        status: "completed",
        run_id: `run-${index}`,
        output_hash: `out-${index}`,
        summary: `lane ${index} settled`,
        evidence_refs: [],
      })),
    },
  });
  await writeFile(
    command,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(`${lines.join("\n")}\n`)});\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o755 },
  );
  return command;
}

async function runLanes(laneCount: number, options: { extraProgressEvents?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-progress-budget-"));
  try {
    const command = await fakeBridge(root, laneCount, options);
    const admissions: string[] = [];
    const settlements: string[] = [];
    const executor = new RustBridgeTriageExecutor({
      command: process.execPath,
      prefixArgs: [command],
    });
    const results = await executor.executeBatch({
      ...contextFor(laneCount),
      onCandidateStarted: (candidateId) => { admissions.push(candidateId); },
      onCandidate: (result) => { settlements.push(result.candidateId); },
    }, new AbortController().signal);
    return { admissions, settlements, results };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("the runner's progress budget follows the lane count", () => {
  // The regression: a fixed ceiling of sixteen progress events sat beside an
  // advertised ceiling of sixteen lanes. Because a lane emits an admission and
  // a settlement, every run of nine lanes or more overran the event ceiling
  // and was killed after it had already been accepted.
  for (const lanes of [1, 8, 9, 16]) {
    it(`carries all ${lanes * TRIAGE_PROGRESS_EVENTS_PER_LANE} events of a ${lanes}-lane run`, async () => {
      const { admissions, settlements, results } = await runLanes(lanes);
      expect(admissions).toHaveLength(lanes);
      expect(settlements).toHaveLength(lanes);
      expect(admissions.length + settlements.length).toBe(triageProgressEventBudget(lanes));
      expect(results).toHaveLength(lanes);
      expect(results.every((result) => result.status === "completed")).toBe(true);
    });
  }

  it("still interrupts a bridge that talks past its own lane set", async () => {
    // The bound is not removed, only tied to the run: a bridge emitting more
    // events than its lanes can account for is still stopped.
    await expect(runLanes(2, { extraProgressEvents: 2 })).rejects.toThrow(
      /too many progress events|duplicate lane admission/,
    );
  });
});
