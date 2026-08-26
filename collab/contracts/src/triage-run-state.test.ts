import { describe, expect, it } from "vitest";
import {
  TRIAGE_RUN_OBSERVED_STATES,
  TRIAGE_STALL_AFTER_MS,
  advanceTriageRunState,
  isTriageRunTerminalState,
  triageRetryEligibility,
  triageRunObservation,
  type TriageRunObservationInput,
} from "./triage-run-state.js";
import { TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES } from "./triage-capacity.js";

const T0 = Date.parse("2026-08-20T00:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function lane(
  overrides: Partial<TriageRunObservationInput["candidates"][number]> = {},
): TriageRunObservationInput["candidates"][number] {
  return {
    candidateId: "lane-a",
    role: "reviewer",
    status: "queued",
    startedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<TriageRunObservationInput> = {}): TriageRunObservationInput {
  return {
    status: "queued",
    createdAt: at(0),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    parentJobId: null,
    leaseExpiresAt: null,
    lastProgressAt: null,
    failure: null,
    candidates: [lane()],
    ...overrides,
  };
}

describe("the durable run-state vocabulary", () => {
  it("names every state the lifecycle promises", () => {
    expect([...TRIAGE_RUN_OBSERVED_STATES]).toEqual([
      "queued",
      "running",
      "progress",
      "stalled",
      "retrying",
      "cancel_requested",
      "cancelled",
      "failed",
      "completed",
    ]);
  });

  it("treats exactly the three end states as terminal", () => {
    expect(TRIAGE_RUN_OBSERVED_STATES.filter(isTriageRunTerminalState))
      .toEqual(["cancelled", "failed", "completed"]);
  });
});

describe("observing a run from persisted facts only", () => {
  it("reports a queued run as queued with nothing to read", () => {
    const view = triageRunObservation(job(), T0 + 5_000);
    expect(view.state).toBe("queued");
    expect(view.lane).toBeNull();
    expect(view.stage).toContain("no lane has started yet");
    expect(view.nextAction).toContain("Nothing has been sent for you to read.");
    expect(view.completed).toBe(0);
    expect(view.total).toBe(1);
  });

  it("reports a queued run that names a prior attempt as retrying", () => {
    const view = triageRunObservation(job({ parentJobId: "job-earlier" }), T0 + 1_000);
    expect(view.state).toBe("retrying");
    expect(view.stage).toContain("retry of an earlier run");
  });

  it("reports a claimed run with no admitted lane as running, not as progress", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(1_000),
        leaseExpiresAt: at(60_000),
      }),
      T0 + 5_000,
    );
    expect(view.state).toBe("running");
    expect(view.lane).toBeNull();
    expect(view.stage).toContain("no lane has started yet");
  });

  it("names only a lane that actually started", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(2_000),
        leaseExpiresAt: at(60_000),
        candidates: [
          lane({ candidateId: "a", role: "reviewer", status: "running", startedAt: at(2_000) }),
          lane({ candidateId: "b", role: "second-opinion", status: "queued" }),
        ],
      }),
      T0 + 5_000,
    );
    expect(view.state).toBe("running");
    expect(view.lane).toBe("reviewer");
  });

  it("reports progress once a lane has settled", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(4_000),
        leaseExpiresAt: at(60_000),
        candidates: [
          lane({ candidateId: "a", status: "completed", startedAt: at(2_000) }),
          lane({ candidateId: "b", role: "second", status: "running", startedAt: at(3_000) }),
        ],
      }),
      T0 + 5_000,
    );
    expect(view.state).toBe("progress");
    expect(view.completed).toBe(1);
    expect(view.total).toBe(2);
    expect(view.lane).toBe("second");
  });

  it("carries elapsed time and time since the last movement", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(3_000),
        leaseExpiresAt: at(60_000),
        candidates: [lane({ status: "running", startedAt: at(2_000) })],
      }),
      T0 + 11_000,
    );
    expect(view.elapsedMs).toBe(10_000);
    expect(view.sinceLastProgressMs).toBe(8_000);
  });
});

