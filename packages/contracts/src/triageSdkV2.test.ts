import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseCompiledTriagePolicyV2,
  parseTriageCancellationV1,
  parseTriageReplayV1,
  parseTriageRequestV2,
} from "./triageSdkV2";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "fixtures", "triage-sdk", "v2",
);

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

describe("Rust-generated triage SDK v2 contracts", () => {
  it("accepts the exact request and ordered replay goldens", () => {
    expect(parseTriageRequestV2(load("request.standard.json")).run_id).toBe("run:golden:01");
    expect(parseTriageReplayV1(load("replay.partial.json")).events).toHaveLength(6);
    expect(parseTriageReplayV1(load("replay.cancelled-partial.json")).events).toHaveLength(5);
    expect(parseCompiledTriagePolicyV2(load("policy-preflight.standard.json")).slots).toHaveLength(1);
    expect(parseTriageCancellationV1(load("cancellation.json")).run_id).toBe("run:golden:01");
  });

  it.each([
    "request.unknown-version.invalid.json",
    "replay.bad-order.invalid.json",
    "replay.after-terminal.invalid.json",
  ])("rejects %s", (name) => {
    const parse = name.startsWith("request.")
      ? parseTriageRequestV2
      : parseTriageReplayV1;
    expect(() => parse(load(name))).toThrow();
  });

  it("rejects unknown event fields and kinds", () => {
    const replay = load("replay.partial.json") as { events: Record<string, unknown>[] };
    (replay.events[0].event as Record<string, unknown>).provider_body = "forbidden";
    expect(() => parseTriageReplayV1(replay)).toThrow();
    (replay.events[0].event as Record<string, unknown>).kind = "future_kind";
    expect(() => parseTriageReplayV1(replay)).toThrow();
  });
});
