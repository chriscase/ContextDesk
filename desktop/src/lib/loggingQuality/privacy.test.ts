import { describe, expect, it } from "vitest";
import {
  assessmentUiStringsArePrivate,
  collectAssessmentDisplayStrings,
  findAssessmentPrivacyLeak,
} from "./privacy";
import type { LoggingQualityAssessment } from "./types";

function minimalAssessment(
  over: Partial<LoggingQualityAssessment> = {},
): LoggingQualityAssessment {
  return {
    schemaId: "contextdesk.logging_quality_assessment.v1",
    schemaVersion: 1,
    privacy: {
      redactionMode: "public_safe_default",
      policySummary: "safe summary",
      sourcesTruncated: false,
      inventoryCapped: false,
    },
    corpus: {
      id: "c1",
      name: "demo",
      eventCount: 10,
      templateCount: 2,
      partial: false,
    },
    summary: {
      overallScore: 70,
      grade: "good",
      headline: "Mostly healthy timestamps",
      dimensions: [
        {
          id: "time",
          label: "Time",
          score: 80,
          weightBps: 4000,
          measuredFact: "wall share high",
        },
      ],
    },
    metrics: {
      timeQuality: "wall",
      timestampProvenanceCounts: {},
      activeTimestampBasisCounts: {},
      wallEventCount: 10,
      orderOnlyEventCount: 0,
      unresolvedLocalEventCount: 0,
      selection: {
        selectedImported: 1,
        discovered: 1,
        ignored: 0,
        unsupported: 0,
        excludedPolicy: 0,
        failed: 0,
        partial: false,
        exclusionReasonCounts: {},
        availabilityNote: "selection note",
      },
      templates: {
        templateCount: 2,
        eventCount: 10,
        reductionRatio: 5,
        topTemplateShareBps: 5000,
        concentrationHhiBps: 2500,
        topTemplateErrorOrFatalCount: 0,
        topTemplates: [],
        proposalNote: "review signal, not verified noise",
      },
      storedLevel: {
        levelCounts: { info: 10 },
        knownLevelCount: 10,
        unknownLevelCount: 0,
        knownLevelShareBps: 10000,
        severityProvenanceAvailable: false,
        honestyNote: "stored level is not severity provenance",
      },
      traceId: {
        withTraceId: 0,
        traceIdShareBps: 0,
        availabilityNote: "trace_id only",
      },
      formatCounts: {},
    },
    sources: [],
    findings: [],
    confidence: {
      level: "high",
      summary: "deterministic",
      nonClaims: ["not root cause"],
    },
    limitations: ["no severity provenance"],
    ...over,
  };
}

describe("assessment privacy scan", () => {
  it("flags absolute user paths and credential shapes", () => {
    expect(findAssessmentPrivacyLeak("see /Users/chris/secret.log")).toBeTruthy();
    expect(findAssessmentPrivacyLeak("Authorization: Bearer abc")).toBeTruthy();
    expect(findAssessmentPrivacyLeak("api_key=sk-test")).toBeTruthy();
    expect(findAssessmentPrivacyLeak("api/app.jsonl")).toBeNull();
  });

  it("accepts a clean assessment DTO", () => {
    const a = minimalAssessment();
    expect(
      assessmentUiStringsArePrivate(collectAssessmentDisplayStrings(a)),
    ).toBe(true);
  });

  it("rejects findings that smuggle path-like text", () => {
    const a = minimalAssessment({
      findings: [
        {
          id: "leak",
          severity: "low",
          priority: 1,
          category: "corpus",
          title: "Leak",
          measuredFact: "x",
          finding: "Look at /Users/private/logs",
          improvementHint: {
            templateId: "h",
            change: "fix",
            acceptanceCriteria: ["a"],
          },
          evidence: [],
          confidence: "low",
          limitations: [],
        },
      ],
    });
    expect(
      assessmentUiStringsArePrivate(collectAssessmentDisplayStrings(a)),
    ).toBe(false);
  });
});
