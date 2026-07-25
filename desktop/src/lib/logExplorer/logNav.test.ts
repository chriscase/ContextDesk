import { describe, expect, it } from "vitest";
import { applyLogNav, extractLogNavFromText, parseLogNav } from "./logNav";
import { emptyFilters } from "./types";

describe("logNav", () => {
  it("parses and applies opt-in filters", () => {
    const action = parseLogNav({
      type: "log_nav",
      corpusId: "c1",
      sources: ["api.log"],
      tsFrom: 100,
      highlightSeq: [3, 4],
      label: "auth",
    });
    expect(action).not.toBeNull();
    const current = emptyFilters();
    current.levels = ["info"];
    const applied = applyLogNav(current, action!, "c1");
    expect(applied.corpusMatch).toBe(true);
    expect(applied.filters.sources).toEqual(["api.log"]);
    expect(applied.filters.levels).toEqual(["info"]);
    expect(applied.highlightSeq).toEqual([3, 4]);

    const wrong = applyLogNav(current, action!, "other");
    expect(wrong.corpusMatch).toBe(false);
    expect(wrong.filters.sources).toEqual([]);
  });

  it("extracts chips from assistant text", () => {
    const text =
      'See {"type":"log_nav","corpusId":"x","sources":["a.log"],"label":"A"} for details';
    const navs = extractLogNavFromText(text);
    expect(navs).toHaveLength(1);
    expect(navs[0]!.corpusId).toBe("x");
  });

  it("applies levels, time window, and focusLane", () => {
    const action = parseLogNav({
      type: "log_nav",
      corpusId: "c1",
      levels: ["error"],
      tsFrom: 50,
      tsTo: 200,
      focusLane: "lane-1",
      highlightSeq: [9],
    });
    expect(action).not.toBeNull();
    const applied = applyLogNav(emptyFilters(), action!, "c1");
    expect(applied.filters.levels).toEqual(["error"]);
    expect(applied.filters.timeFrom).toBe(50);
    expect(applied.filters.timeTo).toBe(200);
    expect(applied.focusLane).toBe("lane-1");
    expect(applied.highlightSeq).toEqual([9]);
  });
});
