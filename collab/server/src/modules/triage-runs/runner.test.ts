import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TriageBatchExecutionContext } from "./service.js";
import { RustBridgeTriageExecutor } from "./runner.js";

const context: TriageBatchExecutionContext = {
  jobId: "job-runner-test",
  requestedBy: "lead",
  createdAt: "2026-08-20T00:00:00.000Z",
  case: {
    schemaId: "cd-collab.case.v1",
    id: "case-runner-test",
    title: "Gateway runner test",
    status: "open",
    createdAt: "2026-08-20T00:00:00.000Z",
    createdBy: "lead",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  snapshot: {
    schemaId: "cd-collab.snapshot.v1",
    id: "snapshot-runner-test",
    caseId: "case-runner-test",
    fingerprint: "f".repeat(64),
    parentSnapshotId: null,
    evidence: [{
      evidenceId: "evidence-runner-test",
      ordinal: 0,
      contentHash: "h".repeat(64),
      expectedHash: null,
      verificationStatus: "verified",
      privacyClass: "owner_only",
    }],
    visibility: "owner_only",
    protocolVersion: "snapshot-v1",
    fairnessClass: "same_snapshot",
    status: "frozen",
    createdAt: "2026-08-20T00:00:00.000Z",
    createdBy: "lead",
  },
  request: {
    schemaId: "cd-collab.triage_job_request.v1",
    snapshotId: "snapshot-runner-test",
    mode: "gateway",
    strategyId: "contextdesk.standard",
    question: "What should we inspect next?",
    policyFingerprint: null,
    taskFingerprint: "task-runner-test",
    candidates: [
      {
        candidateId: "candidate-a",
        role: "reviewer",
        provider: "openai-compatible",
        profileId: "profile:test",
        model: "qwen-3.6-27b",
        version: null,
      },
      {
        candidateId: "candidate-b",
        role: "challenger",
        provider: "openai-compatible",
        profileId: "profile:test",
        model: "gpt-oss-120b",
        version: null,
      },
    ],
  },
  evidence: [{
    evidenceId: "evidence-runner-test",
    ordinal: 0,
    contentHash: "h".repeat(64),
    mediaType: "text/plain",
    privacyClass: "owner_only",
    byteLength: 5,
    contentBase64: Buffer.from("hello", "utf8").toString("base64"),
  }],
};

describe("RustBridgeTriageExecutor", () => {
  it("uses the private host command and matches results by candidate id", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-runner-test-"));
    const command = join(root, "runner.mjs");
    const output = JSON.stringify({
      ok: true,
      data: {
        schema_id: "cd-collab.triage_run_result.v1",
        action: "collab_triage_run",
        job_id: "job-runner-test",
        case_id: "case-runner-test",
        collab_snapshot_id: "snapshot-runner-test",
        collab_snapshot_fingerprint: "f".repeat(64),
        same_snapshot: true,
        candidates: [
          {
            candidate_id: "candidate-b",
            status: "completed",
            run_id: "run-b",
            output_hash: "out-b",
            summary: "B result",
            evidence_refs: ["evidence-runner-test"],
          },
          {
            candidate_id: "candidate-a",
            status: "completed",
            run_id: "run-a",
            output_hash: "out-a",
            summary: "A result",
            evidence_refs: ["evidence-runner-test"],
          },
        ],
      },
    });
    await writeFile(
      command,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const commandIndex = args.indexOf("collab-triage-run");
if (args.indexOf("--json") < 0 || commandIndex < 0 || args.indexOf("--progress-events") < commandIndex) process.exit(13);
process.stdout.write(${JSON.stringify(output)});
`,
      { mode: 0o755 },
    );
    try {
      const executor = new RustBridgeTriageExecutor({ command });
      const results = await executor.executeBatch(context, new AbortController().signal);
      expect(results.map((result) => result.benchmarkRunId)).toEqual(["run-a", "run-b"]);
      expect(results.map((result) => result.summary)).toEqual([
        "A result",
        "B result",
      ]);
      expect(results.every((result) => result.usageStatus === "unknown" && result.costStatus === "unknown")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("force-kills a host that ignores cancellation after the timeout bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-runner-timeout-test-"));
    const command = join(root, "hung-runner.mjs");
    await writeFile(
      command,
      "#!/usr/bin/env node\nprocess.on('SIGINT', () => {}); setInterval(() => {}, 1000);\n",
      { mode: 0o755 },
    );
    try {
      const executor = new RustBridgeTriageExecutor({ command, timeoutMs: 25 });
      await expect(executor.executeBatch(context, new AbortController().signal)).rejects.toThrow(
        "deadline exceeded",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers bounded persisted-lane progress without changing the final envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-runner-progress-test-"));
    const command = join(root, "progress-runner.mjs");
    const started = {
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_started",
      job_id: "job-runner-test",
      case_id: "case-runner-test",
      collab_snapshot_id: "snapshot-runner-test",
      collab_snapshot_fingerprint: "f".repeat(64),
      candidate_id: "candidate-a",
    };
    const progress = {
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_persisted",
      job_id: "job-runner-test",
      case_id: "case-runner-test",
      collab_snapshot_id: "snapshot-runner-test",
      collab_snapshot_fingerprint: "f".repeat(64),
      candidate: {
        candidate_id: "candidate-a",
        status: "completed",
        run_id: "run-a",
        output_hash: "out-a",
        summary: "A persisted",
        evidence_refs: ["evidence-runner-test"],
      },
    };
    const output = JSON.stringify({
      ok: true,
      data: {
        schema_id: "cd-collab.triage_run_result.v1",
        action: "collab_triage_run",
        job_id: "job-runner-test",
        case_id: "case-runner-test",
        collab_snapshot_id: "snapshot-runner-test",
        collab_snapshot_fingerprint: "f".repeat(64),
        same_snapshot: true,
        candidates: [
          {
            candidate_id: "candidate-a",
            status: "completed",
            run_id: "run-a",
            output_hash: "out-a",
            summary: "A persisted",
            evidence_refs: ["evidence-runner-test"],
          },
          {
            candidate_id: "candidate-b",
            status: "partial",
            run_id: "run-b",
            output_hash: "out-b",
            summary: "B partial",
            evidence_refs: [],
          },
        ],
      },
    });
    const prefix = "contextdesk.collab_triage_progress ";
    await writeFile(
      command,
      `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(`${prefix}${JSON.stringify(started)}\n${prefix}${JSON.stringify(progress)}\n`)});\nprocess.stdout.write(${JSON.stringify(output)});\n`,
      { mode: 0o755 },
    );
    const startedResults: string[] = [];
    const progressResults: string[] = [];
    try {
      const executor = new RustBridgeTriageExecutor({ command });
      const results = await executor.executeBatch({
        ...context,
        onCandidateStarted: (candidateId) => {
          startedResults.push(candidateId);
        },
        onCandidate: (result) => {
          progressResults.push(`${result.candidateId}:${result.benchmarkRunId}`);
        },
      }, new AbortController().signal);
      expect(startedResults).toEqual(["candidate-a"]);
      expect(progressResults).toEqual(["candidate-a:run-a"]);
      expect(results.map((result) => result.benchmarkRunId)).toEqual(["run-a", "run-b"]);
      expect(results[1]?.status).toBe("partial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts a host that exceeds the output bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-runner-overflow-test-"));
    const command = join(root, "overflow-runner.mjs");
    await writeFile(
      command,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));\n",
      { mode: 0o755 },
    );
    try {
      const executor = new RustBridgeTriageExecutor({ command, timeoutMs: 5_000 });
      await expect(executor.executeBatch(context, new AbortController().signal)).rejects.toThrow(
        "output overflow",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
