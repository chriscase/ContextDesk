import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_LANE_CONCURRENCY,
  exerciseHostLaneContracts,
  runFakeHostLanes,
} from "./host-lanes.js";

const SNAP = "snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb";

const lanes = [
  { candidateId: "cand-a", modelLabel: "a" },
  { candidateId: "cand-b", modelLabel: "b" },
  { candidateId: "cand-c", modelLabel: "c" },
];

describe("fake host lanes", () => {
  it("keeps overlap at the configured bound and mints durable same-snapshot ids", async () => {
    const run = await runFakeHostLanes({
      snapshotFingerprint: SNAP,
      lanes,
      scripts: {
        "cand-a": { delayMs: 40 },
        "cand-b": { delayMs: 40 },
        "cand-c": { delayMs: 40 },
      },
      maxConcurrency: 2,
      deadlineMs: 5_000,
    });
    expect(run.maxActive).toBeLessThanOrEqual(2);
    expect(run.maxActive).toBe(2);
    expect(run.results).toHaveLength(3);
    expect(new Set(run.results.map((row) => row.durableRunId)).size).toBe(3);
    expect(run.results.every((row) => row.snapshotFingerprint === SNAP)).toBe(true);
    expect(run.results.every((row) => row.runStatus === "completed")).toBe(true);
  });

  it("records cancellation, deadline timeout, and partial failure", async () => {
    const contracts = await exerciseHostLaneContracts(SNAP);
    expect(contracts.configuredLimit).toBe(DEFAULT_HOST_LANE_CONCURRENCY);
    expect(contracts.observedMaxActive).toBeLessThanOrEqual(DEFAULT_HOST_LANE_CONCURRENCY);
    expect(contracts.sameSnapshot).toBe(true);
    expect(contracts.durableRunCount).toBe(4);
    expect(contracts.cancelled).toBe(true);
    expect(contracts.deadline).toBe(true);
    expect(contracts.partial).toBe(true);
  });
});
