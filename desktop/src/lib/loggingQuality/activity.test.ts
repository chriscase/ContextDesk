import { describe, expect, it } from "vitest";
import {
  loggingQualityActivityEvent,
  sanitizeAssessmentErrorMessage,
} from "./activity";

describe("logging quality activity", () => {
  it("emits metadata-only start/facts/terminal events", () => {
    const started = loggingQualityActivityEvent({
      corpusId: "c1",
      correlationId: "corr",
      phase: "started",
    });
    expect(started.label).toMatch(/started/i);
    expect(started.privacy).toBe("metadata");
    expect(started.detail).toMatch(/deterministic/);
    expect(JSON.stringify(started)).not.toMatch(/\/Users\//i);

    const facts = loggingQualityActivityEvent({
      corpusId: "c1",
      correlationId: "corr",
      phase: "facts_gathered",
      findingCount: 3,
      overallScore: 70,
    });
    expect(facts.phase).toBe("progress");
    expect(facts.detail).toMatch(/3 finding/);
  });

  it("sanitizes host errors before Activity detail", () => {
    const cleaned = sanitizeAssessmentErrorMessage(
      "failed opening /Users/chris/secret/logs and Bearer sk-abc",
    );
    expect(cleaned).not.toMatch(/\/Users\/chris/);
    expect(cleaned).not.toMatch(/sk-abc/);
    expect(cleaned).toMatch(/\[path\]|\[redacted\]/);
  });
});
