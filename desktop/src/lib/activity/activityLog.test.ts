import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVITY_CAP,
  MAX_ACTIVITY_DETAIL_CHARS,
  MAX_ACTIVITY_LABEL_CHARS,
  appendActivities,
  appendActivity,
  createActivityLog,
} from "./activityLog";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityEventInput,
} from "./types";

function input(label: string, detail?: string): ActivityEventInput {
  return {
    correlationId: "c1",
    operationId: "op",
    origin: "deterministic_host",
    determinism: determinismForOrigin("deterministic_host"),
    phase: "completed",
    status: "ok",
    clock: { kind: "wall", atMs: 1_000 },
    label,
    detail,
    scope: { kind: "workspace", id: null, label: "Workspace" },
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
  };
}

describe("bounded retention", () => {
  it("drops the OLDEST entries and counts them, never silently", () => {
    const log = appendActivities(
      createActivityLog(3),
      [0, 1, 2, 3, 4].map((i) => input(`step ${i}`)),
    );
    expect(log.entries).toHaveLength(3);
    expect(log.entries.map((e) => e.label)).toEqual([
      "step 2",
      "step 3",
      "step 4",
    ]);
    // The count is what lets the UI say "N earlier entries dropped".
    expect(log.omitted).toBe(2);
  });

  it("keeps ids unique across drops so React keys cannot collide", () => {
    const log = appendActivities(
      createActivityLog(2),
      [0, 1, 2, 3].map((i) => input(`step ${i}`)),
    );
    expect(new Set(log.entries.map((e) => e.id)).size).toBe(
      log.entries.length,
    );
    expect(log.nextId).toBe(5);
  });

  it("bounds label and detail text AT THE STORE, not just at render", () => {
    // A retained 2 MB string is a retention problem even if a component
    // happens to clip it visually.
    const log = appendActivity(
      createActivityLog(),
      input("L".repeat(5_000), "D".repeat(50_000)),
    );
    const entry = log.entries[0]!;
    expect(entry.label.length).toBeLessThanOrEqual(MAX_ACTIVITY_LABEL_CHARS);
    expect(entry.detail!.length).toBeLessThanOrEqual(
      MAX_ACTIVITY_DETAIL_CHARS,
    );
    // Truncation is marked, not silent.
    expect(entry.label.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched", () => {
    const entry = appendActivity(createActivityLog(), input("short", "fine"))
      .entries[0]!;
    expect(entry.label).toBe("short");
    expect(entry.detail).toBe("fine");
  });

  it("never grows past its cap however many entries arrive", () => {
    const log = appendActivities(
      createActivityLog(),
      Array.from({ length: DEFAULT_ACTIVITY_CAP + 250 }, (_, i) =>
        input(`step ${i}`),
      ),
    );
    expect(log.entries).toHaveLength(DEFAULT_ACTIVITY_CAP);
    expect(log.omitted).toBe(250);
  });

  it("treats a nonsensical cap as at least one entry", () => {
    expect(createActivityLog(0).cap).toBe(1);
    expect(createActivityLog(-5).cap).toBe(1);
  });

  it("is pure — appending returns a new state and leaves the old one alone", () => {
    const before = createActivityLog();
    const after = appendActivity(before, input("x"));
    expect(before.entries).toHaveLength(0);
    expect(after.entries).toHaveLength(1);
  });
});
