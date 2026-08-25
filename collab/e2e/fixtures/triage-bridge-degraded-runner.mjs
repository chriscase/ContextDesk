#!/usr/bin/env node
/**
 * Provider-free bridge fixture that returns a deliberately degraded lane set:
 * one completed lane, one partial lane, and one failed lane.
 *
 * This exists because "all three lanes came back clean" is the easy case. The
 * War Room has to stay readable when it did not, and the only honest way to
 * qualify that in a browser is to make the host bridge actually report mixed
 * outcomes on the real wire contract.
 *
 * It contacts no provider and produces no quality claim. The summaries below
 * describe orchestration only; usage and cost stay unknown, as the server
 * boundary requires.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const requestIndex = args.indexOf("--request");
const requestPath = requestIndex >= 0 ? args[requestIndex + 1] : null;
const commandIndex = args.indexOf("collab-triage-run");
const progressIndex = args.indexOf("--progress-events");

if (!requestPath || commandIndex < 0 || progressIndex < commandIndex || args.indexOf("--json") < 0) {
  process.exitCode = 2;
  process.stderr.write("invalid degraded bridge fixture invocation\n");
} else {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const candidates = Array.isArray(request.candidates) ? request.candidates : [];
  if (candidates.length === 0) {
    process.exitCode = 1;
    process.stderr.write("degraded bridge fixture received no candidates\n");
  } else {
    const evidenceId = request.snapshot?.evidence?.[0]?.evidenceId ?? null;
    const prefix = "contextdesk.collab_triage_progress ";
    const emit = (payload) => {
      process.stderr.write(`${prefix}${JSON.stringify({
        schema_id: "cd-collab.triage_run_progress.v1",
        job_id: request.jobId,
        case_id: request.case.caseId,
        collab_snapshot_id: request.snapshot.snapshotId,
        collab_snapshot_fingerprint: request.snapshot.fingerprint,
        ...payload,
      })}\n`);
    };

    for (const candidate of candidates) {
      emit({ action: "candidate_started", candidate_id: candidate.candidateId });
    }

    // Lane outcomes are assigned by position so the same archive of fixture
    // input always produces the same degraded shape across repeated runs.
    const plan = ["completed", "partial", "failed"];
    const startedAt = "2026-03-14T09:20:00.000Z";
    const finishedAt = "2026-03-14T09:20:04.000Z";

    const results = candidates.map((candidate, index) => {
      const status = plan[index % plan.length];
      if (status === "failed") {
        return {
          candidate_id: candidate.candidateId,
          status: "failed",
          run_id: "",
          output_hash: "",
          // A code from the host's safe set, so the surface can name the
          // failure without leaking anything about the provider call.
          error_code: "provider_unavailable",
          summary: "",
          evidence_refs: [],
          started_at: startedAt,
          finished_at: finishedAt,
        };
      }
      const summary = status === "partial"
        ? `Fixture bridge lane for ${candidate.modelId} stopped before it finished. The text below is incomplete and must not be read as a conclusion.`
        : `Fixture bridge lane for ${candidate.modelId} finished. Inspect the frozen evidence before changing the mitigation.`;
      return {
        candidate_id: candidate.candidateId,
        status,
        run_id: `fixture-degraded-${candidate.candidateId}`,
        output_hash: createHash("sha256").update(`${status}:${summary}`).digest("hex"),
        error_code: status === "partial" ? "deadline_exceeded" : "",
        summary,
        evidence_refs: evidenceId ? [evidenceId] : [],
        started_at: startedAt,
        finished_at: finishedAt,
      };
    });

    for (const candidate of results) {
      emit({ action: "candidate_persisted", candidate });
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
