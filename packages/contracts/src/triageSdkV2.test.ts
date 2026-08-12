import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseCompiledTriagePolicyV2,
  parseTriageCancellationV1,
  parseTriageReplayV1,
  parseTriageRunEventV2,
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

  it("accepts the canonical enhanced phase graph and bounded correction", () => {
    const replay = structuredClone(load("replay.partial.json")) as {
      events: Array<Record<string, any>>;
    };
    const contributor = replay.events[2].event.attempt;
    const attempt = (slot: string, role: Record<string, string> | string) => {
      const copy = structuredClone(contributor) as Record<string, unknown>;
      delete copy.model;
      return {
        ...copy,
        attempt_id: `attempt:${slot}`,
        role_slot_id: `slot:${slot}`,
        role,
        status: "abstained",
        reason_codes: ["not_required"],
        terminal_disposition: "abstained",
      };
    };
    replay.events[3].event = {
      kind: "preliminary_reconciliation",
      summary: replay.events[3].event.summary,
    };
    const completed = replay.events.pop()!;
    replay.events.pop(); // replace the legacy validation with the canonical late validation
    replay.events.push(
      {
        schema_id: "contextdesk.triage.run_event.v2",
        run_id: "run:golden:01",
        sequence: 4,
        privacy: "owner_only",
        event: { kind: "role_attempt", attempt: attempt("reviewer", "reviewer") },
      },
      {
        schema_id: "contextdesk.triage.run_event.v2",
        run_id: "run:golden:01",
        sequence: 5,
        privacy: "owner_only",
        event: { kind: "final_reconciliation", summary: replay.events[3].event.summary },
      },
      {
        schema_id: "contextdesk.triage.run_event.v2",
        run_id: "run:golden:01",
        sequence: 6,
        privacy: "owner_only",
        event: { kind: "role_attempt", attempt: attempt("finalizer", "finalizer") },
      },
      {
        schema_id: "contextdesk.triage.run_event.v2",
        run_id: "run:golden:01",
        sequence: 7,
        privacy: "owner_only",
        event: { kind: "validation", passed: false, reason_codes: ["partial"] },
      },
      {
        schema_id: "contextdesk.triage.run_event.v2",
        run_id: "run:golden:01",
        sequence: 8,
        privacy: "owner_only",
        event: { kind: "correction", applied: false, reason_codes: ["not_admitted"] },
      },
      completed,
    );
    replay.events.forEach((event, sequence) => {
      event.sequence = sequence;
    });
    replay.events.forEach((event, index) => {
      try {
        parseTriageRunEventV2(event);
      } catch (error) {
        throw new Error(`synthetic event ${index}: ${String(error)}`);
      }
    });
    expect(parseTriageReplayV1(replay).events).toHaveLength(10);
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

  it("rejects oversized requests, identity sets, and replay streams", () => {
    const request = load("request.standard.json") as Record<string, unknown>;
    request.task = "x".repeat(64 * 1024 + 1);
    expect(() => parseTriageRequestV2(request)).toThrow();

    const tooManySources = load("request.standard.json") as Record<string, unknown>;
    (tooManySources.scope as Record<string, unknown>).source_ids = Array.from(
      { length: 257 },
      (_, index) => `source:${index}`,
    );
    expect(() => parseTriageRequestV2(tooManySources)).toThrow();

    const replay = load("replay.partial.json") as Record<string, unknown>;
    replay.events = Array.from({ length: 4097 }, (_, index) => ({
      schema_id: "contextdesk.triage.run_event.v2",
      run_id: "run:golden:01",
      sequence: index,
      privacy: "owner_only",
      event: { kind: "validation", passed: false },
    }));
    expect(() => parseTriageReplayV1(replay)).toThrow();
  });

  it("rejects non-exact inline-policy schemas and excessive overrides", () => {
    const request = load("request.standard.json") as Record<string, unknown>;
    request.policy = {
      kind: "inline",
      schema_id: "contextdesk.triage_policy.v999",
      document: {
        schema_id: "contextdesk.triage_policy.v999",
        mode: "standard",
      },
    };
    expect(() => parseTriageRequestV2(request)).toThrow();

    const override = load("request.standard.json") as Record<string, unknown>;
    override.overrides = { deadline_ms: 3_600_001, max_provider_calls: 65 };
    expect(() => parseTriageRequestV2(override)).toThrow();
  });

  it("keeps ModelRef profile bounds in parity with Rust", () => {
    const compiled = load("policy-preflight.standard.json") as {
      slots: Array<{ model: { profile_id: string } }>;
    };
    compiled.slots[0].model.profile_id = "p".repeat(257);
    expect(() => parseCompiledTriagePolicyV2(compiled)).toThrow();
  });

  it("rejects stale or partial qualification bindings", () => {
    const compiled = load("policy-preflight.standard.json") as {
      slots: Array<Record<string, unknown>>;
    };
    compiled.slots[0].qualification_schema_id =
      "contextdesk.triage.qualification.v1";
    compiled.slots[0].workflow_id = "contextdesk.triage.role.v2";
    compiled.slots[0].protocol_fingerprint = "sha256:fixture";
    expect(() => parseCompiledTriagePolicyV2(compiled)).toThrow();

    const partial = load("policy-preflight.standard.json") as {
      slots: Array<Record<string, unknown>>;
    };
    delete partial.slots[0].workflow_id;
    expect(() => parseCompiledTriagePolicyV2(partial)).toThrow();

    const malformed = load("policy-preflight.standard.json") as {
      slots: Array<Record<string, unknown>>;
    };
    malformed.slots[0].qualification_schema_id =
      "contextdesk.triage.qualification.v2";
    malformed.slots[0].workflow_id = "contextdesk.triage.role.v2";
    malformed.slots[0].protocol_fingerprint = "sha1:not-v2";
    expect(() => parseCompiledTriagePolicyV2(malformed)).toThrow();
  });

  it("keeps physical calls, semantic corrections, and disposition distinct", () => {
    const replay = load("replay.partial.json") as {
      events: Array<{ event: { attempt: Record<string, unknown> } }>;
    };
    const attempt = replay.events[2].event.attempt;
    attempt.physical_provider_calls = 1;
    attempt.semantic_corrections = 2;
    expect(() => parseTriageReplayV1(replay)).toThrow();

    attempt.semantic_corrections = 0;
    attempt.terminal_disposition = "failed";
    expect(() => parseTriageReplayV1(replay)).toThrow();

    attempt.terminal_disposition = "completed";
    attempt.status = "not_admitted";
    attempt.physical_provider_calls = 1;
    expect(() => parseTriageReplayV1(replay)).toThrow();
  });
});
