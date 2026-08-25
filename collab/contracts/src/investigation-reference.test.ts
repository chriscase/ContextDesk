import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { deriveInvestigationResourcePathname } from "./investigation-activity.js";
import {
  INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
  INVESTIGATION_REFERENCE_SCHEMA_ID,
  RESTRICTED_REFERENCE_TITLE,
  normalizeReferenceNote,
  parseInvestigationReference,
  parseInvestigationReferenceList,
  referenceLocator,
  wholeInvestigationReferenceTarget,
} from "./investigation-reference.js";

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

const CITING = "22222222-2222-4222-8222-222222222222";
const CITED = "11111111-1111-4111-8111-111111111111";

describe("cross-investigation references", () => {
  it("accepts the synthetic fixture through both the parser and the JSON Schema", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json");
    expect(parseInvestigationReference(fixture).schemaId).toBe(INVESTIGATION_REFERENCE_SCHEMA_ID);
    expect(validator("investigation-reference.v1.json")(fixture)).toBe(true);
  });

  it("derives the locator from the same builder the activity feed uses", () => {
    const target = wholeInvestigationReferenceTarget(CITED);
    expect(referenceLocator(CITED, target.resourceKind, target.resourceId)).toBe(
      deriveInvestigationResourcePathname(CITED, "investigation", CITED),
    );
    expect(referenceLocator(CITED, "evidence_item", "44444444-4444-4444-8444-444444444444")).toBe(
      deriveInvestigationResourcePathname(
        CITED,
        "evidence_item",
        "44444444-4444-4444-8444-444444444444",
      ),
    );
  });

  it("refuses a hand-written locator that does not match its target", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json") as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInvestigationReference({ ...fixture, locator: "/investigations/elsewhere" }),
    ).toThrow(/must match the derived resource destination/);
  });

  it("refuses a locator that tries to escape the investigation route", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json") as Record<
      string,
      unknown
    >;
    for (const locator of [
      "/investigations/../admin",
      "https://example.invalid/investigations/x",
      "/investigations//situation",
    ]) {
      expect(() => parseInvestigationReference({ ...fixture, locator })).toThrow();
    }
  });

  it("refuses a self-citation, which is a section link and not a reference", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json") as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInvestigationReference({
        ...fixture,
        fromInvestigationId: CITED,
        locator: referenceLocator(CITED, "investigation", CITED),
      }),
    ).toThrow(/must cite a different investigation/);
  });
});

describe("authorization is re-checked, never inherited", () => {
  it("accepts a restricted reference that withholds the cited title", () => {
    const fixture = load("fixtures", "investigation-reference.restricted.json");
    const parsed = parseInvestigationReference(fixture);
    expect(parsed.visibility).toBe("restricted");
    expect(parsed.currentTitle).toBeNull();
    // The pointer survives so the reader can request access knowingly.
    expect(parsed.locator).toContain("/investigations/");
    expect(validator("investigation-reference.v1.json")(fixture)).toBe(true);
  });

  it("refuses a restricted reference that leaks the live title anyway", () => {
    const fixture = load("fixtures", "investigation-reference.restricted.json") as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInvestigationReference({ ...fixture, currentTitle: "Synthetic restricted investigation" }),
    ).toThrow(/must not disclose the cited title/);
  });

  it("offers a neutral stand-in label for a withheld title", () => {
    expect(RESTRICTED_REFERENCE_TITLE).toBe("Restricted investigation");
  });
});

describe("references preserve the original record", () => {
  it("keeps the title recorded at citation time even as the live title moves", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json") as Record<
      string,
      unknown
    >;
    const renamed = parseInvestigationReference({
      ...fixture,
      currentTitle: "Synthetic checkout timeouts (2019, reopened)",
    });
    expect(renamed.recordedTitle).toBe("Synthetic checkout timeouts (2019)");
    expect(renamed.currentTitle).toBe("Synthetic checkout timeouts (2019, reopened)");
  });

  it("withdraws by marking, never by erasing", () => {
    const fixture = load("fixtures", "investigation-reference.valid.json") as Record<
      string,
      unknown
    >;
    const withdrawn = parseInvestigationReference({
      ...fixture,
      state: "withdrawn",
      withdrawnAt: "2026-01-05T10:00:00.000Z",
    });
    expect(withdrawn.state).toBe("withdrawn");
    expect(withdrawn.recordedTitle).toBe("Synthetic checkout timeouts (2019)");
    expect(() => parseInvestigationReference({ ...fixture, state: "withdrawn" })).toThrow(
      /must record when/,
    );
  });

  it("carries no body, content, hash, or evidence field at all", () => {
    const parsed = parseInvestigationReference(
      load("fixtures", "investigation-reference.valid.json"),
    ) as unknown as Record<string, unknown>;
    for (const forbidden of [
      "body",
      "content",
      "contentHash",
      "excerpt",
      "artifact",
      "evidence",
      "supporting",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(parsed, forbidden)).toBe(false);
    }
  });
});

describe("reference notes", () => {
  it("trims, bounds, and refuses control characters", () => {
    expect(normalizeReferenceNote("  same signature  ")).toBe("same signature");
    expect(normalizeReferenceNote(null)).toBe("");
    expect(() => normalizeReferenceNote("x".repeat(601))).toThrow(/exceeds 600/);
    expect(() => normalizeReferenceNote("bell\u0007")).toThrow(/control characters/);
    // A newline is ordinary prose in a note and stays allowed.
    expect(normalizeReferenceNote("line one\nline two")).toBe("line one\nline two");
  });
});

describe("reference list envelopes", () => {
  it("keeps outbound and inbound on the right side of this investigation", () => {
    const outbound = load("fixtures", "investigation-reference.valid.json");
    const list = parseInvestigationReferenceList({
      schemaId: INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
      investigationId: CITING,
      outbound: [outbound],
      inbound: [],
    });
    expect(list.outbound).toHaveLength(1);
    expect(() =>
      parseInvestigationReferenceList({
        schemaId: INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
        investigationId: CITED,
        outbound: [outbound],
        inbound: [],
      }),
    ).toThrow(/must originate from this investigation/);
    expect(
      parseInvestigationReferenceList({
        schemaId: INVESTIGATION_REFERENCE_LIST_SCHEMA_ID,
        investigationId: CITED,
        outbound: [],
        inbound: [outbound],
      }).inbound,
    ).toHaveLength(1);
  });
});
