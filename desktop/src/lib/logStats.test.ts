import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatReduction,
  levelEntries,
  statsBlurb,
} from "./logStats";

describe("logStats", () => {
  it("formats reduction and bytes", () => {
    expect(formatReduction(353.2)).toBe("353.2×");
    expect(formatBytes(1500)).toContain("KB");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("builds seed blurb from full report shape", () => {
    const blurb = statsBlurb({
      lines: 120_000,
      templates: 340,
      reductionRatio: 353.0,
    });
    expect(blurb).toContain("120,000");
    expect(blurb).toContain("340");
    expect(blurb).toContain("353.0×");
  });

  it("sorts level counts", () => {
    const e = levelEntries({ error: 10, info: 100, warn: 5 });
    expect(e[0]?.level).toBe("info");
    expect(e[1]?.level).toBe("error");
  });
});
