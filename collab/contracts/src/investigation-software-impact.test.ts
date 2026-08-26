import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  SOFTWARE_IMPACT_FIELDS,
  SOFTWARE_IMPACT_ORDERING,
  SOFTWARE_IMPACT_SCHEMA_ID,
  SOFTWARE_IMPACT_STATUSES,
  SOFTWARE_IMPACT_VALUE_MAX_LENGTH,
  normalizeSoftwareImpactIdentity,
  parseSoftwareImpact,
  parseSoftwareImpactList,
  parseSoftwareImpactSuggestions,
  softwareImpactDisplayLabel,
  softwareImpactIdentityKey,
} from "./investigation-software-impact.js";

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

const valid = () => load("fixtures", "investigation-software-impact.valid.json");

describe("software impact contract", () => {
  it("accepts the synthetic fixture through both the parser and the JSON Schema", () => {
    const fixture = valid();
    expect(parseSoftwareImpact(fixture).schemaId).toBe(SOFTWARE_IMPACT_SCHEMA_ID);
    expect(validator("investigation-software-impact.v1.json")(fixture)).toBe(true);
  });

  it("rejects an unknown field so lineage claims cannot sneak in", () => {
    const drifted = load("fixtures", "investigation-software-impact.unknown-field.json");
    expect(() => parseSoftwareImpact(drifted)).toThrow(/unknown key/);
    expect(validator("investigation-software-impact.v1.json")(drifted)).toBe(false);
  });

  it("keeps the four epistemic statuses and never ranks them", () => {
    expect([...SOFTWARE_IMPACT_STATUSES]).toEqual([
      "observed",
      "suspected",
      "confirmed",
      "ruled_out",
    ]);
  });

  it("lists records in recording order only", () => {
    const fixture = parseSoftwareImpact(valid());
    const parsed = parseSoftwareImpactList({
      schemaId: "cd-collab.software_impact_list.v1",
      investigationId: fixture.investigationId,
      ordering: SOFTWARE_IMPACT_ORDERING,
      records: [fixture],
    });
    expect(parsed.ordering).toBe("recorded_at");
    expect(() =>
      parseSoftwareImpactList({
        schemaId: "cd-collab.software_impact_list.v1",
        investigationId: fixture.investigationId,
        ordering: "build_lineage",
        records: [fixture],
      }),
    ).toThrow(/expected one of/);
  });
});

describe("software impact identity", () => {
  it("requires at least one label and treats the rest as not recorded", () => {
    expect(
      normalizeSoftwareImpactIdentity({ productName: "  Fixture Desk  ", version: "  " }),
    ).toEqual({
      productName: "Fixture Desk",
      version: "",
      build: "",
      component: "",
      environment: "",
    });
    expect(() => normalizeSoftwareImpactIdentity({})).toThrow(/at least one/);
  });

  it("refuses multiline labels so a pasted log cannot live here", () => {
    expect(() => normalizeSoftwareImpactIdentity({ productName: "Desk\nworker" })).toThrow(
      /single line/,
    );
    expect(() =>
      normalizeSoftwareImpactIdentity({ productName: "x".repeat(SOFTWARE_IMPACT_VALUE_MAX_LENGTH + 1) }),
    ).toThrow(/exceeds/);
  });

  it("matches identities case-insensitively without comparing versions", () => {
    const left = normalizeSoftwareImpactIdentity({ productName: "Fixture Desk", version: "4.2" });
    const right = normalizeSoftwareImpactIdentity({ productName: "fixture desk", version: "4.2" });
    expect(softwareImpactIdentityKey(left)).toBe(softwareImpactIdentityKey(right));
    const other = normalizeSoftwareImpactIdentity({ productName: "Fixture Desk", version: "4.1" });
    expect(softwareImpactIdentityKey(left)).not.toBe(softwareImpactIdentityKey(other));
    expect(softwareImpactDisplayLabel(left)).toBe("Fixture Desk · 4.2");
  });

  it("does not offer a comparator over version or build strings", () => {
    expect(SOFTWARE_IMPACT_FIELDS).not.toContain("laterThan");
    expect(typeof (parseSoftwareImpact(valid()) as { compare?: unknown }).compare).toBe(
      "undefined",
    );
  });
});

describe("software impact suggestions", () => {
  it("accepts visible values for one field and nothing else", () => {
    const parsed = parseSoftwareImpactSuggestions({
      schemaId: "cd-collab.software_impact_suggestions.v1",
      field: "build",
      values: ["build-007", "build-008"],
    });
    expect(parsed.values).toEqual(["build-007", "build-008"]);
    expect(() =>
      parseSoftwareImpactSuggestions({
        schemaId: "cd-collab.software_impact_suggestions.v1",
        field: "build",
        values: ["ok"],
        inferredLatest: true,
      }),
    ).toThrow(/unknown key/);
  });
});
