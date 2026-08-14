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

describe("exact-role qualification mock seam", () => {
  const roleQualification = {
    schema_id: "contextdesk.tauri.triage_role_qualification.v1" as const,
    action: "qualify" as const,
    accepted: true,
    profile_id: "profile:vercel",
    model_id: "deepseek-v4-flash",
    kind: "finalizer",
    qualification: "qualified" as const,
    physical_provider_calls: 1,
    semantic_corrections: 0,
    reason: "qualified",
    store_written: true,
    network: true,
    credentials_read: true,
    privacy: "owner_only" as const,
  };

  it("requires confirmation and exact identity", async () => {
    const client = createMockEngineClient({
      triage: { preflight, replay, roleQualification },
    });
    await expect(client.triage.qualify({
      profile_id: "profile:vercel",
      model_id: "deepseek-v4-flash",
      kind: "finalizer",
      deadline_ms: 300_000,
      confirm: false,
    })).rejects.toMatchObject({ code: "invalid" });
    await expect(client.triage.qualify({
      profile_id: "profile:vercel",
      model_id: "other-model",
      kind: "finalizer",
      deadline_ms: 300_000,
      confirm: true,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(client.triage.qualify({
      profile_id: "profile:vercel",
      model_id: "deepseek-v4-flash",
      kind: "finalizer",
      deadline_ms: 300_000,
      confirm: true,
    })).resolves.toMatchObject({ qualification: "qualified" });
  });
});
