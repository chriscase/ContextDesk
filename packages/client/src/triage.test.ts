import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  parseCompiledTriagePolicyV2,
  parseTriageCancellationV1,
  parseTriageReplayV1,
  parseTriageRequestV2,
} from "@contextdesk/contracts";
import { triageClientConformance } from "./conformance";
import { createMockEngineClient } from "./mock";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "fixtures", "triage-sdk", "v2",
);
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

const request = parseTriageRequestV2(load("request.standard.json"));
const preflight = parseCompiledTriagePolicyV2(
  load("policy-preflight.standard.json"),
);
const replay = parseTriageReplayV1(load("replay.partial.json"));
const cancelledReplay = parseTriageReplayV1(
  load("replay.cancelled-partial.json"),
);
const cancellation = parseTriageCancellationV1(load("cancellation.json"));

describe("triage EngineClient adapter conformance", () => {
  const scenario = { preflight, replay, cancelledReplay };
  const checks = triageClientConformance({
    createClient: () => createMockEngineClient({ triage: scenario }),
    createCancellableClient: () =>
      createMockEngineClient({
        triage: { ...scenario, manualFlush: true },
      }),
    createUnsupportedClient: () => createMockEngineClient(),
    request,
    preflight,
    replay,
    cancelledReplay,
    cancellation,
  });

  for (const check of checks) {
    it(check.name, async () => {
      await check.run();
    });
  }
});
