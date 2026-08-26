/**
 * The durable observable state of one triage run, and the concise progress a
 * War-Room operator reads while a company gateway is slow.
 *
 * Every value here is computed from facts the host already persisted — job
 * status, cancellation request, worker lease, per-lane admission and
 * settlement stamps, declared lineage — plus a clock. Nothing is held in the
 * browser and nothing is inferred from a live connection, so a reload, a
 * reconnect, or a second reader arrives at exactly the same state as the tab
 * that started the run. That is what makes these states durable: they survive
 * the observer, not merely the socket.
 *
 * Deliberately dependency-free so the server's record and the reader's view of
 * it are decided by one rule.
 */

import {
  isTriageProducingStatus,
  isTriageSettledStatus,
  triageLanePhaseCounts,
  type TriageCandidateStatus,
  type TriageJobStatus,
} from "./triage-lifecycle.js";
import {
  TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
  triageEvidenceBudgetExplanation,
  type TriageEvidenceBudgetFailureV1,
} from "./triage-capacity.js";

export const TRIAGE_RUN_OBSERVED_STATES = [
  "queued",
  "running",
  "progress",
  "stalled",
  "retrying",
  "cancel_requested",
  "cancelled",
  "failed",
  "completed",
] as const;
export type TriageRunObservedState = (typeof TRIAGE_RUN_OBSERVED_STATES)[number];

/** Observed states that can never be left. */
export const TRIAGE_RUN_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

