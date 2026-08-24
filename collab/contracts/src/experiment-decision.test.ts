import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_DECISION_SCHEMA_ID,
  parseExperimentDecision,
} from "./experiment.js";

function decision(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: EXPERIMENT_DECISION_SCHEMA_ID,
    id: "decision-synthetic-1",
    experimentId: "experiment-synthetic-1",
    status: "proposed",
    revision: 1,
    predecessorRevision: null,
    text: "Inspect the synthetic timeout path before changing capacity.",
    rationale: "The recorded timeout is actionable but not yet causal proof.",
    evidenceRefs: ["evidence-synthetic-timeout"],
    packageId: "package-synthetic-1",
    authorId: "actor-synthetic-reviewer",
    authorUsername: "Synthetic Reviewer",
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("experiment decision ownership and open questions", () => {
  it("normalizes legacy records to explicit unassigned ownership and no unknowns", () => {
    const parsed = parseExperimentDecision(decision());
    expect(parsed.ownerId).toBeNull();
    expect(parsed.ownerUsername).toBeNull();
    expect(parsed.remainingUnknowns).toEqual([]);
  });

  it("preserves an assigned owner and durable remaining unknowns", () => {
    const parsed = parseExperimentDecision(
      decision({
        ownerId: "actor-synthetic-owner",
        ownerUsername: "Synthetic Owner",
        remainingUnknowns: [
          "Does the timeout reproduce after the synthetic cache is warmed?",
          "Which bounded trace would disconfirm the queue hypothesis?",
        ],
      }),
    );
    expect(parsed.ownerUsername).toBe("Synthetic Owner");
    expect(parsed.remainingUnknowns).toHaveLength(2);
  });

  it("fails closed on partial owner identity and duplicate open questions", () => {
    expect(() =>
      parseExperimentDecision(decision({ ownerId: "actor-synthetic-owner" })),
    ).toThrow(/both be assigned or both be null/);
    expect(() =>
      parseExperimentDecision(
        decision({
          ownerId: null,
          ownerUsername: null,
          remainingUnknowns: ["Synthetic question?", "Synthetic question?"],
        }),
      ),
    ).toThrow(/must be unique/);
  });
});
