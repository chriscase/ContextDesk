import { describe, expect, it } from "vitest";
import {
  resolveTriageJobStatus,
  triageJobExecutionState,
  triageLanePhaseCounts,
  type TriageCandidateStatus,
} from "./triage-lifecycle.js";

describe("triage job lifecycle rule", () => {
  const lane = (status: string, startedAt: string | null = "2026-08-20T00:00:00.000Z") =>
    ({ status, startedAt }) as { status: TriageCandidateStatus; startedAt: string | null };

  it("reports completed only when every lane completed", () => {
    expect(resolveTriageJobStatus([lane("completed"), lane("completed")], false)).toBe("completed");
  });

  it("reports partial only when a lane actually produced a result", () => {
    expect(resolveTriageJobStatus([lane("completed"), lane("failed")], false)).toBe("partial");
    expect(resolveTriageJobStatus([lane("partial"), lane("timed_out")], false)).toBe("partial");
  });

  it("never calls a run partial when no lane produced anything", () => {
    // A slow, unreliable gateway lands here: one lane past the deadline and one
    // erroring out. There is nothing partial about it — there is no result.
    expect(resolveTriageJobStatus([lane("failed"), lane("timed_out")], false)).toBe("failed");
    expect(resolveTriageJobStatus([lane("failed"), lane("cancelled")], false)).toBe("failed");
    expect(resolveTriageJobStatus([lane("timed_out"), lane("timed_out")], false)).toBe("timed_out");
    expect(resolveTriageJobStatus([lane("failed"), lane("failed")], false)).toBe("failed");
  });

  it("attributes a resultless run to cancellation when the operator asked for it", () => {
    expect(resolveTriageJobStatus([lane("failed"), lane("cancelled")], true)).toBe("cancelled");
    expect(resolveTriageJobStatus([lane("cancelled"), lane("cancelled")], false)).toBe("cancelled");
  });

  it("keeps produced results visible even when cancellation was requested", () => {
    expect(resolveTriageJobStatus([lane("completed"), lane("cancelled")], true)).toBe("partial");
  });

  it("counts each lane's lifecycle phase without inferring an outcome", () => {
    const counts = triageLanePhaseCounts([
      lane("queued"),
      lane("running"),
      lane("completed"),
      lane("timed_out"),
    ]);
    expect(counts).toEqual({ total: 4, queued: 1, running: 1, settled: 2, produced: 1 });
  });

  it("separates a configured run from one the host actually executed", () => {
    // Selecting gateway mode is a request. A gateway that never admitted a lane
    // leaves a record that must not read like a run that happened.
    expect(
      triageJobExecutionState({ candidates: [lane("queued", null), lane("queued", null)] }),
    ).toBe("configured");
    expect(
      triageJobExecutionState({ candidates: [lane("failed", null), lane("failed", null)] }),
    ).toBe("configured");
    expect(
      triageJobExecutionState({ candidates: [lane("running"), lane("queued", null)] }),
    ).toBe("executing");
    expect(
      triageJobExecutionState({ candidates: [lane("completed"), lane("failed")] }),
    ).toBe("executed");
  });

  it("treats a produced result as proof of execution even without lane timing", () => {
    // A host may report a result without normalized timing; the result itself
    // still establishes that the lane ran.
    expect(
      triageJobExecutionState({ candidates: [lane("completed", null)] }),
    ).toBe("executed");
  });
});
