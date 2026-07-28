import { describe, expect, it } from "vitest";
import type { InvestigationViewRecipeDto } from "../host";
import {
  captureInvestigationView,
  describeInvestigationViewDiff,
  eventRef,
} from "./investigationView";

const event = {
  seq: 7,
  ts: 1_735_732_800_000,
  timeQuality: "wall" as const,
  level: "ERROR",
  source: "api/app.jsonl",
  service: null,
  host: null,
  traceId: null,
  message: "timeout",
  templateId: 1,
};

describe("investigation view recipes", () => {
  it("captures hidden lane membership and exact payload-free identities", () => {
    const ref = eventRef("corpus-1", event);
    const recipe = captureInvestigationView({
      filters: {
        levels: ["ERROR"],
        sources: [],
        services: [],
        hosts: [],
        timeFrom: null,
        timeTo: null,
        seqFrom: null,
        seqTo: null,
        templateId: null,
        traceId: null,
        keyword: "timeout",
      },
      lanes: [
        { id: "lane-0", label: "API", sources: ["api/app.jsonl"] },
        { id: "lane-1", label: "Worker", sources: ["worker/worker.log"] },
      ],
      visibleLaneCount: 1,
      linkMode: "follow_cursor",
      focusedLaneId: "lane-0",
      focusedEvent: ref,
      selection: [ref],
      highlights: [ref],
      find: {
        query: "job-7f3a",
        matchMode: "literal",
        caseSensitive: false,
        semantic: false,
      },
      viewportAnchors: { "lane-0": ref },
    });

    expect(recipe.lanes).toHaveLength(2);
    expect(recipe.visibleLaneCount).toBe(1);
    expect(recipe.selection[0]).toEqual(ref);
    expect(JSON.stringify(recipe)).not.toContain('"message"');
    expect(recipe.filters.keyword).toBe("timeout");
  });

  it("describes only the logical state that applying a view will change", () => {
    const base: InvestigationViewRecipeDto = captureInvestigationView({
      filters: {
        levels: [],
        sources: [],
        services: [],
        hosts: [],
        timeFrom: null,
        timeTo: null,
        seqFrom: null,
        seqTo: null,
        templateId: null,
        traceId: null,
        keyword: null,
      },
      lanes: [{ id: "lane-0", label: "All sources", sources: [] }],
      visibleLaneCount: 1,
      linkMode: "independent",
      focusedLaneId: null,
      focusedEvent: null,
      selection: [],
      highlights: [],
      find: null,
      viewportAnchors: {},
    });
    const proposed = {
      ...base,
      filters: { ...base.filters, levels: ["ERROR"] },
      linkMode: "align_time" as const,
      selection: [eventRef("corpus-1", event)],
    };

    expect(describeInvestigationViewDiff(base, proposed)).toEqual([
      "Filters: All logs → levels ERROR",
      "Time linking: independent → align time",
      "Selection: 0 events → 1 event",
    ]);
    expect(describeInvestigationViewDiff(base, base)).toEqual([
      "This saved view already matches the Explorer.",
    ]);
  });
});
