import { describe, expect, it } from "vitest";
import {
  findingIsAggregateOnly,
  MAX_EVIDENCE_LANES,
  planShowInExplorer,
} from "./evidenceBridge";
import type { LoggingQualityFinding } from "./types";

function finding(
  evidence: LoggingQualityFinding["evidence"],
): LoggingQualityFinding {
  return {
    id: "test.finding",
    severity: "medium",
    priority: 50,
    category: "timestamp_certainty",
    title: "Test",
    measuredFact: "fact",
    finding: "finding",
    improvementHint: {
      templateId: "hint.test",
      change: "change",
      acceptanceCriteria: ["criterion"],
    },
    evidence,
    confidence: "high",
    limitations: ["limit"],
  };
}

describe("planShowInExplorer", () => {
  it("fails closed when more than 4 portable sources would be required", () => {
    const map: Record<string, string> = {};
    const evidence = [];
    for (let i = 1; i <= 5; i += 1) {
      const key = `src_000${i}`;
      map[key] = `svc/app${i}.log`;
      evidence.push({
        kind: "source_aggregate" as const,
        key,
        label: key,
      });
    }
    const plan = planShowInExplorer(finding(evidence), map);
    expect(plan.kind).toBe("fail_closed");
    if (plan.kind === "fail_closed") {
      expect(plan.reason).toMatch(/limited to 4/);
    }
  });

  it("maps up to 4 sources into lanes without inventing events", () => {
    const plan = planShowInExplorer(
      finding([
        {
          kind: "source_aggregate",
          key: "src_0001",
          label: "weak source",
        },
        {
          kind: "template",
          key: "template_id:42",
          value: 300,
          label: "template 42",
        },
      ]),
      { src_0001: "api/app.jsonl" },
    );
    expect(plan.kind).toBe("lanes");
    if (plan.kind === "lanes") {
      expect(plan.lanes).toHaveLength(1);
      expect(plan.lanes[0]!.sources).toEqual(["api/app.jsonl"]);
      expect(plan.templateIds).toEqual([42]);
      expect(plan.note).toMatch(/no event citations/i);
    }
  });

  it("treats corpus_metric-only findings as aggregate-only", () => {
    const f = finding([
      {
        kind: "corpus_metric",
        key: "metrics.timeQuality",
        label: "time quality",
      },
    ]);
    expect(findingIsAggregateOnly(f.evidence)).toBe(true);
    const plan = planShowInExplorer(f, {});
    expect(plan.kind).toBe("aggregate_only");
    if (plan.kind === "aggregate_only") {
      expect(plan.reason).toMatch(/aggregate/i);
      expect(plan.openCorpus).toBe(true);
    }
  });

  it("rejects absolute paths in the source map", () => {
    const plan = planShowInExplorer(
      finding([
        {
          kind: "source_aggregate",
          key: "src_0001",
          label: "bad",
        },
      ]),
      { src_0001: "/Users/me/private.log" },
    );
    expect(plan.kind).toBe("aggregate_only");
  });

  it("documents the lane cap constant", () => {
    expect(MAX_EVIDENCE_LANES).toBe(4);
  });
});
