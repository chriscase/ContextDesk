import { describe, expect, it } from "vitest";
import {
  composeHandoffBody,
  createHandoffIdempotencyKey,
  recordedHandoffText,
  selectHandoffFacts,
  selectHandoffResourceView,
  type HandoffCaseRecord,
  type HandoffContributionRecord,
  type HandoffFacts,
} from "./handoff.js";

function investigation(
  overrides: Partial<HandoffCaseRecord> = {},
): HandoffCaseRecord {
  return {
    id: "case-1",
    status: "monitoring",
    legalHold: false,
    ...overrides,
  };
}

function contribution(
  overrides: Partial<HandoffContributionRecord> & Pick<HandoffContributionRecord, "id" | "kind">,
): HandoffContributionRecord {
  return {
    caseId: "case-1",
    revision: 1,
    body: `${overrides.kind} body`,
    tombstoned: false,
    authorUsername: "alice",
    createdAt: "2026-09-03T08:00:00.000Z",
    ...overrides,
  };
}

function expectNoInferredFields(facts: HandoffFacts): void {
  expect(facts).not.toHaveProperty("priority");
  expect(facts).not.toHaveProperty("progress");
  expect(facts).not.toHaveProperty("sla");
  expect(facts).not.toHaveProperty("owner");
  expect(facts).not.toHaveProperty("lifecycle");
  expect(facts).not.toHaveProperty("completeness");
  expect(facts).not.toHaveProperty("assignment");
  expect(Object.keys(facts).sort()).toEqual([
    "currentState",
    "liveHandoffs",
    "nextAction",
    "whatHappened",
  ]);
  if (facts.currentState !== null) {
    expect(Object.keys(facts.currentState).sort()).toEqual(["legalHold", "status"]);
  }
}

