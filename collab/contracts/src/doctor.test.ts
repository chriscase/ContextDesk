import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCTOR_REPORT_SCHEMA_ID,
  doctorExitCode,
  parseDoctorReport,
  parseProfileCatalog,
  renderDoctorSummary,
} from "./doctor.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
}

describe("doctor report contract", () => {
  it("parses the valid share-safe fixture", () => {
    const report = parseDoctorReport(load("doctor-report.valid.json"));
    expect(report.schemaId).toBe(DOCTOR_REPORT_SCHEMA_ID);
    expect(report.ok).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
    expect(renderDoctorSummary(report)).toContain("verdict ready_for_config_shape");
  });

  it("rejects unknown fields including prompt", () => {
    expect(() => parseDoctorReport(load("doctor-report.unknown-field.json"))).toThrow(/unknown key/);
  });

  it("rejects a report that claims ok while carrying errors", () => {
    const raw = load("doctor-report.valid.json") as {
      ok: boolean;
      errorCount: number;
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    raw.ok = true;
    raw.errorCount = 0;
    raw.checks[0] = { id: "node_runtime", status: "error", summary: "too old" };
    expect(() => parseDoctorReport(raw)).toThrow(/must match check statuses/);
  });
});

describe("profile catalog contract", () => {
  it("parses the valid catalog", () => {
    const catalog = parseProfileCatalog(load("profile-catalog.valid.json"));
    expect(catalog.profiles).toHaveLength(4);
  });

  it("rejects unknown fields including endpoint", () => {
    expect(() => parseProfileCatalog(load("profile-catalog.unknown-field.json"))).toThrow(
      /unknown key/,
    );
  });
});
