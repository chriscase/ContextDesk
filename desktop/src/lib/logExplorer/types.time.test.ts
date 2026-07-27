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

  it("includes year across years and preserves available subsecond precision", () => {
    const crossYear = formatEventTime(day, "wall", {
      minTs: day,
      maxTs: day + 370 * 86_400,
    });
    expect(crossYear).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);

    const fractional = formatEventTime(day + 0.125, "wall", {
      minTs: day,
      maxTs: sameDayLater,
    });
    expect(fractional).toMatch(/^\d{2}:\d{2}:\d{2}\.125Z$/);
    expect(formatEventTimeTitle(day + 0.125, "wall")).toContain(".125Z");
  });

  it("marks mixed wall-like values as approximate and rejects invalid values", () => {
    expect(
      formatEventTime(day, "mixed", { minTs: day, maxTs: sameDayLater }),
    ).toMatch(/^~/);
    expect(formatEventTimeTitle(day, "mixed")).toContain("mixed time quality");
    expect(formatEventTime(Number.NaN, "wall")).toBe("invalid time");
    expect(formatEventTimeTitle(Number.NaN, "wall")).toContain("invalid");
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
