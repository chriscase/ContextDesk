import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_NOT_CORRECTNESS,
  parseExperimentPackage,
} from "./experiment.js";
import {
  INTERACTION_TRACE_SCHEMA_ID,
  TEXTUAL_SIMILARITY_NOT_WINNER,
  TRACE_UNKNOWN_STAYS_UNKNOWN,
  buildStrategyComparison,
  extractPlainTranscript,
  parseInteractionTrace,
  parsePlainTranscript,
  parseStrategyPackage,
  projectShareSafeTrace,
  sha256Hex,
  traceFingerprint,
} from "./trace.js";
import { parseLabImport } from "./lab-import.js";

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

describe("interaction trace contract", () => {
  it("accepts programmatic and chat traces and rejects unknown fields", () => {
    const programmatic = parseInteractionTrace(load("interaction-trace.programmatic.json"));
    expect(programmatic.schemaId).toBe(INTERACTION_TRACE_SCHEMA_ID);
    expect(programmatic.events.some((event) => event.kind === "tool_call")).toBe(true);
    expect(programmatic.efficiency.cost.status).toBe("unknown");
    const chat = parseInteractionTrace(load("interaction-trace.chat.json"));
    expect(chat.sourceKind).toBe("plain_text");
    expect(chat.completeness).toBe("partial");
    expect(() => parseInteractionTrace(load("interaction-trace.unknown-field.json"))).toThrow(
      /unknown key/,
    );
  });

  it("extracts labeled turns deterministically and keeps unlabeled text unknown", () => {
    const labeled = extractPlainTranscript(
      "User: What timed out in checkout?\nAssistant: The checkout log and inventory timeout line up. ev-demo-checkout-log ev-demo-inventory-timeout\n",
      "cand-chat-operator",
      "2026-08-19T00:00:00Z",
    );
    expect(labeled.completeness).toBe("partial");
    expect(labeled.events).toHaveLength(2);
    expect(labeled.events[0]?.kind).toBe("question");
    expect(labeled.events[1]?.evidenceRefs).toEqual([
      "ev-demo-checkout-log",
      "ev-demo-inventory-timeout",
    ]);
    expect(labeled.events[0]?.eventId).toBe("evt-cand-chat-operator-1");
    expect(labeled.rawHash).toBe(
      sha256Hex(
        "User: What timed out in checkout?\nAssistant: The checkout log and inventory timeout line up. ev-demo-checkout-log ev-demo-inventory-timeout\n",
      ),
    );

    const incomplete = parsePlainTranscript(load("plain-transcript.incomplete.json"));
    const unknown = extractPlainTranscript(
      incomplete.text,
      incomplete.candidateId,
      "2026-08-19T00:00:00Z",
    );
    expect(unknown.completeness).toBe("unknown");
    expect(unknown.unknowns).toEqual(expect.arrayContaining(["turns", "tools"]));
    expect(unknown.events[0]?.actor).toBe("unknown");
    expect(unknown.efficiency.turnCount.status).toBe("unknown");
  });

  it("projects strategy comparison without naming a winner", () => {
    const pkg = parseStrategyPackage(load("strategy-package.converge.json"));
    const comparison = buildStrategyComparison({
      packageId: pkg.experiment.packageId,
      candidates: pkg.experiment.candidates,
      traces: pkg.traces,
      agreement: pkg.experiment.schemaId.includes("summary")
        ? {
            sharedAnchors: [],
            candidateSpecific: [],
            roleConflicts: [],
            notes: [AGREEMENT_NOT_CORRECTNESS],
          }
        : parseExperimentPackage(pkg.experiment).agreement,
      gold: null,
    });
    expect(comparison.questionPaths.length).toBeGreaterThan(1);
    expect(comparison.sharedEvidence.map((row) => row.evidenceRef).sort()).toEqual([
      "ev-demo-checkout-log",
      "ev-demo-inventory-timeout",
    ]);
    expect(comparison.gold.status).toBe("unknown");
    expect(comparison.notes).toContain(TEXTUAL_SIMILARITY_NOT_WINNER);
    expect(comparison.notes).toContain(TRACE_UNKNOWN_STAYS_UNKNOWN);
    expect(comparison.divergence.some((row) => row.kind === "question")).toBe(true);

    const diverge = parseStrategyPackage(load("strategy-package.diverge.json"));
    const diverged = buildStrategyComparison({
      packageId: diverge.experiment.packageId,
      candidates: diverge.experiment.candidates,
      traces: diverge.traces,
      agreement: parseExperimentPackage(diverge.experiment).agreement,
      gold: null,
    });
    expect(diverged.uniqueEvidence.some((row) => row.evidenceRefs.length > 0)).toBe(true);
    expect(diverged.roleConflicts.length).toBe(1);
  });

  it("share-safe projection keeps hashes and omits provider endpoints", () => {
    const safe = projectShareSafeTrace(parseInteractionTrace(load("interaction-trace.programmatic.json")));
    expect(JSON.stringify(safe)).not.toContain("ai-gateway.vercel.sh");
    expect(JSON.stringify(safe)).not.toContain("rawModelCapture");
    expect(safe.events[0]?.excerptHash).toHaveLength(64);
    expect(traceFingerprint(safe)).toBe(
      traceFingerprint(parseInteractionTrace(load("interaction-trace.programmatic.json"))),
    );
  });

  it("lab import accepts a strategy package idempotently at the contract layer", () => {
    const first = parseLabImport(load("strategy-package.converge.json"));
    const second = parseLabImport(load("strategy-package.converge.json"));
    expect(first.kind).toBe("strategy");
    expect(second.kind).toBe("strategy");
    if (first.kind === "strategy" && second.kind === "strategy") {
      expect(traceFingerprint(first.package.traces[0]!)).toBe(
        traceFingerprint(second.package.traces[0]!),
      );
    }
  });

  it("JSON schema rejects unknown fields", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "interaction-trace.v1.json"), "utf8")) as object,
    );
    expect(validate(load("interaction-trace.programmatic.json"))).toBe(true);
    expect(validate(load("interaction-trace.unknown-field.json"))).toBe(false);
  });
});
