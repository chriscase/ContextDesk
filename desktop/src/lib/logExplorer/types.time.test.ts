import { describe, expect, it } from "vitest";
import {
  formatCanonicalUtc,
  formatEventTime,
  formatEventTimeTitle,
} from "./types";

describe("adaptive event time (#535)", () => {
  const day = 1_735_732_900; // ~2025-01-01 UTC region for fixtures
  const sameDayLater = day + 125;

  it("shows time-of-day for single-day wall windows", () => {
    const s = formatEventTime(day, "wall", {
      minTs: day,
      maxTs: sameDayLater,
    });
    expect(s).toMatch(/^\d{2}:\d{2}:\d{2}Z$/);
    expect(s).not.toContain("2025");
  });

  it("includes date when the window spans days", () => {
    const s = formatEventTime(day, "wall", {
      minTs: day,
      maxTs: day + 86_400 * 2,
    });
    expect(s).toMatch(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/);
  });

  it("never fabricates calendar time for order-only", () => {
    expect(formatEventTime(42, "order_only")).toBe("ord 42");
    expect(formatEventTimeTitle(42, "order_only")).toContain("not calendar");
  });

  it("exposes full canonical UTC in titles", () => {
    const title = formatEventTimeTitle(day, "wall");
    expect(title).toContain(formatCanonicalUtc(day));
    expect(title).toContain("UTC");
    expect(title).toContain("wall clock");
  });
});
