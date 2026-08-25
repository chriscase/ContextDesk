import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  ENTITY_KINDS,
  ENTITY_LIST_SCHEMA_ID,
  ENTITY_PROFILE_MAX_LENGTH,
  ENTITY_SCHEMA_ID,
  INVOLVEMENT_INDEX_SCHEMA_ID,
  INVOLVEMENT_LIST_SCHEMA_ID,
  INVOLVEMENT_RELATIONSHIPS,
  INVOLVEMENT_SCHEMA_ID,
  involvementLabelDrifted,
  normalizeEntityLabel,
  normalizeEntityProfile,
  parseInvestigationEntity,
  parseInvestigationEntityList,
  parseInvestigationInvolvement,
  parseInvestigationInvolvementList,
  parseInvolvementIndex,
} from "./investigation-entity.js";
import { SOURCE_KINDS } from "./source.js";

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

describe("entity registry contract", () => {
  it("accepts the synthetic fixture through both the parser and the JSON Schema", () => {
    const fixture = load("fixtures", "investigation-entity.valid.json");
    expect(parseInvestigationEntity(fixture).schemaId).toBe(ENTITY_SCHEMA_ID);
    expect(validator("investigation-entity.v1.json")(fixture)).toBe(true);
  });

  it("rejects an unknown field so the registry cannot grow a contact sidecar", () => {
    const drifted = load("fixtures", "investigation-entity.unknown-field.json");
    expect(() => parseInvestigationEntity(drifted)).toThrow(/unknown key/);
    expect(validator("investigation-entity.v1.json")(drifted)).toBe(false);
  });

  it("offers six neutral kinds and treats customer as one of them", () => {
    expect([...ENTITY_KINDS]).toEqual([
      "organization",
      "customer",
      "person",
      "service",
      "system",
      "other",
    ]);
    // No kind is privileged; the enum is flat and customer sits inside it.
    expect(ENTITY_KINDS.indexOf("customer")).toBeGreaterThan(-1);
    expect(ENTITY_KINDS).toHaveLength(6);
  });

  it("stays a different vocabulary from the Attribution source catalog", () => {
    // Attribution answers "where did this information come from"; entities
    // answer "who or what is this investigation about". Overlapping the two
    // enums would be the first step to collapsing the boundary.
    const overlap = (ENTITY_KINDS as readonly string[]).filter((kind) =>
      (SOURCE_KINDS as readonly string[]).includes(kind),
    );
    expect(overlap).toEqual([]);
  });
});

describe("entity labels and profiles", () => {
  it("trims a label and refuses an empty or multi-line one", () => {
    expect(normalizeEntityLabel("  Synthetic payments platform  ")).toBe(
      "Synthetic payments platform",
    );
    expect(() => normalizeEntityLabel("   ")).toThrow(/non-empty/);
    expect(() => normalizeEntityLabel("first line\nsecond line")).toThrow(/single line/);
  });

  it("keeps a profile a descriptor, not a place to paste a log", () => {
    expect(normalizeEntityProfile({ summary: "  Synthetic  ", reference: "" })).toEqual({
      summary: "Synthetic",
      reference: "",
    });
    expect(normalizeEntityProfile({ summary: "", reference: "" })).toBeNull();
    expect(normalizeEntityProfile(null)).toBeNull();
    expect(() =>
      normalizeEntityProfile({ summary: "x".repeat(ENTITY_PROFILE_MAX_LENGTH + 1), reference: "" }),
    ).toThrow(/investigation content belongs in the investigation/);
    expect(() => normalizeEntityProfile({ summary: "ok", note: "smuggled" })).toThrow(
      /unknown key/,
    );
  });
});

describe("involvement links", () => {
  it("accepts the synthetic fixture through both the parser and the JSON Schema", () => {
    const fixture = load("fixtures", "investigation-involvement.valid.json");
    expect(parseInvestigationInvolvement(fixture).schemaId).toBe(INVOLVEMENT_SCHEMA_ID);
    expect(validator("investigation-involvement.v1.json")(fixture)).toBe(true);
  });

  it("preserves the label recorded at link time when the registry moves on", () => {
    const fixture = load("fixtures", "investigation-involvement.valid.json") as Record<
      string,
      unknown
    >;
    const parsed = parseInvestigationInvolvement(fixture);
    expect(parsed.recordedLabel).toBe("Synthetic checkout service");
    expect(parsed.currentLabel).toBe("Synthetic checkout service (retired platform)");
    expect(parsed.currentLifecycle).toBe("retired");
    expect(involvementLabelDrifted(parsed)).toBe(true);
  });

  it("reports no drift when the entity is unresolvable to this reader", () => {
    expect(
      involvementLabelDrifted({
        recordedLabel: "Synthetic system",
        recordedKind: "system",
        currentLabel: null,
        currentKind: null,
      }),
    ).toBe(false);
  });

  it("offers relationships about the investigation, not about a commercial tie", () => {
    expect([...INVOLVEMENT_RELATIONSHIPS]).toEqual([
      "affected",
      "reporting",
      "responsible",
      "observing",
      "referenced",
      "other",
    ]);
  });

  it("refuses a released link with no released-at, and the reverse", () => {
    const base = load("fixtures", "investigation-involvement.valid.json") as Record<
      string,
      unknown
    >;
    expect(() =>
      parseInvestigationInvolvement({ ...base, state: "released", releasedAt: null }),
    ).toThrow(/must record when/);
    expect(() =>
      parseInvestigationInvolvement({
        ...base,
        state: "active",
        releasedAt: "2024-03-01T00:00:00.000Z",
      }),
    ).toThrow(/not released/);
  });

  it("refuses a list whose rows belong to another investigation", () => {
    const row = load("fixtures", "investigation-involvement.valid.json");
    expect(
      parseInvestigationInvolvementList({
        schemaId: INVOLVEMENT_LIST_SCHEMA_ID,
        investigationId: "11111111-1111-4111-8111-111111111111",
        involvements: [row],
      }).involvements,
    ).toHaveLength(1);
    expect(() =>
      parseInvestigationInvolvementList({
        schemaId: INVOLVEMENT_LIST_SCHEMA_ID,
        investigationId: "22222222-2222-4222-8222-222222222222",
        involvements: [row],
      }),
    ).toThrow(/different investigation/);
  });
});

describe("list and index envelopes", () => {
  it("validates an entity list and an involvement index", () => {
    expect(
      parseInvestigationEntityList({
        schemaId: ENTITY_LIST_SCHEMA_ID,
        entities: [load("fixtures", "investigation-entity.valid.json")],
      }).entities,
    ).toHaveLength(1);
    expect(
      parseInvolvementIndex({
        schemaId: INVOLVEMENT_INDEX_SCHEMA_ID,
        entries: [
          {
            investigationId: "11111111-1111-4111-8111-111111111111",
            entityId: "8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91",
            relationship: "affected",
            state: "active",
          },
        ],
      }).entries,
    ).toHaveLength(1);
  });
});
