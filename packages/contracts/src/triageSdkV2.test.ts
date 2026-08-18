import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseCompiledTriagePolicyV2,
  parseTriageCancellationV1,
  parseTriageReplayV1,
  parseTriageRoleQualificationResultV1,
  parseTriageRunEventV2,
  parseTriageRequestV2,
} from "./triageSdkV2";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "fixtures", "triage-sdk", "v2",
);

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

const prePacketReplay = (
  terminalKind: "failed" | "timed_out" | "cancelled",
): Record<string, any> => {
  const status = terminalKind === "timed_out"
    ? "timed_out"
    : terminalKind === "cancelled"
      ? "cancelled"
      : "failed";
  const reason = terminalKind === "failed"
    ? "policy_preflight_rejected"
    : terminalKind === "timed_out"
      ? "deadline"
      : "cancelled";
  const terminal = terminalKind === "cancelled"
    ? { kind: "cancelled", cancellation_id: "cancel:early" }
    : { kind: terminalKind, category: reason };
  const event = (sequence: number, payload: Record<string, unknown>) => ({
    schema_id: "contextdesk.triage.run_event.v2",
    run_id: "run:early",
    sequence,
    privacy: "owner_only",
    event: payload,
  });
  const attempt = (
    slot: string,
    role: Record<string, string> | string,
    attemptStatus: string,
    attemptReason: string,
  ) => ({
    attempt_id: `attempt:early:${slot}`,
    role_slot_id: slot,
    role,
    model: { profile_id: `profile:${slot}`, model_id: `model:${slot}` },
    status: attemptStatus,
    reason_codes: [attemptReason],
    elapsed_ms: 0,
    input_chars: 0,
    output_chars: 0,
    physical_provider_calls: 0,
    semantic_corrections: 0,
    terminal_disposition: attemptStatus,
  });
  return {
    schema_id: "contextdesk.triage.replay.v1",
    run_id: "run:early",
    request_fingerprint: "sha256:request:early",
    events: [
      event(0, {
        kind: "run_started",
        request_fingerprint: "sha256:request:early",
        policy_fingerprint: "sha256:policy:early",
      }),
      event(1, {
        kind: "role_attempt",
        attempt: attempt(
          "observe",
          { contributor: "observation_extractor" },
          "not_admitted",
          "policy_preflight_rejected",
        ),
      }),
      event(2, {
        kind: "role_attempt",
        attempt: attempt("finalize", "finalizer", status, reason),
      }),
      event(3, terminal),
    ],
  };
};

describe("Rust-generated triage SDK v2 contracts", () => {
  it("accepts the bounded exact-role qualification result", () => {
    const result = parseTriageRoleQualificationResultV1({
      schema_id: "contextdesk.tauri.triage_role_qualification.v1",
      action: "qualify",
      accepted: true,
      profile_id: "profile:vercel",
      model_id: "deepseek-v4-flash",
      kind: "finalizer",
      qualification: "qualified",
      physical_provider_calls: 1,
      semantic_corrections: 0,
      reason: "qualified",
      store_written: true,
      network: true,
      credentials_read: true,
      privacy: "owner_only",
    });
    expect(result.qualification).toBe("qualified");
    expect(result.physical_provider_calls).toBe(1);
  });

  it("rejects unsafe or unbounded exact-role qualification results", () => {
    const result = {
      schema_id: "contextdesk.tauri.triage_role_qualification.v1",
      action: "qualify",
      accepted: true,
      profile_id: "profile:vercel",
      model_id: "deepseek-v4-flash",
      kind: "finalizer",
      qualification: "qualified",
      physical_provider_calls: 1,
      semantic_corrections: 0,
      reason: "qualified",
      store_written: true,
      network: true,
      credentials_read: true,
      privacy: "owner_only",
    };
    expect(() => parseTriageRoleQualificationResultV1({
      ...result,
      profile_id: "/Users/private/profile",
    })).toThrow();
    expect(() => parseTriageRoleQualificationResultV1({
      ...result,
      physical_provider_calls: 9,
    })).toThrow();
  });

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

  it.each(["failed", "timed_out", "cancelled"] as const)(
    "accepts a provider-free pre-packet %s replay",
    (terminal) => {
      expect(parseTriageReplayV1(prePacketReplay(terminal)).events).toHaveLength(4);
    },
  );

  it("accepts a pre-packet failure when no policy slots were resolvable", () => {
    const replay = prePacketReplay("failed");
    replay.events.splice(1, 2);
    replay.events[1].sequence = 1;
    expect(parseTriageReplayV1(replay).events).toHaveLength(2);
  });

  it("rejects packet and provider-work claims in the pre-packet path", () => {
    const packet = prePacketReplay("failed");
    packet.events.splice(1, 0, {
      schema_id: "contextdesk.triage.run_event.v2",
      run_id: "run:early",
      sequence: 1,
      privacy: "owner_only",
      event: {
        kind: "packet_ready",
        packet_id: "packet:fabricated",
        packet_digest: "sha256:fabricated",
        evidence_count: 0,
      },
    });
    packet.events.forEach((event: Record<string, any>, sequence: number) => {
      event.sequence = sequence;
    });
    expect(() => parseTriageReplayV1(packet)).toThrow();

    for (const [field, value] of [
      ["physical_provider_calls", 1],
      ["semantic_corrections", 1],
      ["input_chars", 1],
      ["output_chars", 1],
      ["elapsed_ms", 1],
    ] as const) {
      const replay = prePacketReplay("failed");
      (replay.events[1].event.attempt as Record<string, unknown>)[field] = value;
      expect(() => parseTriageReplayV1(replay), field).toThrow();
    }

    const completed = prePacketReplay("failed");
    completed.events[1].event.attempt.status = "completed";
    completed.events[1].event.attempt.terminal_disposition = "completed";
    expect(() => parseTriageReplayV1(completed)).toThrow();
  });

  it("rejects duplicate pre-packet slots and early partial results", () => {
    const duplicate = prePacketReplay("cancelled");
    duplicate.events[2].event.attempt.role_slot_id = "observe";
    expect(() => parseTriageReplayV1(duplicate)).toThrow();

    const partial = prePacketReplay("failed");
    const full = load("replay.partial.json") as {
      events: Array<{ event: Record<string, unknown> }>;
    };
    partial.events[3].event.partial_result = full.events[5].event.result;
    expect(() => parseTriageReplayV1(partial)).toThrow();
  });
});
