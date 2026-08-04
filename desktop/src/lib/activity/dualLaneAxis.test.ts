import { describe, expect, it } from "vitest";
import {
  activityWallExtent,
  corpusHasWallClock,
  fractionWithinDomain,
  resolveDualLaneAlignment,
} from "./dualLaneAxis";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityClock,
  type ActivityEvent,
  type ClientIncidentClock,
} from "./types";

function event(clock: ActivityClock, id = "e1"): ActivityEvent {
  return {
    id,
    correlationId: "c1",
    operationId: "op",
    origin: "deterministic_host",
    determinism: determinismForOrigin("deterministic_host"),
    phase: "completed",
    status: "ok",
    clock,
    label: "Archive scanned",
    scope: { kind: "log_corpus", id: "corpus", label: "Log corpus" },
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
  };
}

const WALL_CORPUS: ClientIncidentClock = {
  tsMinMs: 1_000,
  tsMaxMs: 9_000,
  timeQuality: "wall",
};

describe("dual-lane alignment — never invent calendar time", () => {
  it("shares one axis only when BOTH groups carry wall-clock evidence", () => {
    const alignment = resolveDualLaneAlignment(WALL_CORPUS, [
      event({ kind: "wall", atMs: 5_000 }),
    ]);
    expect(alignment.kind).toBe("shared_wall_clock");
    if (alignment.kind !== "shared_wall_clock") throw new Error("unreachable");
    // The domain must cover both groups, not just the corpus.
    expect(alignment.domain).toEqual({ startMs: 1_000, endMs: 9_000 });
  });

  it("refuses a shared axis for an order-only corpus, and says why", () => {
    const alignment = resolveDualLaneAlignment(
      { tsMinMs: null, tsMaxMs: null, timeQuality: "order_only" },
      [event({ kind: "wall", atMs: 5_000 })],
    );
    expect(alignment.kind).toBe("separate_tracks");
    if (alignment.kind !== "separate_tracks") throw new Error("unreachable");
    expect(alignment.reason).toMatch(/order-only/i);
    expect(alignment.reason).toMatch(/no calendar time/i);
    // The label a reader sees must not imply wall-clock alignment.
    expect(alignment.label).toMatch(/approximate/i);
    expect(alignment.label).not.toMatch(/wall clock/i);
  });

  it("refuses a shared axis for a MIXED corpus rather than dating the rest", () => {
    // The dangerous case: some events truly have calendar time, so a naive
    // implementation would happily draw an axis and silently invent the rest.
    const alignment = resolveDualLaneAlignment(
      { tsMinMs: 1_000, tsMaxMs: 9_000, timeQuality: "mixed" },
      [event({ kind: "wall", atMs: 5_000 })],
    );
    expect(alignment.kind).toBe("separate_tracks");
    if (alignment.kind !== "separate_tracks") throw new Error("unreachable");
    expect(alignment.reason).toMatch(/invented dates/i);
  });

  it("refuses a shared axis when ANY activity event lacks calendar time", () => {
    // Even one sequence-only event poisons the shared axis: placing it would
    // require choosing a date nobody measured.
    const alignment = resolveDualLaneAlignment(WALL_CORPUS, [
      event({ kind: "wall", atMs: 2_000 }, "a"),
      event({ kind: "sequence", seq: 0 }, "b"),
    ]);
    expect(alignment.kind).toBe("separate_tracks");
    if (alignment.kind !== "separate_tracks") throw new Error("unreachable");
    expect(alignment.reason).toMatch(/order or elapsed time only/i);
  });

  it("treats elapsed-only activity as unplaceable too", () => {
    const alignment = resolveDualLaneAlignment(WALL_CORPUS, [
      event({ kind: "elapsed", elapsedMs: 120 }),
    ]);
    expect(alignment.kind).toBe("separate_tracks");
  });

  it("says the corpus has no range rather than pretending it does", () => {
    const alignment = resolveDualLaneAlignment(
      { tsMinMs: null, tsMaxMs: null, timeQuality: "wall" },
      [event({ kind: "wall", atMs: 1 })],
    );
    expect(alignment.kind).toBe("separate_tracks");
    expect(corpusHasWallClock({
      tsMinMs: null,
      tsMaxMs: null,
      timeQuality: "wall",
    })).toBe(false);
  });

  it("reports no extent for an empty or partially-dated activity set", () => {
    expect(activityWallExtent([])).toBeNull();
    expect(
      activityWallExtent([
        event({ kind: "wall", atMs: 4 }, "a"),
        event({ kind: "elapsed", elapsedMs: 4 }, "b"),
      ]),
    ).toBeNull();
    expect(
      activityWallExtent([
        event({ kind: "wall", atMs: 4 }, "a"),
        event({ kind: "wall", atMs: 40 }, "b"),
      ]),
    ).toEqual({ startMs: 4, endMs: 40 });
  });
});

describe("fractionWithinDomain", () => {
  it("maps an instant into 0..1 and clamps outliers", () => {
    const domain = { startMs: 0, endMs: 100 };
    expect(fractionWithinDomain(50, domain)).toBe(0.5);
    expect(fractionWithinDomain(-10, domain)).toBe(0);
    expect(fractionWithinDomain(999, domain)).toBe(1);
  });

  it("returns null for a zero-width domain instead of NaN", () => {
    // Every event at the same millisecond is a real case; dividing by zero
    // here would render `left: NaN%` and collapse the whole track.
    expect(fractionWithinDomain(5, { startMs: 5, endMs: 5 })).toBeNull();
  });
});