describe("handoff fact projection", () => {
  it("keeps live handoffs newest first and drops tombstones", () => {
    const facts = selectHandoffFacts(investigation(), [
      contribution({
        id: "handoff-older",
        kind: "handoff",
        createdAt: "2026-09-01T00:00:00.000Z",
        body: "Monday note",
      }),
      contribution({
        id: "handoff-tombstoned",
        kind: "handoff",
        createdAt: "2026-09-04T00:00:00.000Z",
        body: "Should not appear",
        tombstoned: true,
      }),
      contribution({
        id: "handoff-newer-rev1",
        kind: "handoff",
        createdAt: "2026-09-03T00:00:00.000Z",
        revision: 1,
        body: "Same instant, lower revision",
      }),
      contribution({
        id: "handoff-newer-rev2",
        kind: "handoff",
        createdAt: "2026-09-03T00:00:00.000Z",
        revision: 2,
        body: "Same instant, higher revision",
      }),
      contribution({
        id: "handoff-z",
        kind: "handoff",
        createdAt: "2026-09-02T00:00:00.000Z",
        body: "Tie-break id z",
      }),
      contribution({
        id: "handoff-a",
        kind: "handoff",
        createdAt: "2026-09-02T00:00:00.000Z",
        body: "Tie-break id a",
      }),
      contribution({
        id: "note-1",
        kind: "note",
        createdAt: "2026-09-05T00:00:00.000Z",
      }),
    ]);

    expect(facts.liveHandoffs.map((row) => row.id)).toEqual([
      "handoff-newer-rev2",
      "handoff-newer-rev1",
      "handoff-z",
      "handoff-a",
      "handoff-older",
    ]);
    expect(facts.liveHandoffs.some((row) => row.tombstoned)).toBe(false);
    expectNoInferredFields(facts);
  });

  it("selects the latest live note, message, or handoff as what happened", () => {
    const facts = selectHandoffFacts(investigation(), [
      contribution({
        id: "handoff-1",
        kind: "handoff",
        createdAt: "2026-09-01T00:00:00.000Z",
        body: "Earlier handoff",
      }),
      contribution({
        id: "note-tombstoned",
        kind: "note",
        createdAt: "2026-09-05T00:00:00.000Z",
        body: "Removed note",
        tombstoned: true,
      }),
      contribution({
        id: "message-1",
        kind: "message",
        createdAt: "2026-09-03T00:00:00.000Z",
        body: "Latest live narrative",
      }),
      contribution({
        id: "action-1",
        kind: "action",
        createdAt: "2026-09-04T00:00:00.000Z",
        body: "Do not treat this as what happened",
      }),
      contribution({
        id: "hypothesis-1",
        kind: "hypothesis",
        createdAt: "2026-09-06T00:00:00.000Z",
        body: "Not a narrative kind",
      }),
    ]);

    expect(facts.whatHappened?.id).toBe("message-1");
    expect(facts.whatHappened?.body).toBe("Latest live narrative");
    expect(facts.nextAction?.id).toBe("action-1");
    expectNoInferredFields(facts);
  });

  it("copies current state exactly from the case and leaves sparse values uninferred", () => {
    const sparse = selectHandoffFacts(investigation({ status: "   ", legalHold: false }), []);
    expect(sparse.currentState).toEqual({ status: "   ", legalHold: false });
    expect(recordedHandoffText(sparse.currentState?.status)).toBe("Not recorded");
    expect(sparse.whatHappened).toBeNull();
    expect(sparse.nextAction).toBeNull();
    expect(sparse.liveHandoffs).toEqual([]);
    expectNoInferredFields(sparse);

    const missing = selectHandoffFacts(null, [
      contribution({ id: "note-1", kind: "note", body: "  " }),
    ]);
    expect(missing.currentState).toBeNull();
    expect(recordedHandoffText(missing.whatHappened?.body)).toBe("Not recorded");
    expectNoInferredFields(missing);
  });

  it("labels opaque note and optional next-action text without extra schema fields", () => {
    expect(composeHandoffBody("  Queue time remains high.  ")).toBe(
      "Note: Queue time remains high.",
    );
    expect(composeHandoffBody("Queue time remains high.", "  Recheck the pool.  ")).toBe(
      "Note: Queue time remains high.\n\nNext action: Recheck the pool.",
    );
    expect(composeHandoffBody("Queue time remains high.", "")).toBe(
      "Note: Queue time remains high.",
    );
    const composed = composeHandoffBody("Observed stall.", "Page the on-call.");
    expect(composed).not.toMatch(/privacyClass|legalHold|priority|sla|owner|lifecycle|revision/i);
  });

  it("preserves previous snapshots across refresh and refresh failure", () => {
    const rows = [contribution({ id: "handoff-1", kind: "handoff" })];
    expect(selectHandoffResourceView({ status: "idle" })).toEqual({ availability: "idle" });
    expect(selectHandoffResourceView({ status: "loading" })).toEqual({ availability: "loading" });
    expect(selectHandoffResourceView({ status: "loading", previous: rows })).toEqual({
      availability: "available",
      value: rows,
      refresh: "loading",
    });
    expect(selectHandoffResourceView({ status: "ready", value: rows })).toEqual({
      availability: "available",
      value: rows,
      refresh: "settled",
    });
    expect(selectHandoffResourceView({ status: "failed", error: "contributions unavailable" })).toEqual({
      availability: "unavailable",
      error: "contributions unavailable",
    });
    expect(
      selectHandoffResourceView({
        status: "failed",
        error: "refresh failed",
        previous: rows,
      }),
    ).toEqual({
      availability: "available",
      value: rows,
      refresh: "failed",
      refreshError: "refresh failed",
    });
  });

  it("creates a bounded retry token with a test-safe fallback", () => {
    const key = createHandoffIdempotencyKey();
    expect(key).toMatch(/^[a-z0-9][a-z0-9._:-]{7,127}$/i);
    expect(key.startsWith("handoff-")).toBe(true);
    expect(createHandoffIdempotencyKey()).not.toBe(key);
  });
});
