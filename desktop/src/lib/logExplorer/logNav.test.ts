import { describe, expect, it } from "vitest";
import {
  applyLogNav,
  extractAndCleanLogNav,
  extractLogNavFromText,
  LOG_NAV_MAX_ACTIONS,
  LOG_NAV_MAX_PAYLOAD_BYTES,
  LOG_NAV_UNREADABLE_MESSAGE,
  parseLogNav,
} from "./logNav";
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

  it("extracts chips from assistant text (middle)", () => {
    const text =
      'See {"type":"log_nav","corpusId":"x","sources":["a.log"],"label":"A"} for details';
    const navs = extractLogNavFromText(text);
    expect(navs).toHaveLength(1);
    expect(navs[0]!.corpusId).toBe("x");
    const cleaned = extractAndCleanLogNav(text);
    expect(cleaned.displayText).toBe("See for details");
    expect(cleaned.displayText.includes("log_nav")).toBe(false);
    expect(cleaned.unreadableProposal).toBe(false);
  });

  it("extracts valid payload at beginning and end of prose", () => {
    const begin =
      '{"type":"log_nav","corpusId":"b","sources":["b.log"],"label":"Begin"} then prose.';
    const end =
      'Prose first. {"type":"log_nav","corpusId":"e","sources":["e.log"],"label":"End"}';
    const b = extractAndCleanLogNav(begin);
    expect(b.actions).toHaveLength(1);
    expect(b.actions[0]!.label).toBe("Begin");
    expect(b.displayText).toBe("then prose.");
    expect(b.displayText.includes("{")).toBe(false);

    const e = extractAndCleanLogNav(end);
    expect(e.actions).toHaveLength(1);
    expect(e.actions[0]!.label).toBe("End");
    expect(e.displayText).toBe("Prose first.");
  });

  it("handles braces and escaped quotes inside JSON strings", () => {
    const text =
      'Hint {"type":"log_nav","corpusId":"c1","sources":["a{b}.log"],"label":"Say \\"hi\\" {now}"} done';
    const cleaned = extractAndCleanLogNav(text);
    expect(cleaned.actions).toHaveLength(1);
    expect(cleaned.actions[0]!.sources).toEqual(["a{b}.log"]);
    expect(cleaned.actions[0]!.label).toBe('Say "hi" {now}');
    expect(cleaned.displayText).toBe("Hint done");
    expect(cleaned.displayText.includes("log_nav")).toBe(false);
  });

  it("accepts multiple payloads up to the action cap", () => {
    const chunks = Array.from(
      { length: LOG_NAV_MAX_ACTIONS + 2 },
      (_, i) =>
        `{"type":"log_nav","corpusId":"c","sources":["s${i}.log"],"label":"L${i}"}`,
    );
    const text = chunks.join(" and ");
    const cleaned = extractAndCleanLogNav(text);
    expect(cleaned.actions).toHaveLength(LOG_NAV_MAX_ACTIONS);
    expect(cleaned.unreadableProposal).toBe(true);
    expect(cleaned.displayText.includes("log_nav")).toBe(false);
  });

  it("flags over-limit payloads as unreadable and strips them", () => {
    const hugeLabel = "x".repeat(LOG_NAV_MAX_PAYLOAD_BYTES);
    const text = `Before {"type":"log_nav","corpusId":"c","sources":["a.log"],"label":"${hugeLabel}"} after`;
    const cleaned = extractAndCleanLogNav(text);
    expect(cleaned.actions).toHaveLength(0);
    expect(cleaned.unreadableProposal).toBe(true);
    expect(cleaned.displayText.includes("log_nav")).toBe(false);
    expect(cleaned.displayText).toContain("Before");
    expect(cleaned.displayText).toContain("after");
  });

  it("treats malformed and truncated navigation-like output as unreadable", () => {
    const truncated =
      'Working {"type":"log_nav","corpusId":"c1","sources":["a.log"';
    const t = extractAndCleanLogNav(truncated);
    expect(t.actions).toHaveLength(0);
    expect(t.unreadableProposal).toBe(true);
    expect(t.displayText.includes("log_nav")).toBe(false);

    const bad =
      'Oops {"type":"log_nav","corpusId":"c1","sources":[} leftover';
    const b = extractAndCleanLogNav(bad);
    expect(b.actions).toHaveLength(0);
    expect(b.unreadableProposal).toBe(true);
    expect(b.displayText.includes("log_nav")).toBe(false);
  });

  it("rejects nested objects (strict flat schema)", () => {
    const nested =
      '{"type":"log_nav","corpusId":"c","sources":[{"name":"a.log"}],"label":"N"}';
    expect(parseLogNav(JSON.parse(nested))).toBeNull();
    const cleaned = extractAndCleanLogNav(`Nav ${nested}`);
    expect(cleaned.actions).toHaveLength(0);
    expect(cleaned.unreadableProposal).toBe(true);
  });

  it("exposes the quiet unreadable message constant", () => {
    expect(LOG_NAV_UNREADABLE_MESSAGE).toBe(
      "Navigation proposal could not be read.",
    );
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