describe("a frozen gateway", () => {
  const frozen = job({
    status: "running",
    startedAt: at(1_000),
    lastProgressAt: at(2_000),
    leaseExpiresAt: at(10_000_000),
    candidates: [lane({ status: "running", startedAt: at(2_000) })],
  });

  it("still reads as running just inside the stall window", () => {
    const view = triageRunObservation(frozen, T0 + 2_000 + TRIAGE_STALL_AFTER_MS - 1);
    expect(view.state).toBe("running");
  });

  it("reads as stalled the moment the stall window is reached", () => {
    const view = triageRunObservation(frozen, T0 + 2_000 + TRIAGE_STALL_AFTER_MS);
    expect(view.state).toBe("stalled");
    expect(view.stage).toContain("no lane has moved recently");
    expect(view.nextAction).toContain("Cancel if you need the slot");
  });

  it("is stalled on a live heartbeat, because the heartbeat is not progress", () => {
    // The lease is renewed far into the future and the run is still stuck:
    // only a field the heartbeat does not touch can tell these apart.
    const view = triageRunObservation(
      { ...frozen, leaseExpiresAt: at(10_000_000) },
      T0 + 2_000 + TRIAGE_STALL_AFTER_MS + 1,
    );
    expect(view.state).toBe("stalled");
  });
});

describe("lease expiry and host restart", () => {
  it("reports a claimed run whose lease has lapsed as stalled", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(2_000),
        leaseExpiresAt: at(3_000),
        candidates: [lane({ status: "running", startedAt: at(2_000) })],
      }),
      T0 + 4_000,
    );
    expect(view.state).toBe("stalled");
    expect(view.stage).toContain("stopped reporting");
    expect(view.nextAction).toContain("settle this run as failed");
  });

  it("treats a running record with no lease at all as stalled", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        lastProgressAt: at(1_500),
        leaseExpiresAt: null,
        candidates: [lane({ status: "running", startedAt: at(1_200) })],
      }),
      T0 + 2_000,
    );
    expect(view.state).toBe("stalled");
  });

  it("gives a reconnecting reader the same state as the tab that started it", () => {
    const record = job({
      status: "running",
      startedAt: at(1_000),
      lastProgressAt: at(4_000),
      leaseExpiresAt: at(60_000),
      candidates: [
        lane({ candidateId: "a", status: "completed", startedAt: at(2_000) }),
        lane({ candidateId: "b", role: "second", status: "running", startedAt: at(3_000) }),
      ],
    });
    // No connection, no session, no browser memory: the same stored record
    // observed at the same instant produces the same view for anyone.
    const first = triageRunObservation(record, T0 + 9_000);
    const reconnected = triageRunObservation(structuredClone(record), T0 + 9_000);
    expect(reconnected).toEqual(first);
  });
});

describe("cancellation and terminal states", () => {
  it("reports a requested cancellation before it settles", () => {
    const view = triageRunObservation(
      job({
        status: "running",
        startedAt: at(1_000),
        cancelRequestedAt: at(3_000),
        lastProgressAt: at(2_000),
        leaseExpiresAt: at(60_000),
        candidates: [lane({ status: "running", startedAt: at(2_000) })],
      }),
      T0 + 4_000,
    );
    expect(view.state).toBe("cancel_requested");
    expect(view.nextAction).toContain("nothing new will be sent");
  });

  it("reports a settled cancellation as cancelled", () => {
    const view = triageRunObservation(
      job({
        status: "cancelled",
        startedAt: at(1_000),
        finishedAt: at(4_000),
        cancelRequestedAt: at(3_000),
        candidates: [lane({ status: "cancelled", startedAt: at(2_000) })],
      }),
      T0 + 5_000,
    );
    expect(view.state).toBe("cancelled");
    expect(view.lane).toBeNull();
  });

  it("does not offer a review of a partial run in which nothing was produced", () => {
    const view = triageRunObservation(
      job({
        status: "partial",
        startedAt: at(1_000),
        finishedAt: at(5_000),
        candidates: [
          lane({ candidateId: "a", status: "failed", startedAt: at(2_000) }),
          lane({ candidateId: "b", status: "timed_out", startedAt: at(2_000) }),
        ],
      }),
      T0 + 6_000,
    );
    expect(view.state).toBe("completed");
    expect(view.completed).toBe(0);
    expect(view.nextAction).toContain("No lane produced a result");
  });

  it("explains an evidence-budget refusal instead of pointing at lane reasons", () => {
    const view = triageRunObservation(
      job({
        status: "failed",
        startedAt: at(1_000),
        finishedAt: at(2_000),
        failure: {
          code: "evidence_budget_exceeded",
          scope: "aggregate",
          allowedBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
          actualBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES + 1,
        },
        candidates: [lane({ status: "failed" })],
      }),
      T0 + 3_000,
    );
    expect(view.state).toBe("failed");
    expect(view.stage).toBe("refused before anything was sent");
    expect(view.nextAction).toContain("8 MiB");
    expect(view.nextAction).toContain("Nothing was sent to a provider");
  });
});

