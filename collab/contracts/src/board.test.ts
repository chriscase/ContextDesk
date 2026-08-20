import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_NOT_CORRECTNESS,
  GOLD_IS_HUMAN_BENCHMARK,
  parseExperimentPackage,
  parseGoldReference,
} from "./index.js";
import {
  CASE_BOARD_SCHEMA_ID,
  deriveCaseBoard,
  parseCaseBoard,
} from "./board.js";

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

const GENERATED_AT = "2026-08-20T12:00:00.000Z";

describe("case board contract", () => {
  it("accepts the case-board fixture and rejects unknown fields", () => {
    const board = parseCaseBoard(load("case-board.valid.json"));
    expect(board.schemaId).toBe(CASE_BOARD_SCHEMA_ID);
    expect(board.privacyClass).toBe("owner_only");
    expect(board.notes).toContain(AGREEMENT_NOT_CORRECTNESS);
    expect(board.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
    expect(() => parseCaseBoard(load("case-board.unknown-field.json"))).toThrow(/unknown key/);
  });

  it("places supported hypotheses in known and keeps proposed hypotheses unknown", () => {
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: null,
      generatedAt: GENERATED_AT,
      artifacts: [
        {
          id: "ev-1",
          contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedHash: null,
          verificationStatus: "verified",
        },
      ],
      contributions: [
        {
          id: "hyp-supported",
          kind: "hypothesis",
          tombstoned: false,
          hypothesisStatus: "supported",
          hypothesisLinks: [{ kind: "artifact", id: "ev-1" }],
          body: "Timeout is in inventory",
        },
        {
          id: "hyp-proposed",
          kind: "hypothesis",
          tombstoned: false,
          hypothesisStatus: "proposed",
          hypothesisLinks: [],
          body: "Maybe the pool is exhausted",
        },
        {
          id: "hyp-old",
          kind: "hypothesis",
          tombstoned: false,
          hypothesisStatus: "superseded",
          hypothesisLinks: [{ kind: "artifact", id: "ev-1" }],
          body: "Ignore me",
        },
      ],
    });
    expect(board.known.map((row) => row.findingId)).toEqual(["hyp-hyp-supported"]);
    expect(board.known[0]?.confidence).toBe("supported");
    expect(board.unknown.map((row) => row.findingId)).toEqual(["hyp-hyp-proposed"]);
    expect(board.gold.status).toBe("unknown");
    expect(board.gold.goldId).toBeNull();
  });

  it("does not treat shared agreement as known or gold as invented truth", () => {
    const pkg = parseExperimentPackage(load("experiment-package.valid.json"));
    const gold = parseGoldReference(load("gold-reference.valid.json"));
    const withoutGold = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: "snap-1",
      generatedAt: GENERATED_AT,
      artifacts: [],
      contributions: [
        {
          id: "hyp-contradicted",
          kind: "hypothesis",
          tombstoned: false,
          hypothesisStatus: "contradicted",
          hypothesisLinks: [{ kind: "artifact", id: "ev-demo-pool-exhaustion" }],
          body: "Pool exhaustion",
        },
      ],
      experiments: [
        {
          experimentId: "exp-1",
          agreement: pkg.agreement,
          decisions: [
            {
              id: "dec-new",
              status: "accepted",
              text: "Working conclusion: inventory timeout",
              evidenceRefs: ["ev-demo-inventory-timeout"],
              createdAt: "2026-08-20T00:00:00Z",
            },
          ],
          gold: null,
          traces: [
            {
              traceId: "trace-partial",
              completeness: "partial",
              unknowns: ["tool args omitted"],
              rawHash: null,
            },
          ],
        },
      ],
    });
    expect(withoutGold.agreed.map((row) => row.evidenceRefs[0])).toEqual([
      "ev-demo-checkout-log",
    ]);
    expect(withoutGold.agreed.every((row) => row.bucket === "agreed")).toBe(true);
    expect(withoutGold.known).toEqual([]);
    expect(withoutGold.disputed.map((row) => row.findingId).sort()).toEqual([
      "conflict-exp-1-ev-demo-inventory-timeout",
      "hyp-hyp-contradicted",
    ]);
    expect(withoutGold.newlyConcluded.map((row) => row.findingId)).toEqual(["decision-dec-new"]);
    expect(withoutGold.unknown.some((row) => row.findingId === "trace-unknown-trace-partial")).toBe(
      true,
    );
    expect(withoutGold.gold.status).toBe("unknown");

    const withGold = deriveCaseBoard({
      caseId: gold.caseId,
      snapshotId: null,
      generatedAt: GENERATED_AT,
      artifacts: [],
      contributions: [],
      experiments: [
        {
          experimentId: gold.experimentId,
          agreement: pkg.agreement,
          decisions: [
            {
              id: gold.acceptedDecisionId,
              status: "accepted",
              text: "Promoted gold decision",
              evidenceRefs: gold.evidenceAnchors,
              createdAt: "2026-08-18T00:00:00Z",
            },
          ],
          gold,
          traces: [],
        },
      ],
    });
    expect(withGold.gold).toEqual({
      status: "present",
      version: gold.version,
      goldId: gold.goldId,
    });
    expect(withGold.newlyConcluded).toEqual([]);
    expect(withGold.known).toEqual([]);
    expect(withGold.notes).toContain(GOLD_IS_HUMAN_BENCHMARK);
    expect(withGold.notes.some((note) => note.toLowerCase().includes("not case truth"))).toBe(
      true,
    );
  });

  it("keeps candidate-specific evidence out of disputed and maps imports without inventing gold", () => {
    const pkg = parseExperimentPackage(load("experiment-package.valid.json"));
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: null,
      generatedAt: GENERATED_AT,
      artifacts: [
        {
          id: "ev-ref",
          contentHash: null,
          expectedHash: null,
          verificationStatus: "unverified",
        },
      ],
      contributions: [],
      experiments: [
        {
          experimentId: "exp-1",
          agreement: pkg.agreement,
          decisions: [],
          gold: null,
          traces: [],
        },
      ],
      imports: [
        { id: "run-ok", corroborationState: "corroborated", contributionId: "c-ok" },
        { id: "run-bad", corroborationState: "contradicted", contributionId: "c-bad" },
        { id: "run-new", corroborationState: "unverified", contributionId: "c-new" },
      ],
    });
    expect(board.disputed.some((row) => row.findingId.includes("ev-demo-pool-exhaustion"))).toBe(
      false,
    );
    expect(board.known.map((row) => row.findingId)).toEqual(["import-run-ok"]);
    expect(board.known[0]?.confidence).toBe("observed");
    expect(board.disputed.some((row) => row.findingId === "import-run-bad")).toBe(true);
    expect(board.unknown.some((row) => row.findingId === "import-run-new")).toBe(true);
    expect(board.unknown.some((row) => row.findingId === "artifact-unknown-ev-ref")).toBe(true);
    expect(board.gold.status).toBe("unknown");
  });

  it("rejects missing caveats and invented gold identity", () => {
    const valid = load("case-board.valid.json") as Record<string, unknown>;
    expect(() => parseCaseBoard({ ...valid, notes: ["looks correct"] })).toThrow(
      /agreement-is-not-correctness/,
    );
    expect(() =>
      parseCaseBoard({
        ...valid,
        gold: { status: "unknown", version: 1, goldId: "invented" },
      }),
    ).toThrow(/must not invent an identity/);
  });

  it("JSON schema rejects unknown fields on the case-board fixture", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "case-board.v1.json"), "utf8")) as object,
    );
    expect(validate(load("case-board.valid.json"))).toBe(true);
    expect(validate(load("case-board.unknown-field.json"))).toBe(false);
  });
});
