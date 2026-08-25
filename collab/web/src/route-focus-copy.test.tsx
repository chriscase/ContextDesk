import { describe, expect, it } from "vitest";
import { focusArrivalCopy } from "./route-focus-copy.js";

describe("focusArrivalCopy", () => {
  it("explains Discussion and workstream arrivals without exposing identifiers", () => {
    expect(focusArrivalCopy({
      section: "discussion",
      item: "message-8",
      itemKind: "comment",
      lane: null,
      experiment: null,
    })).toMatch(/Opened Discussion to the comment/);
    expect(focusArrivalCopy({
      section: "case-discussion",
      item: "message-8",
      itemKind: "comment",
      lane: null,
      experiment: null,
    })).toMatch(/Opened Discussion/);
    expect(focusArrivalCopy({
      section: "workstreams",
      item: "run-1:reviewer-lane",
      itemKind: "workstream",
      lane: "run-1:reviewer-lane",
      experiment: null,
    })).toMatch(/Opened this workstream record/);
    expect(focusArrivalCopy({
      section: "triage-lane-runner",
      item: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      itemKind: "triage-run",
      lane: null,
      experiment: null,
    })).toMatch(/Opened the workstream run/);
    const copy = focusArrivalCopy({
      section: "triage-lane-runner",
      item: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      itemKind: "triage-run",
      lane: null,
      experiment: null,
    });
    expect(copy).not.toMatch(/ffffffff/);
    expect(copy).not.toMatch(/package/i);
  });
});
