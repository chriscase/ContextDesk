import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatEventsPerTemplate,
  levelEntries,
  statsBlurb,
} from "./logStats";

describe("logStats", () => {
  it("formats self-describing pattern grouping and bytes", () => {
    expect(formatEventsPerTemplate(353.2)).toBe(
      "353.2 avg. events/template",
    );
    expect(formatEventsPerTemplate(10_000)).toBe(
      "10,000 avg. events/template",
    );
    expect(formatBytes(1500)).toContain("KB");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("builds seed blurb from full report shape", () => {
    const blurb = statsBlurb({
      lines: 120_000,
      templates: 340,
      reductionRatio: 353.0,
    });
    expect(blurb).toContain(
      "120,000 events grouped into 340 learned templates",
    );
    expect(blurb).toContain("353 avg. events/template");
    expect(blurb).not.toContain("reduction");
  });

  it("does not call intentional skips a partial corpus", () => {
    const blurb = statsBlurb({
      lines: 34_211,
      templates: 419,
      reductionRatio: 81.6,
      files: 197,
      discoveredFiles: 597,
      ignoredFiles: 400,
      partial: false,
    });
    expect(blurb).toContain("400 intentionally skipped");
    expect(blurb).not.toContain("partial");
  });

  it("reserves partial wording for selected content that was omitted", () => {
    const blurb = statsBlurb({
      lines: 2,
      templates: 1,
      reductionRatio: 2,
      files: 1,
      discoveredFiles: 5,
      excludedFiles: 2,
      failedFiles: 1,
      ignoredFiles: 1,
      partial: true,
    });
    expect(blurb).toContain("partial: 2 excluded, 1 failed, 1 ignored");
  });

  it("sorts level counts", () => {
    const e = levelEntries({ error: 10, info: 100, warn: 5 });
    expect(e[0]?.level).toBe("info");
    expect(e[1]?.level).toBe("error");
  });
});
