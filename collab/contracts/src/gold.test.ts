import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  GOLD_ALIGNMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
  GOLD_REFERENCE_SCHEMA_ID,
  alignCitedEvidence,
  goldPromotionFingerprint,
  parseGoldAlignment,
  parseGoldReference,
} from "./gold.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const schemasDir = join(here, "..", "schemas");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

describe("gold reference contract", () => {
  it("accepts the three-model checkout gold fixture and rejects unknown fields", () => {
    const gold = parseGoldReference(load("gold-reference.valid.json"));
    expect(gold.schemaId).toBe(GOLD_REFERENCE_SCHEMA_ID);
    expect(gold.packageId).toBe("pkg-synth-three-model-checkout-v1");
    expect(gold.evidenceAnchors).toEqual([
      "ev-demo-checkout-log",
      "ev-demo-inventory-timeout",
    ]);
    expect(gold.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
    expect(() => parseGoldReference(load("gold-reference.unknown-field.json"))).toThrow(
      /unknown key/,
    );
  });

  it("rejects empty anchors, missing caveat, and a predecessor on version 1", () => {
    const valid = load("gold-reference.valid.json") as Record<string, unknown>;
    expect(() => parseGoldReference({ ...valid, evidenceAnchors: [] })).toThrow(/evidence anchor/);
    expect(() => parseGoldReference({ ...valid, notes: ["looks correct"] })).toThrow(
      /human-benchmark/,
    );
    expect(() =>
      parseGoldReference({ ...valid, predecessorGoldId: "gold-other" }),
    ).toThrow(/predecessor/);
    expect(() => parseGoldReference({ ...valid, version: 0 })).toThrow(/version/);
  });

  it("treats the same decision and anchors as one promotion fingerprint", () => {
    const gold = parseGoldReference(load("gold-reference.valid.json"));
    const left = goldPromotionFingerprint(gold);
    const right = goldPromotionFingerprint({
      acceptedDecisionId: gold.acceptedDecisionId,
      acceptedDecisionRevision: gold.acceptedDecisionRevision,
      evidenceAnchors: [...gold.evidenceAnchors].reverse(),
      expectedRelationships: [...(gold.expectedRelationships ?? [])].reverse(),
      helpfulnessDimensions: [...(gold.helpfulnessDimensions ?? [])].reverse(),
    });
    expect(left).toBe(right);
  });

  it("aligns cited evidence without treating agreement as correctness", () => {
    const gold = parseGoldReference(load("gold-reference.valid.json"));
    const aligned = alignCitedEvidence({
      candidateId: "cand-qwen-3.6-27b",
      cited: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      observedRoles: new Map([
        ["ev-demo-checkout-log", "symptom"],
        ["ev-demo-inventory-timeout", "cause"],
      ]),
      gold,
    });
    expect(aligned.status).toBe("aligned");
    expect(aligned.notes).toContain(GOLD_ALIGNMENT_NOT_CORRECTNESS);

    const partial = alignCitedEvidence({
      candidateId: "cand-gpt-oss-120b",
      cited: ["ev-demo-checkout-log", "ev-demo-pool-exhaustion", "ev-demo-inventory-timeout"],
      observedRoles: new Map([
        ["ev-demo-checkout-log", "symptom"],
        ["ev-demo-inventory-timeout", "symptom"],
      ]),
      gold,
    });
    expect(partial.status).toBe("partial");
    expect(partial.extraAnchors).toContain("ev-demo-pool-exhaustion");
    expect(partial.roleMismatches).toEqual([
      { evidenceRef: "ev-demo-inventory-timeout", role: "symptom" },
    ]);

    const unknown = alignCitedEvidence({
      candidateId: "cand-ministral-14b",
      cited: ["ev-demo-checkout-log"],
      gold: null,
    });
    expect(unknown.status).toBe("unknown");
    parseGoldAlignment(unknown);
  });

  it("JSON schema rejects unknown fields on the gold fixture", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "gold-reference.v1.json"), "utf8")) as object,
    );
    expect(validate(load("gold-reference.valid.json"))).toBe(true);
    expect(validate(load("gold-reference.unknown-field.json"))).toBe(false);
  });
});
