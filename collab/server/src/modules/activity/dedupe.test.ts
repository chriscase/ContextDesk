import { describe, expect, it } from "vitest";
import { dedupeProjectedActivity } from "./project.js";
import type { ProjectedInvestigationActivity } from "./project.js";

/**
 * One committed action can reach the timeline as more than one event, and an
 * exact portable restore replays history beside the original. Projected
 * one-for-one those become separate rows, so a single import reads as two
 * pieces of work and a successful restore floods Latest activity with events
 * that already happened.
 */

type Overrides = Partial<{
  timelineKind: string;
  activityId: string;
  investigationId: string;
  activityKind: string;
  summary: string;
  resolvedRoute: string;
  occurredAt: string;
  actorId: string;
  provenanceClass: string;
  revision: number | null;
  orderTieBreak: number;
  intakeBatchId: string | null;
}>;

function row(overrides: Overrides = {}): ProjectedInvestigationActivity {
  const item = {
    activityId: overrides.activityId ?? "act-1",
    investigationId: overrides.investigationId ?? "case-1",
    activityKind: overrides.activityKind ?? "comparison_unknown",
    summary: overrides.summary ?? "recorded a comparison observation",
    resolvedRoute: overrides.resolvedRoute ?? "/investigations/case-1/compare",
    occurredAt: overrides.occurredAt ?? "2026-08-24T09:00:00.000Z",
    actorId: overrides.actorId ?? "alice",
    provenanceClass: overrides.provenanceClass ?? "human",
    revision: overrides.revision ?? null,
    orderTieBreak: overrides.orderTieBreak ?? 1,
  };
  return {
    item,
    assignedActorIds: [],
    workstreamId: null,
    stage: "compare",
    timelineKind: overrides.timelineKind ?? "experiment_observation_recorded",
    intakeBatchId: overrides.intakeBatchId ?? null,
  } as unknown as ProjectedInvestigationActivity;
}

describe("dedupeProjectedActivity", () => {
  it("keeps one row when two events describe the same recorded work", () => {
    // One import writes its own event and a generic one alongside it.
    const kept = dedupeProjectedActivity([
      row({ activityId: "act-specific", orderTieBreak: 7, timelineKind: "import_recorded" }),
      row({ activityId: "act-generic", orderTieBreak: 8, timelineKind: "case_updated" }),
    ]);
    expect(kept).toHaveLength(1);
    // The first in the given order survives, so ordering and any cursor built
    // from this list stay stable.
    expect(kept[0]!.item.activityId).toBe("act-specific");
  });

  it("keeps every row of an action that really did happen more than once", () => {
    // Four situation updates in a row are four pieces of work, even though a
    // reader cannot tell them apart: they share one timeline event kind.
    const kept = dedupeProjectedActivity(
      [1, 2, 3, 4].map((seq) =>
        row({
          activityId: `act-${seq}`,
          orderTieBreak: seq,
          timelineKind: "case_situation_updated",
        }),
      ),
    );
    expect(kept).toHaveLength(4);
  });

  it("represents one committed corpus upload once while preserving its per-file audit rows", () => {
    const kept = dedupeProjectedActivity([
      row({
        activityId: "batch",
        timelineKind: "corpus_intake_committed",
        activityKind: "import_recorded",
        summary: "committed a log intake batch",
        resolvedRoute: "/investigations/case-1/capture?item=batch-1",
        orderTieBreak: 4,
        intakeBatchId: "batch-1",
      }),
      ...[1, 2, 3].map((seq) => row({
        activityId: `evidence-${seq}`,
        timelineKind: "evidence_registered",
        activityKind: "evidence_added",
        summary: "added evidence",
        resolvedRoute: `/investigations/case-1/analyze?item=evidence-${seq}`,
        orderTieBreak: seq,
        intakeBatchId: "batch-1",
      })),
      row({
        activityId: "manual-evidence",
        timelineKind: "evidence_registered",
        activityKind: "evidence_added",
        summary: "added evidence",
        resolvedRoute: "/investigations/case-1/analyze?item=manual-evidence",
        orderTieBreak: 0,
      }),
    ]);

    expect(kept.map((entry) => entry.item.activityId)).toEqual(["batch", "manual-evidence"]);
  });

  it("keeps corpus file activity when its batch event is not in the authorized projection", () => {
    const kept = dedupeProjectedActivity([
      row({
        activityId: "evidence-1",
        timelineKind: "evidence_registered",
        activityKind: "evidence_added",
        intakeBatchId: "batch-filtered-out",
      }),
    ]);
    expect(kept).toHaveLength(1);
  });

  it("keeps the same action repeated at a different time", () => {
    const kept = dedupeProjectedActivity([
      row({ activityId: "act-1", occurredAt: "2026-08-24T09:00:00.000Z" }),
      row({ activityId: "act-2", occurredAt: "2026-08-24T11:30:00.000Z" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps the same action taken by two different people", () => {
    const kept = dedupeProjectedActivity([
      row({ activityId: "act-1", actorId: "alice" }),
      row({ activityId: "act-2", actorId: "erin" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps rows that point at different records", () => {
    const kept = dedupeProjectedActivity([
      row({ activityId: "act-1", resolvedRoute: "/investigations/case-1/compare" }),
      row({ activityId: "act-2", resolvedRoute: "/investigations/case-1/decide" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps rows whose provenance differs, because the reader is told which is which", () => {
    const kept = dedupeProjectedActivity([
      row({ activityId: "act-1", provenanceClass: "human" }),
      row({ activityId: "act-2", provenanceClass: "historical_restored" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("keeps rows for different investigations and different revisions", () => {
    expect(
      dedupeProjectedActivity([
        row({ activityId: "act-1", investigationId: "case-1" }),
        row({ activityId: "act-2", investigationId: "case-2" }),
      ]),
    ).toHaveLength(2);
    expect(
      dedupeProjectedActivity([
        row({ activityId: "act-1", revision: 1 }),
        row({ activityId: "act-2", revision: 2 }),
      ]),
    ).toHaveLength(2);
  });

  it("preserves the order it was given", () => {
    const kept = dedupeProjectedActivity([
      row({ activityId: "a", occurredAt: "2026-08-24T12:00:00.000Z" }),
      row({ activityId: "b", occurredAt: "2026-08-24T11:00:00.000Z", timelineKind: "import_recorded" }),
      row({ activityId: "b-dup", occurredAt: "2026-08-24T11:00:00.000Z", timelineKind: "case_updated" }),
      row({ activityId: "c", occurredAt: "2026-08-24T10:00:00.000Z" }),
    ]);
    expect(kept.map((entry) => entry.item.activityId)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeProjectedActivity([])).toEqual([]);
  });
});
