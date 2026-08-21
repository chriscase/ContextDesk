import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_REPORT_SCHEMA_ID,
  parseQualificationReport,
  renderQualificationSummary,
} from "./qualification.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

describe("qualification report contract", () => {
  it("parses the valid share-safe fixture", () => {
    const report = parseQualificationReport(load("qualification-report.valid.json"));
    expect(report.schemaId).toBe(QUALIFICATION_REPORT_SCHEMA_ID);
    expect(report.liveProfiles.every((profile) => !profile.ran)).toBe(true);
    expect(renderQualificationSummary(report)).toContain("backend=memory");
  });

  it("rejects unknown fields including prompt", () => {
    expect(() => parseQualificationReport(load("qualification-report.unknown-field.json"))).toThrow(
      /unknown key/,
    );
  });

  it("refuses a live run that was not configured", () => {
    const raw = load("qualification-report.valid.json") as {
      liveProfiles: Array<{
        alias: string;
        configured: boolean;
        ran: boolean;
        skippedReason: string | null;
      }>;
    };
    raw.liveProfiles[0] = {
      alias: "gpt-oss-120b",
      configured: false,
      ran: true,
      skippedReason: null,
    };
    expect(() => parseQualificationReport(raw)).toThrow(/cannot be marked ran/);
  });
});
