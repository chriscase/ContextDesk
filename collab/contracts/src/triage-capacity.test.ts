import { describe, expect, it } from "vitest";
import {
  TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
  TRIAGE_EXECUTABLE_MAX_CANDIDATES,
  TRIAGE_MAX_CANDIDATES,
  TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
  TRIAGE_MAX_EVIDENCE_ITEM_BYTES,
  TRIAGE_MAX_PROGRESS_EVENTS,
  TRIAGE_MIN_GATEWAY_CANDIDATES,
  TRIAGE_PROGRESS_EVENTS_PER_LANE,
  checkTriageCandidateCapacity,
  checkTriageEvidenceBudget,
  triageEvidenceBudgetExplanation,
  triageExecutableCandidateCeiling,
  triageProgressEventBudget,
} from "./triage-capacity.js";

describe("the canonical triage capacity formula", () => {
  it("budgets exactly one admission and one settlement per lane", () => {
    expect(TRIAGE_PROGRESS_EVENTS_PER_LANE).toBe(2);
    expect(triageProgressEventBudget(1)).toBe(2);
    expect(triageProgressEventBudget(8)).toBe(16);
    expect(triageProgressEventBudget(9)).toBe(18);
    expect(triageProgressEventBudget(16)).toBe(32);
  });

  it("keeps the advertised ceiling equal to the executable one", () => {
    // The regression this guards: an advertised candidate ceiling of 16 beside
    // a hand-written progress ceiling of 16 meant only 8 lanes could ever run.
    expect(triageExecutableCandidateCeiling(TRIAGE_MAX_PROGRESS_EVENTS)).toBe(TRIAGE_MAX_CANDIDATES);
    expect(TRIAGE_EXECUTABLE_MAX_CANDIDATES).toBe(TRIAGE_MAX_CANDIDATES);
  });

  it("shows the old fixed ceiling of 16 events could only carry 8 lanes", () => {
    expect(triageExecutableCandidateCeiling(16)).toBe(8);
    expect(triageProgressEventBudget(9)).toBeGreaterThan(16);
  });

  it("treats a non-integer or negative lane count as no budget at all", () => {
    expect(triageProgressEventBudget(0)).toBe(0);
    expect(triageProgressEventBudget(-4)).toBe(0);
    expect(triageProgressEventBudget(2.5)).toBe(0);
    expect(triageExecutableCandidateCeiling(0)).toBe(0);
    expect(triageExecutableCandidateCeiling(-1)).toBe(0);
  });
});

describe("triage candidate admission at the exact boundaries", () => {
  it("admits one lane", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 1, gateway: false });
    expect(decision.admitted).toBe(true);
    expect(decision.progressEventBudget).toBe(2);
    expect(decision.code).toBeNull();
  });

  it("admits eight lanes", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 8, gateway: true });
    expect(decision.admitted).toBe(true);
    expect(decision.progressEventBudget).toBe(16);
  });

  it("admits nine lanes, the first count the old fixed ceiling killed", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 9, gateway: true });
    expect(decision.admitted).toBe(true);
    expect(decision.progressEventBudget).toBe(18);
    expect(decision.progressEventBudget).toBeLessThanOrEqual(TRIAGE_MAX_PROGRESS_EVENTS);
  });

  it("admits sixteen lanes, the advertised maximum", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 16, gateway: true });
    expect(decision.admitted).toBe(true);
    expect(decision.progressEventBudget).toBe(32);
    expect(decision.progressEventBudget).toBeLessThanOrEqual(TRIAGE_MAX_PROGRESS_EVENTS);
  });

  it("admits every advertised count, so nothing is accepted and later killed", () => {
    for (let lanes = 1; lanes <= TRIAGE_EXECUTABLE_MAX_CANDIDATES; lanes += 1) {
      const decision = checkTriageCandidateCapacity({ laneCount: lanes, gateway: lanes >= 2 });
      expect(decision.admitted, `lane count ${lanes}`).toBe(true);
      expect(
        decision.progressEventBudget,
        `lane count ${lanes} progress budget`,
      ).toBeLessThanOrEqual(TRIAGE_MAX_PROGRESS_EVENTS);
    }
  });

  it("refuses seventeen lanes at the door", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 17, gateway: true });
    expect(decision.admitted).toBe(false);
    expect(decision.code).toBe("candidate_count_out_of_range");
    expect(decision.message).toContain("16");
  });

  it("refuses zero lanes", () => {
    expect(checkTriageCandidateCapacity({ laneCount: 0, gateway: false }).code)
      .toBe("candidate_count_out_of_range");
  });

  it("refuses a one-lane gateway comparison for having nothing to compare", () => {
    const decision = checkTriageCandidateCapacity({ laneCount: 1, gateway: true });
    expect(decision.admitted).toBe(false);
    expect(decision.code).toBe("gateway_minimum_candidates");
    expect(decision.message).toContain(String(TRIAGE_MIN_GATEWAY_CANDIDATES));
  });
});

describe("the evidence budget contract", () => {
  const aggregate = TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES;

  it("accepts one byte under the 8 MiB aggregate bound", () => {
    expect(checkTriageEvidenceBudget({ scope: "aggregate", actualBytes: aggregate - 1 })).toBeNull();
  });

  it("accepts exactly the 8 MiB aggregate bound", () => {
    expect(checkTriageEvidenceBudget({ scope: "aggregate", actualBytes: aggregate })).toBeNull();
  });

  it("refuses one byte over the 8 MiB aggregate bound with both numbers", () => {
    const failure = checkTriageEvidenceBudget({ scope: "aggregate", actualBytes: aggregate + 1 });
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(TRIAGE_EVIDENCE_BUDGET_ERROR_CODE);
    expect(failure?.scope).toBe("aggregate");
    expect(failure?.allowedBytes).toBe(aggregate);
    expect(failure?.actualBytes).toBe(aggregate + 1);
  });

  it("holds the same exact boundaries for a single item", () => {
    const item = TRIAGE_MAX_EVIDENCE_ITEM_BYTES;
    expect(checkTriageEvidenceBudget({ scope: "item", actualBytes: item - 1 })).toBeNull();
    expect(checkTriageEvidenceBudget({ scope: "item", actualBytes: item })).toBeNull();
    expect(checkTriageEvidenceBudget({ scope: "item", actualBytes: item + 1 })?.allowedBytes)
      .toBe(item);
  });

  it("explains the refusal in bounded words with no run content in it", () => {
    const failure = checkTriageEvidenceBudget({
      scope: "aggregate",
      actualBytes: aggregate + 512 * 1024,
    });
    const explanation = triageEvidenceBudgetExplanation(failure!);
    expect(explanation).toContain("8 MiB");
    expect(explanation).toContain("8.50 MiB");
    expect(explanation).toContain("Nothing was sent to a provider");
    // Not a generic runner error, and not an invitation to retry unchanged.
    expect(explanation).toContain("retrying this one will refuse again");
    expect(explanation.length).toBeLessThanOrEqual(320);
  });

  it("says which scope was exceeded so the operator knows what to trim", () => {
    const item = triageEvidenceBudgetExplanation({
      code: TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
      scope: "item",
      allowedBytes: TRIAGE_MAX_EVIDENCE_ITEM_BYTES,
      actualBytes: TRIAGE_MAX_EVIDENCE_ITEM_BYTES + 1,
    });
    expect(item).toContain("One evidence item");
    const run = triageEvidenceBudgetExplanation({
      code: TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
      scope: "aggregate",
      allowedBytes: aggregate,
      actualBytes: aggregate + 1,
    });
    expect(run).toContain("The frozen evidence for this run");
  });
});
