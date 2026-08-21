#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const requestIndex = args.indexOf("--request");
const requestPath = requestIndex >= 0 ? args[requestIndex + 1] : null;
const commandIndex = args.indexOf("collab-triage-run");
const progressIndex = args.indexOf("--progress-events");

if (!requestPath || commandIndex < 0 || progressIndex < commandIndex || args.indexOf("--json") < 0) {
  process.exitCode = 2;
  process.stderr.write("invalid bridge fixture invocation\n");
} else {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const candidates = Array.isArray(request.candidates) ? request.candidates : [];
  const expected = [
    { candidateId: "qwen-reviewer", profileId: "profile:fixture-qwen", model: "qwen-3.6-27b" },
    { candidateId: "gpt-oss-contributor", profileId: "profile:fixture-gpt", model: "gpt-oss-120b" },
    { candidateId: "ministral-challenger", profileId: "profile:fixture-ministral", model: "ministral-3-14b-instruct-2512" },
  ];
  // The Collab host bridge is gateway-only, so the narrow bridge request does
  // not repeat a mode discriminator. Validate the bounded gateway shape that
  // the production executor actually sends.
  const requestShapeIsExpected = request.concurrency === 2
    && candidates.length === expected.length
    && candidates.every((candidate, index) => {
      const wanted = expected[index];
      return candidate.candidateId === wanted.candidateId
        && candidate.profileId === wanted.profileId
        && candidate.modelId === wanted.model;
    });
  if (!requestShapeIsExpected) {
    process.exitCode = 1;
    process.stderr.write("bridge fixture rejected unexpected gateway request shape\n");
  } else {
  const evidenceId = request.snapshot?.evidence?.[0]?.evidenceId ?? null;
  const prefix = "contextdesk.collab_triage_progress ";

  for (const candidate of candidates) {
    process.stderr.write(`${prefix}${JSON.stringify({
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_started",
      job_id: request.jobId,
      case_id: request.case.caseId,
      collab_snapshot_id: request.snapshot.snapshotId,
      collab_snapshot_fingerprint: request.snapshot.fingerprint,
      candidate_id: candidate.candidateId,
    })}\n`);
  }

  const results = candidates.map((candidate) => {
    const summary = `Fixture bridge result for ${candidate.modelId}; inspect the frozen evidence before changing the mitigation.`;
    return {
      candidate_id: candidate.candidateId,
      status: "completed",
      run_id: `fixture-${candidate.candidateId}`,
      // The host contract carries a content-addressed SHA-256 output hash,
      // even for a deterministic fixture. Keep the browser rehearsal on the
      // same wire contract as a real provider-backed run.
      output_hash: createHash("sha256").update(summary).digest("hex"),
      summary,
      evidence_refs: evidenceId ? [evidenceId] : [],
    };
  });

  for (const candidate of results) {
    process.stderr.write(`${prefix}${JSON.stringify({
      schema_id: "cd-collab.triage_run_progress.v1",
      action: "candidate_persisted",
      job_id: request.jobId,
      case_id: request.case.caseId,
      collab_snapshot_id: request.snapshot.snapshotId,
      collab_snapshot_fingerprint: request.snapshot.fingerprint,
      candidate,
    })}\n`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      schema_id: "cd-collab.triage_run_result.v1",
      action: "collab_triage_run",
      job_id: request.jobId,
      case_id: request.case.caseId,
      collab_snapshot_id: request.snapshot.snapshotId,
      collab_snapshot_fingerprint: request.snapshot.fingerprint,
      same_snapshot: true,
      candidates: results,
    },
  }));
  }
}
