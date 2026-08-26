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

describe("focusArrivalCopy and a record that is not on the page", () => {
  const importedRun = {
    section: "triage-evidence-board",
    item: "run-77",
    itemKind: null,
    lane: null,
    experiment: null,
  } as const;

  it("never reports opening a record the surface does not show", () => {
    // The reported failure: an imported analysis addressed the evidence board,
    // which does not render imported runs, and the page announced success over
    // a board that did not contain it.
    const copy = focusArrivalCopy(importedRun, "absent");
    expect(copy).toBe(
      "Opened the evidence board, but the record this activity named is not shown here.",
    );
    expect(copy).not.toMatch(/to the recorded item/);
  });

  it("states only the surface while the record is still being looked for", () => {
    // The surface did open, so that is said. The record is not claimed until
    // it is there, so this sentence only gains detail — it is never
    // contradicted by the one that replaces it.
    const copy = focusArrivalCopy(importedRun, "pending");
    expect(copy).toBe("Opened the evidence board.");
    expect(copy).not.toMatch(/to the recorded item/);
  });

  it("makes the claim once the record is actually present", () => {
    expect(focusArrivalCopy(importedRun, "exact")).toBe(
      "Opened the evidence board to the recorded item this activity named.",
    );
  });

  it("keeps section-only arrivals unchanged, since they claim no record", () => {
    const sectionOnly = {
      section: "export-heading",
      item: null,
      itemKind: null,
      lane: null,
      experiment: null,
    } as const;
    expect(focusArrivalCopy(sectionOnly, "none")).toMatch(/Opened export review because/);
    // An address naming no record cannot report a missing one.
    expect(focusArrivalCopy(sectionOnly, "absent")).toMatch(/Opened export review because/);
  });

  it("still says something truthful for a surface it has no name for", () => {
    const unknown = {
      section: "some-unnamed-section",
      item: "thing-1",
      itemKind: null,
      lane: null,
      experiment: null,
    } as const;
    expect(focusArrivalCopy(unknown, "absent")).toBe(
      "This activity named a record that is not shown here.",
    );
  });

  it("reports absence for every named surface without ever implying success", () => {
    const sections = [
      "discussion",
      "workstreams",
      "triage-lane-runner",
      "triage-evidence-board",
      "triage-capture",
      "corpus-intake",
      "cross-exam-heading",
      "triage-comparison-lab",
      "decision-heading",
      "export-heading",
      "stage-situation",
    ];
    for (const section of sections) {
      const copy = focusArrivalCopy(
        { section, item: "thing-1", itemKind: null, lane: null, experiment: null },
        "absent",
      );
      expect(copy, section).toMatch(/is not shown here\.$/);
      expect(copy, section).not.toMatch(/Opened .* to the/);
    }
  });
});
