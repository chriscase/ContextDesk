import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BENCH_ARTIFACT_NO_GOLD,
  BENCH_RUN_ARTIFACT_SCHEMA_ID,
  SYNTHETIC_EMPLOYER_LANE_LABELS,
  convertBenchArtifactImport,
  parseBenchRunArtifact,
} from "./bench-artifact.js";
import { parseLabImport } from "./lab-import.js";
import { STRATEGY_PACKAGE_SCHEMA_ID, TRACE_UNKNOWN_STAYS_UNKNOWN } from "./trace.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

describe("bench-run artifact converter", () => {
  it("converts a multi-strategy hermetic artifact into a strategy package", () => {
    const artifact = parseBenchRunArtifact(load("bench-run-artifact.multi-strategy.json"));
    expect(artifact.schemaId).toBe(BENCH_RUN_ARTIFACT_SCHEMA_ID);
    expect(artifact.lanes).toHaveLength(3);
    expect(artifact.lanes.map((lane) => lane.modelLabel)).toEqual([
      ...SYNTHETIC_EMPLOYER_LANE_LABELS,
    ]);

    const strategy = convertBenchArtifactImport(load("bench-run-artifact.multi-strategy.json"));
    expect(strategy.schemaId).toBe(STRATEGY_PACKAGE_SCHEMA_ID);
    expect(strategy.experiment.candidates).toHaveLength(3);
    expect(strategy.traces).toHaveLength(3);
    expect(strategy.experiment.taskFingerprint).toMatch(/^task-[a-f0-9]{64}$/);
    expect(strategy.experiment.snapshotFingerprint).toMatch(/^snap-[a-f0-9]{64}$/);
    expect(strategy.experiment.candidates.every((c) => c.cost.status === "unknown")).toBe(true);
    expect(strategy.experiment.candidates.every((c) => c.usage.status === "unknown")).toBe(true);
    expect(strategy.experiment.candidates.every((c) => c.goldState === "unknown")).toBe(true);
    expect(strategy.experiment.agreement.notes).toEqual(
      expect.arrayContaining([BENCH_ARTIFACT_NO_GOLD]),
    );
    expect(strategy.experiment.agreement.sharedAnchors.some((row) => row.evidenceRef === "ev-demo-checkout-log")).toBe(
      true,
    );
    expect(
      strategy.traces.every((trace) =>
        trace.notes.includes(TRACE_UNKNOWN_STAYS_UNKNOWN) && trace.completeness === "partial",
      ),
    ).toBe(true);
    expect(strategy.traces[0]?.efficiency.cost.status).toBe("unknown");
    expect(strategy.traces[0]?.unknowns).toEqual(
      expect.arrayContaining(["question", "raw answer", "tools", "usage", "cost"]),
    );
  });

  it("is reachable through the Experiment Lab import entrypoint", () => {
    const imported = parseLabImport(load("bench-run-artifact.multi-strategy.json"));
    expect(imported.kind).toBe("strategy");
    if (imported.kind !== "strategy") return;
    expect(imported.package.experiment.packageId).toBe("pkg-synth-bench-multi-strategy-v1");
  });

  it("rejects DeepSeek lane labels", () => {
    expect(() => parseBenchRunArtifact(load("bench-run-artifact.deepseek-rejected.json"))).toThrow(
      /DeepSeek/,
    );
  });

  it("refuses invented observed cost or usage on share-safe rows", () => {
    const raw = load("bench-run-artifact.multi-strategy.json") as {
      lanes: { shareSafe: { cost: string } }[];
    };
    raw.lanes[0]!.shareSafe.cost = "observed";
    expect(() => parseBenchRunArtifact(raw)).toThrow(/cost or usage/);
  });
});