export function isTriageRunTerminalState(state: TriageRunObservedState): boolean {
  return (TRIAGE_RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * How long a claimed run may show no lane movement before it is reported as
 * stalled rather than as running. Deliberately longer than the worker
 * heartbeat: a live lease with no lane movement is exactly the frozen-gateway
 * case this state exists to name.
 */
export const TRIAGE_STALL_AFTER_MS = 90_000;

export interface TriageRunObservationInput {
  status: TriageJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  /** Declared lineage: present only on an intentional repeat of a prior run. */
  parentJobId?: string | null;
  /** Internal lease expiry; absent on legacy records. */
  leaseExpiresAt?: string | null;
  /** Last durable lane movement; absent on records written before it existed. */
  lastProgressAt?: string | null;
  /** Structured host-decided refusal, when one is known well enough to name. */
  failure?: TriageEvidenceBudgetFailureV1 | null;
  candidates: readonly {
    status: TriageCandidateStatus;
    role: string;
    candidateId: string;
    startedAt: string | null;
  }[];
}

export interface TriageRunObservationV1 {
  state: TriageRunObservedState;
  /** The lane the operator should look at, or null when none is in flight. */
  lane: string | null;
  /** Plain-words stage of that lane, never a provider or trace string. */
  stage: string;
  completed: number;
  total: number;
  elapsedMs: number | null;
  /** Time since the last durable lane movement, or null when none has happened. */
  sinceLastProgressMs: number | null;
  /** The one thing the operator should do next. */
  nextAction: string;
}

function parseMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function since(from: string | null | undefined, nowMs: number): number | null {
  const at = parseMs(from);
  return at === null ? null : Math.max(0, nowMs - at);
}

/**
 * The lane an operator should be looking at, or none.
 *
 * Only a lane the host actually admitted and has not settled. A lane that is
 * merely configured and waiting is deliberately not named: naming it reads as
 * "this lane is working on it", and on a gateway that never admitted anything
 * that is the exact false impression this whole view exists to prevent. Never
 * a "winner", never the fastest — only what is genuinely in flight.
 */
function focusLane(
  candidates: TriageRunObservationInput["candidates"],
): { lane: string } | null {
  const running = candidates.find(
    (candidate) => candidate.startedAt !== null && !isTriageSettledStatus(candidate.status),
  );
  return running ? { lane: running.role || running.candidateId } : null;
}

/**
 * Terminal-state monotonicity.
 *
 * A late progress callback, a stale worker publishing after its lease expired,
 * or a reconnect that replays an old frame must never move a run out of a
 * terminal state. Callers thread the previously observed state through here so
 * a run that has once been seen as completed, failed, or cancelled keeps that
 * state regardless of what arrives afterwards.
 */
export function advanceTriageRunState(
  previous: TriageRunObservedState | null,
  next: TriageRunObservedState,
): TriageRunObservedState {
  if (previous !== null && isTriageRunTerminalState(previous)) return previous;
  return next;
}

/** Derives the durable observable state of one run from persisted facts. */
export function triageRunObservation(
  job: TriageRunObservationInput,
  nowMs: number,
  options: { stallAfterMs?: number } = {},
): TriageRunObservationV1 {
  const stallAfterMs = options.stallAfterMs ?? TRIAGE_STALL_AFTER_MS;
  const counts = triageLanePhaseCounts(job.candidates);
  const produced = job.candidates.filter((candidate) =>
    isTriageProducingStatus(candidate.status),
  ).length;
  const elapsedMs = since(job.startedAt ?? job.createdAt, nowMs);
  // A claimed run whose lease has already lapsed has no live worker behind it,
  // whatever its last lane movement said.
  const leaseExpiresAtMs = parseMs(job.leaseExpiresAt);
  const leaseLapsed = job.status === "running"
    && (job.leaseExpiresAt === null || job.leaseExpiresAt === undefined || (leaseExpiresAtMs !== null && leaseExpiresAtMs <= nowMs));
  // Admission is lane movement even before a lane settles, so a run that has
  // just claimed a worker is not immediately reported as having no progress.
  const lastMovement = job.lastProgressAt
    ?? job.candidates.reduce<string | null>((latest, candidate) => {
      const at = candidate.startedAt;
      if (!at) return latest;
      return latest === null || at > latest ? at : latest;
    }, null)
    ?? job.startedAt;
  const sinceLastProgressMs = since(lastMovement, nowMs);
  const focus = focusLane(job.candidates);

  const base = {
    lane: focus?.lane ?? null,
    completed: produced,
    total: counts.total,
    elapsedMs,
    sinceLastProgressMs,
  };

  if (job.status === "completed" || job.status === "partial") {
    return {
      ...base,
      state: "completed",
      lane: null,
      stage: produced === counts.total ? "every lane settled" : "settled with lanes that produced nothing",
      nextAction: produced > 0
        ? "Read the per-lane results; agreement between lanes is not proof."
        : "No lane produced a result. Read the per-lane reasons.",
    };
  }
  if (job.status === "cancelled") {
    return {
      ...base,
      state: "cancelled",
      lane: null,
      stage: "cancelled",
      nextAction: "Nothing is running. Start a new run when you are ready.",
    };
  }
  if (job.status === "failed" || job.status === "timed_out") {
    // Where the host decided the refusal itself it can say exactly what to do,
    // and the sentence is rendered from stored numbers rather than stored text.
    const budgetRefusal = job.failure?.code === TRIAGE_EVIDENCE_BUDGET_ERROR_CODE
      ? triageEvidenceBudgetExplanation(job.failure)
      : null;
    return {
      ...base,
      state: "failed",
      lane: null,
      stage: budgetRefusal
        ? "refused before anything was sent"
        : job.status === "timed_out" ? "no lane answered in time" : "stopped without a result",
      nextAction: budgetRefusal ?? "Read the per-lane reason before retrying; some reasons repeat.",
    };
  }
  if (job.cancelRequestedAt) {
    return {
      ...base,
      state: "cancel_requested",
      stage: "cancelling",
      nextAction: "Cancellation is recorded. Wait for the lanes to stop; nothing new will be sent.",
    };
  }
  if (job.status === "queued") {
    // A queued run that names a prior attempt is a retry, and saying so keeps
    // the operator from reading it as the original still sitting there.
    const retrying = Boolean(job.parentJobId);
    return {
      ...base,
      state: retrying ? "retrying" : "queued",
      stage: retrying
        ? "waiting for a worker — no lane has started yet (retry of an earlier run)"
        : "waiting for a worker — no lane has started yet",
      // The first sentence is the one an operator acts on: a queued run offers
      // nothing to read, however long it has been sitting there.
      nextAction: "Nothing has been sent for you to read. Leave this open or cancel it; do not start a second identical run.",
    };
  }
  if (leaseLapsed) {
    return {
      ...base,
      state: "stalled",
      stage: "the worker holding this run stopped reporting",
      nextAction: "The host will settle this run as failed. Wait for it, then retry.",
    };
  }
  if (sinceLastProgressMs !== null && sinceLastProgressMs >= stallAfterMs) {
    return {
      ...base,
      state: "stalled",
      stage: "no lane has moved recently",
      nextAction: "The gateway is not answering. Cancel if you need the slot; nothing is lost by waiting.",
    };
  }
  if (counts.settled > 0 || produced > 0) {
    return {
      ...base,
      state: "progress",
      stage: focus ? "waiting on a lane that has started" : "waiting for the next lane to start",
      nextAction: "Lanes are settling. No action needed.",
    };
  }
  return {
    ...base,
    state: "running",
    stage: focus
      ? "a lane has started and has not answered"
      : "claimed by a worker — no lane has started yet",
    nextAction: "No action needed yet. Cancel if you no longer need this run.",
  };
}

export type TriageRetryDisposition = "safe" | "uncertain" | "not_applicable";

export interface TriageRetryEligibilityV1 {
  disposition: TriageRetryDisposition;
  /** Bounded plain words; never a provider, host, or trace string. */
  reason: string;
  nextAction: string;
}

/**
 * Whether repeating this run is safe, or repeats work whose outcome is unknown.
 *
 * The distinction the operator actually needs is not "did it fail" but "did
 * anything reach the provider that the host never saw the end of". A lane the
 * host admitted and then lost — a frozen gateway, an expired lease, a host
 * restart, a cancel that raced an in-flight call — may have been fully served
 * on the other side. Retrying that is a second charge and a second load, and
 * the honest answer is to say so rather than to present a retry button that
 * implies nothing happened.
 *
 * A lane that never started is unambiguous: nothing was sent, so a retry costs
 * nothing beyond the retry. Uncertainty is judged that way — by admission
 * without a produced result — rather than by an error-code table, so a code
 * nobody has classified yet lands on the cautious side by default.
 */
export function triageRetryEligibility(
  job: Pick<TriageRunObservationInput, "status" | "candidates" | "failure">,
): TriageRetryEligibilityV1 {
  const terminal = job.status === "completed"
    || job.status === "partial"
    || job.status === "failed"
    || job.status === "timed_out"
    || job.status === "cancelled";
  if (!terminal) {
    return {
      disposition: "not_applicable",
      reason: "This run has not settled yet.",
      nextAction: "Wait for it or cancel it. Do not start a second identical run.",
    };
  }
  if (job.failure?.code === "evidence_budget_exceeded") {
    return {
      disposition: "safe",
      reason: "The host refused this run before sending anything to a provider.",
      nextAction: "Trim the frozen evidence first; an unchanged retry is refused the same way.",
    };
  }
  const lostLanes = job.candidates.filter(
    (candidate) => candidate.startedAt !== null && !isTriageProducingStatus(candidate.status),
  ).length;
  if (lostLanes > 0) {
    return {
      disposition: "uncertain",
      reason: `${lostLanes} lane${lostLanes === 1 ? "" : "s"} started and the host never saw an outcome. The provider may have run the work anyway.`,
      nextAction: "Check the gateway's own record before retrying; a retry may repeat work that already ran.",
    };
  }
  return {
    disposition: "safe",
    reason: "No lane was left with an unknown outcome.",
    nextAction: "Retrying repeats only work the host can account for.",
  };
}
