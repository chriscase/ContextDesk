import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { CASE_STATUSES } from "./case.js";
import {
  RESOLUTION_BASES,
  RESOLUTION_LIST_SCHEMA_ID,
  RESOLUTION_SCHEMA_ID,
  STATUSES_REQUIRING_RESOLUTION,
  activeResolution,
  normalizeRationale,
  normalizeUnknowns,
  parseInvestigationResolution,
  parseInvestigationResolutionList,
  statusRequiresResolution,
} from "./investigation-resolution.js";

const Ajv2020 = (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(here, "..", dir, name), "utf8")) as unknown;

function validator(schemaName: string) {
  const AjvCtor = Ajv2020 as unknown as new (opts: object) => {
    compile: (schema: object) => (data: unknown) => boolean;
  };
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  return ajv.compile(load("schemas", schemaName) as object);
}

const humanOnly = () =>
  load("fixtures", "investigation-resolution.human-only.json") as Record<string, unknown>;

describe("human-only resolution is first class", () => {
  it("accepts a resolution reached with no experiment and no model run", () => {
    const fixture = humanOnly();
    const parsed = parseInvestigationResolution(fixture);
    expect(parsed.schemaId).toBe(RESOLUTION_SCHEMA_ID);
    expect(parsed.basis).toBe("human_only");
    expect(parsed.experimentDecisionId).toBeNull();
    expect(validator("investigation-resolution.v1.json")(fixture)).toBe(true);
  });

  it("records what stayed unknown rather than implying the question closed", () => {
    expect(parseInvestigationResolution(humanOnly()).unknowns).toHaveLength(2);
  });

  it("offers three bases, one of which is an explicit reasoned exception", () => {
    expect([...RESOLUTION_BASES]).toEqual([
      "human_only",
      "experiment_decision",
      "reasoned_exception",
    ]);
    const exception = load("fixtures", "investigation-resolution.reasoned-exception.json");
    const parsed = parseInvestigationResolution(exception);
    expect(parsed.basis).toBe("reasoned_exception");
    expect(parsed.exceptionReason).toContain("Duplicate");
    expect(validator("investigation-resolution.v1.json")(exception)).toBe(true);
  });
});

describe("a resolution means exactly one thing", () => {
  it("requires a stated reason in every basis", () => {
    expect(() => parseInvestigationResolution({ ...humanOnly(), rationale: "   " })).toThrow();
    expect(() => normalizeRationale("")).toThrow(/must record why/);
    expect(normalizeRationale("  because  ")).toBe("because");
  });

  it("refuses human_only reasoning that cites an experiment decision", () => {
    expect(() =>
      parseInvestigationResolution({
        ...humanOnly(),
        experimentDecisionId: "3d2c1b0a-9887-4766-a554-433221100fee",
      }),
    ).toThrow(/must not cite an experiment decision/);
  });

  it("refuses an experiment_decision basis with no decision named", () => {
    expect(() =>
      parseInvestigationResolution({ ...humanOnly(), basis: "experiment_decision" }),
    ).toThrow(/must name the accepted decision/);
  });

  it("refuses a reasoned exception that does not say what the exception is", () => {
    expect(() =>
      parseInvestigationResolution({ ...humanOnly(), basis: "reasoned_exception" }),
    ).toThrow(/must say what the exception is/);
  });

  it("refuses human_only reasoning labelled ai_generated", () => {
    expect(() =>
      parseInvestigationResolution({ ...humanOnly(), provenance: "ai_generated" }),
    ).toThrow(/cannot claim ai_generated/);
  });

  it("keeps a resolution out of the evidence graph", () => {
    const parsed = parseInvestigationResolution(humanOnly()) as unknown as Record<string, unknown>;
    // Citing is by identity only: no body, hash, or hypothesis link travels here.
    for (const forbidden of ["body", "contentHash", "hypothesisStatus", "hypothesisLinks"]) {
      expect(Object.prototype.hasOwnProperty.call(parsed, forbidden)).toBe(false);
    }
    expect(Array.isArray(parsed.citedArtifactIds)).toBe(true);
  });
});

describe("only conclusive statuses are guarded", () => {
  it("guards resolved and leaves monitoring, archived, and open alone", () => {
    expect([...STATUSES_REQUIRING_RESOLUTION]).toEqual(["resolved"]);
    for (const status of CASE_STATUSES) {
      expect(statusRequiresResolution(status)).toBe(status === "resolved");
    }
  });

  it("refuses a resolution record that claims to authorise an unguarded status", () => {
    expect(() => parseInvestigationResolution({ ...humanOnly(), status: "monitoring" })).toThrow(
      /only authorises resolved/,
    );
  });
});

describe("revision guard", () => {
  it("requires a 1-based chain with no gaps", () => {
    expect(() =>
      parseInvestigationResolution({ ...humanOnly(), revision: 1, predecessorRevision: 1 }),
    ).toThrow(/no predecessor/);
    expect(() =>
      parseInvestigationResolution({ ...humanOnly(), revision: 3, predecessorRevision: 1 }),
    ).toThrow(/immediately before it/);
    expect(() => parseInvestigationResolution({ ...humanOnly(), revision: 0 })).toThrow();
  });

  it("orders a list newest first and keeps the head unsuperseded", () => {
    const first = { ...humanOnly(), supersededAt: "2026-08-25T15:11:00.000Z" };
    const second = load("fixtures", "investigation-resolution.reasoned-exception.json");
    const list = parseInvestigationResolutionList({
      schemaId: RESOLUTION_LIST_SCHEMA_ID,
      investigationId: "11111111-1111-4111-8111-111111111111",
      resolutions: [second, first],
    });
    expect(list.resolutions[0]?.revision).toBe(2);
    expect(activeResolution(list.resolutions)?.revision).toBe(2);
    // The superseded reasoning is preserved, not overwritten.
    expect(list.resolutions[1]?.rationale).toContain("scheduled batch");

    expect(() =>
      parseInvestigationResolutionList({
        schemaId: RESOLUTION_LIST_SCHEMA_ID,
        investigationId: "11111111-1111-4111-8111-111111111111",
        resolutions: [first, second],
      }),
    ).toThrow(/newest revision first/);
  });

  it("reports no active resolution for an empty history", () => {
    expect(activeResolution([])).toBeNull();
  });
});

describe("resolution occurrence", () => {
  it("keeps the human-stated date literal and the recording clock separate", () => {
    const parsed = parseInvestigationResolution(humanOnly());
    expect(parsed.occurredAt).toBe("2024-11-04");
    expect(parsed.occurredAtZone).toBe("unspecified");
    expect(parsed.recordedAt).toBe("2026-08-25T14:02:00.000Z");
  });

  it("bounds and cleans the unknowns list", () => {
    expect(normalizeUnknowns(["  a  ", "", "b"])).toEqual(["a", "b"]);
    expect(normalizeUnknowns(null)).toEqual([]);
    expect(() => normalizeUnknowns(new Array(51).fill("x"))).toThrow(/at most 50/);
  });
});
