import { describe, expect, it } from "vitest";
import { groupRepeatedActivity, repeatLabel, type GroupableActivity } from "./activity-grouping.js";

function row(overrides: Partial<GroupableActivity> = {}): GroupableActivity {
  return {
    activityId: overrides.activityId ?? "a1",
    occurredAt: overrides.occurredAt ?? "2026-08-24T12:00:00.000Z",
    actorLabel: overrides.actorLabel ?? "alice",
    investigationId: overrides.investigationId ?? "case-1",
    summary: overrides.summary ?? "imported analysis was recorded",
    resolvedRoute: overrides.resolvedRoute ?? "/investigations/case-1/analyze?item=run-1",
    provenanceClass: overrides.provenanceClass ?? "ai_generated",
    ...(overrides.activityKind !== undefined ? { activityKind: overrides.activityKind } : { activityKind: "import_recorded" }),
  };
}

describe("groupRepeatedActivity", () => {
  it("collapses repeated entries about one record into a single stated group", () => {
    const grouped = groupRepeatedActivity([
      row({ activityId: "a3", occurredAt: "2026-08-24T12:02:00.000Z" }),
      row({ activityId: "a2", occurredAt: "2026-08-24T12:01:00.000Z" }),
      row({ activityId: "a1", occurredAt: "2026-08-24T12:00:00.000Z" }),
    ]);
    expect(grouped).toHaveLength(1);
    // The newest row represents the group, so the link opens the latest.
    expect(grouped[0]!.activityId).toBe("a3");
    expect(grouped[0]!.repeatCount).toBe(3);
    expect(grouped[0]!.earliestOccurredAt).toBe("2026-08-24T12:00:00.000Z");
    expect(repeatLabel(grouped[0]!)).toBe("recorded 3 times");
  });

  it("says nothing about repeats when a record was written once", () => {
    const grouped = groupRepeatedActivity([row()]);
    expect(grouped[0]!.repeatCount).toBe(1);
    expect(grouped[0]!.earliestOccurredAt).toBeNull();
    expect(repeatLabel(grouped[0]!)).toBeNull();
  });

  it("keeps genuinely different work apart", () => {
    // Each of these differs from the baseline on exactly one thing that makes
    // it a different piece of work, and none of them may be folded together.
    const distinct = [
      row(),
      row({ summary: "reviewed imported analysis" }),
      row({ resolvedRoute: "/investigations/case-1/analyze?item=run-2" }),
      row({ actorLabel: "bob" }),
      row({ provenanceClass: "human" }),
      row({ activityKind: "comparison_unknown" }),
      row({ investigationId: "case-2" }),
    ];
    expect(groupRepeatedActivity(distinct)).toHaveLength(distinct.length);
  });

  it("preserves feed order and never reorders around a group", () => {
    const grouped = groupRepeatedActivity([
      row({ activityId: "import-new", occurredAt: "2026-08-24T12:05:00.000Z" }),
      row({ activityId: "freeze", summary: "froze an evidence snapshot", activityKind: "evidence_frozen" }),
      row({ activityId: "import-old", occurredAt: "2026-08-24T12:00:00.000Z" }),
    ]);
    expect(grouped.map((item) => item.activityId)).toEqual(["import-new", "freeze"]);
    expect(grouped[0]!.repeatCount).toBe(2);
  });

  it("takes the earliest stamp even if the input is not perfectly ordered", () => {
    const grouped = groupRepeatedActivity([
      row({ activityId: "a1", occurredAt: "2026-08-24T12:00:00.000Z" }),
      row({ activityId: "a2", occurredAt: "2026-08-24T12:09:00.000Z" }),
      row({ activityId: "a3", occurredAt: "2026-08-23T08:00:00.000Z" }),
    ]);
    expect(grouped[0]!.earliestOccurredAt).toBe("2026-08-23T08:00:00.000Z");
  });

  it("returns nothing for an empty feed", () => {
    expect(groupRepeatedActivity([])).toEqual([]);
  });
});
