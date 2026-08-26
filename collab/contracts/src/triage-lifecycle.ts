/**
 * Triage run lifecycle vocabulary and the pure rules over it.
 *
 * Deliberately dependency-free: the web bundle imports this module directly so
 * the reader's view of a run and the server's record are decided by one rule,
 * without dragging the schema machinery — and the Node built-ins it reaches —
 * into the browser.
 */

export const TRIAGE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type TriageJobStatus = (typeof TRIAGE_JOB_STATUSES)[number];

export const TRIAGE_CANDIDATE_STATUSES = TRIAGE_JOB_STATUSES;
export type TriageCandidateStatus = TriageJobStatus;

/**
 * Lane statuses that mean the host actually obtained a usable result for that
 * lane. Everything else is an absence of a result, not a smaller result.
 */
export const TRIAGE_PRODUCING_CANDIDATE_STATUSES = ["completed", "partial"] as const;

/** Lane statuses that can no longer change. */
export const TRIAGE_SETTLED_CANDIDATE_STATUSES = [
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
] as const;

export function isTriageSettledStatus(status: TriageCandidateStatus): boolean {
  return (TRIAGE_SETTLED_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

export function isTriageProducingStatus(status: TriageCandidateStatus): boolean {
  return (TRIAGE_PRODUCING_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

export interface TriageLanePhaseCountsV1 {
  total: number;
  queued: number;
  running: number;
  settled: number;
  /** Settled lanes that actually produced a result the reader can review. */
  produced: number;
}

/** Counts the lifecycle phase of every lane without inferring any outcome. */
export function triageLanePhaseCounts(
  candidates: readonly { status: TriageCandidateStatus }[],
): TriageLanePhaseCountsV1 {
  let queued = 0;
  let running = 0;
  let settled = 0;
  let produced = 0;
  for (const candidate of candidates) {
    if (candidate.status === "queued") queued += 1;
    else if (candidate.status === "running") running += 1;
    if (isTriageSettledStatus(candidate.status)) settled += 1;
    if (isTriageProducingStatus(candidate.status)) produced += 1;
  }
  return { total: candidates.length, queued, running, settled, produced };
}

/**
 * The single lifecycle rule that decides a job's terminal status.
 *
 * `partial` is a claim that some lanes produced reviewable results. A run in
 * which every lane failed, timed out, or was cancelled produced nothing, so it
 * must never be reported as partial: on a slow or unreliable gateway that is
 * the common case, and calling it partial invites a reader to look for results
 * that do not exist. Server and web share this rule so one definition of
 * "produced a result" governs both the record and what the reader is offered.
 */
export function resolveTriageJobStatus(
  candidates: readonly { status: TriageCandidateStatus }[],
  cancellationRequested: boolean,
): TriageJobStatus {
  const counts = triageLanePhaseCounts(candidates);
  if (counts.total === 0) return cancellationRequested ? "cancelled" : "failed";
  if (counts.produced === 0) {
    const cancelled = candidates.filter((candidate) => candidate.status === "cancelled").length;
    if (cancellationRequested || cancelled === counts.total) return "cancelled";
    if (candidates.every((candidate) => candidate.status === "timed_out")) return "timed_out";
    // Every remaining shape — all failed, or any mix of hard failures — is a
    // run with no result. `failed` is the honest umbrella; the per-lane rows
    // keep the exact reason for each lane.
    return "failed";
  }
  if (candidates.every((candidate) => candidate.status === "completed")) return "completed";
  return "partial";
}

/**
 * Honest configured-versus-executed state for one job.
 *
 * `configured` is only what the operator asked for; it is never evidence that
 * the host ran anything. Claiming a job for a worker is not execution either,
 * so job-level `startedAt` deliberately does not count here: admission is a
 * lane that actually began (`startedAt`) or a lane that produced a result.
 * A gateway that never answered leaves every lane unstarted, and that job must
 * keep reading as configured rather than as a run that happened.
 */
export type TriageJobExecutionState = "configured" | "executing" | "executed";

export function triageJobExecutionState(job: {
  candidates: readonly { status: TriageCandidateStatus; startedAt: string | null }[];
}): TriageJobExecutionState {
  const admitted = job.candidates.some(
    (candidate) => candidate.startedAt !== null || isTriageProducingStatus(candidate.status),
  );
  if (!admitted) return "configured";
  const counts = triageLanePhaseCounts(job.candidates);
  return counts.settled === counts.total ? "executed" : "executing";
}