describe("terminal-state monotonicity", () => {
  it("refuses to walk a completed run back to running", () => {
    expect(advanceTriageRunState("completed", "running")).toBe("completed");
    expect(advanceTriageRunState("failed", "progress")).toBe("failed");
    expect(advanceTriageRunState("cancelled", "queued")).toBe("cancelled");
  });

  it("still advances through every non-terminal state", () => {
    expect(advanceTriageRunState(null, "queued")).toBe("queued");
    expect(advanceTriageRunState("queued", "running")).toBe("running");
    expect(advanceTriageRunState("running", "progress")).toBe("progress");
    expect(advanceTriageRunState("progress", "stalled")).toBe("stalled");
    expect(advanceTriageRunState("stalled", "cancel_requested")).toBe("cancel_requested");
    expect(advanceTriageRunState("cancel_requested", "cancelled")).toBe("cancelled");
  });

  it("holds a terminal state against a late frame for every terminal state", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      for (const late of TRIAGE_RUN_OBSERVED_STATES) {
        expect(advanceTriageRunState(terminal, late), `${terminal} then ${late}`).toBe(terminal);
      }
    }
  });
});

describe("safe retry versus an uncertain provider outcome", () => {
  it("will not judge a run that has not settled", () => {
    const view = triageRetryEligibility(job({ status: "running" }));
    expect(view.disposition).toBe("not_applicable");
    expect(view.nextAction).toContain("Do not start a second identical run.");
  });

  it("calls a run that never admitted a lane safe to retry", () => {
    const view = triageRetryEligibility(
      job({ status: "failed", candidates: [lane({ status: "failed", startedAt: null })] }),
    );
    expect(view.disposition).toBe("safe");
  });

  it("calls an evidence-budget refusal safe but futile to repeat unchanged", () => {
    const view = triageRetryEligibility(
      job({
        status: "failed",
        failure: {
          code: "evidence_budget_exceeded",
          scope: "aggregate",
          allowedBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
          actualBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES + 1,
        },
        candidates: [lane({ status: "failed", startedAt: null })],
      }),
    );
    expect(view.disposition).toBe("safe");
    expect(view.reason).toContain("before sending anything to a provider");
    expect(view.nextAction).toContain("Trim the frozen evidence first");
  });

  it("calls a lane the host admitted and lost an uncertain outcome", () => {
    const view = triageRetryEligibility(
      job({
        status: "failed",
        candidates: [
          lane({ candidateId: "a", status: "failed", startedAt: at(2_000) }),
          lane({ candidateId: "b", status: "completed", startedAt: at(2_000) }),
        ],
      }),
    );
    expect(view.disposition).toBe("uncertain");
    expect(view.reason).toContain("1 lane started");
    expect(view.nextAction).toContain("may repeat work that already ran");
  });

  it("treats a cancellation that raced an in-flight lane as uncertain", () => {
    const view = triageRetryEligibility(
      job({
        status: "cancelled",
        candidates: [lane({ status: "cancelled", startedAt: at(2_000) })],
      }),
    );
    expect(view.disposition).toBe("uncertain");
  });

  it("treats a cancellation before any dispatch as safe", () => {
    const view = triageRetryEligibility(
      job({
        status: "cancelled",
        candidates: [lane({ status: "cancelled", startedAt: null })],
      }),
    );
    expect(view.disposition).toBe("safe");
  });

  it("calls a fully produced run safe to repeat", () => {
    const view = triageRetryEligibility(
      job({
        status: "completed",
        candidates: [lane({ status: "completed", startedAt: at(2_000) })],
      }),
    );
    expect(view.disposition).toBe("safe");
  });
});
