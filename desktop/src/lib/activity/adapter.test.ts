import { describe, expect, it } from "vitest";
import { buildActivityTurn } from "./adapter";
import type { ChatMsg } from "../turn";
import type { HostTurnActivityRecord } from "./types";

function msg(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "m1",
    role: "assistant",
    content: "Here is the answer.",
    ...overrides,
  };
}

function record(
  overrides: Partial<HostTurnActivityRecord> = {},
): HostTurnActivityRecord {
  return {
    version: 1,
    turn_id: "s1::m1",
    session_id: "s1",
    message_id: "m1",
    scope: { kind: "conversation", label: "Conversation" },
    status: "ok",
    total_elapsed_ms: 1234,
    detail_level: "summary",
    dropped_events: 0,
    events: [
      {
        turn_id: "s1::m1",
        operation_id: "provider-round-0",
        seq: 0,
        elapsed_ms: 900,
        phase: "completed",
        status: "ok",
        origin: "probabilistic_model",
        determinism: "probabilistic",
        label: "Model request (round 1)",
        trigger: { trigger: "user_message" },
        scope: { kind: "conversation", label: "Conversation" },
        privacy: "metadata",
        context: {
          round: 0,
          message_count: 4,
          context_used_chars: 8_000,
          messages_capped: false,
          tool_names: ["search_kb", "read_file_slice"],
          roles: [{ role: "user", messages: 2, chars: 300 }],
        },
      },
    ],
    ...overrides,
  };
}

describe("the adapter reports live facts, never invented ones", () => {
  it("reads model rounds and context size from the host record", () => {
    const turn = buildActivityTurn(msg(), { record: record() });
    expect(turn.liveRecord).toBe(true);
    expect(turn.summary.modelRounds).toBe(1);
    expect(turn.summary.contextUsedChars).toBe(8_000);
    expect(turn.elapsedMs).toBe(1234);
    expect(turn.contractVersion).toBe(1);
    expect(turn.requestRounds).toHaveLength(1);
    expect(turn.requestRounds[0]!.toolsOffered).toEqual([
      "search_kb",
      "read_file_slice",
    ]);
  });

  it("leaves every host-only fact NULL when there is no record", () => {
    // The old draft filled these from fixtures and rendered them as measured.
    const turn = buildActivityTurn(msg({ tools: [] }), { record: null });
    expect(turn.liveRecord).toBe(false);
    expect(turn.summary.modelRounds).toBeNull();
    expect(turn.summary.contextUsedChars).toBeNull();
    expect(turn.summary.status).toBeNull();
    expect(turn.budget.usedChars).toBeNull();
    expect(turn.requestRounds).toEqual([]);
    expect(turn.contractVersion).toBeNull();
  });

  it("never reports a context ceiling, because the host does not send one", () => {
    // A totalChars value would drive a progress bar implying a measured
    // budget. The earlier draft invented it; there must be no route to one.
    const turn = buildActivityTurn(msg(), { record: record() });
    expect(turn.budget.totalChars).toBeNull();
  });

  it("attributes observed tool runs only to the final round", () => {
    const turn = buildActivityTurn(
      msg({
        tools: [{ id: "t1", name: "search_kb", summary: "3 hits", ok: true }],
      }),
      { record: record() },
    );
    expect(turn.requestRounds.at(-1)!.toolsRun).toEqual(["search_kb"]);
  });

  it("marks a withheld turn as ungrounded even when citations exist", () => {
    const turn = buildActivityTurn(
      msg({ citations: [{ id: "c1", label: "log" }] }),
      { record: record({ status: "withheld" }) },
    );
    expect(turn.summary.status).toBe("withheld");
    expect(turn.summary.grounded).toBe(false);
  });

  it("reports grounding as UNKNOWN while a turn is still streaming", () => {
    const turn = buildActivityTurn(msg({ streaming: true }), { record: null });
    expect(turn.summary.grounded).toBeNull();
  });

  it("surfaces the host's per-turn truncation rather than hiding it", () => {
    const turn = buildActivityTurn(msg(), {
      record: record({ dropped_events: 12 }),
    });
    expect(turn.droppedEvents).toBe(12);
  });

  it("notes a capped context prefix instead of implying a full capture", () => {
    const base = record();
    base.events[0]!.context!.messages_capped = true;
    const turn = buildActivityTurn(msg(), { record: base });
    expect(turn.budget.truncationNote).toMatch(/prefix/i);
  });

  it("keeps permissions honestly empty — the host does not record them yet", () => {
    const turn = buildActivityTurn(msg(), { record: record() });
    expect(turn.permissions).toEqual([]);
  });
});

describe("event derivation", () => {
  it("derives determinism from origin, overriding a disagreeing wire value", () => {
    const bad = record();
    // A host that shipped this would be claiming a model request is
    // reproducible. The origin is the field the rule is defined on.
    bad.events[0]!.determinism = "deterministic";
    const turn = buildActivityTurn(msg(), { record: bad });
    const round = turn.events.find((e) => e.origin === "probabilistic_model")!;
    expect(round.determinism).toBe("probabilistic");
  });

  it("requires a trigger/scope disclosure on every model event", () => {
    const turn = buildActivityTurn(msg(), { record: record() });
    const round = turn.events.find((e) => e.origin === "probabilistic_model")!;
    expect(round.hook).toBeDefined();
    expect(round.hook!.trigger).toMatch(/your message/i);
    expect(round.hook!.dataScope).toBe("Conversation");
  });

  it("places host events on an ELAPSED clock, never a fabricated date", () => {
    const turn = buildActivityTurn(msg(), { record: record() });
    const round = turn.events.find((e) => e.origin === "probabilistic_model")!;
    expect(round.clock).toEqual({ kind: "elapsed", elapsedMs: 900 });
  });

  it("places renderer-observed steps on a SEQUENCE clock — order, no timing", () => {
    const turn = buildActivityTurn(
      msg({
        trail: ["kb"],
        tools: [{ id: "t1", name: "save_memory", summary: "saved", ok: true }],
      }),
      { record: null },
    );
    for (const event of turn.events) {
      expect(event.clock.kind).toBe("sequence");
    }
  });

  it("classifies a write tool as a governed write and a read as host work", () => {
    const turn = buildActivityTurn(
      msg({
        tools: [
          { id: "t1", name: "save_memory", summary: "saved", ok: true },
          { id: "t2", name: "search_kb", summary: "3 hits", ok: true },
        ],
      }),
      { record: null },
    );
    const write = turn.events.find((e) => e.label.includes("save_memory"))!;
    const read = turn.events.find((e) => e.label.includes("search_kb"))!;
    expect(write.origin).toBe("governed_write");
    expect(read.origin).toBe("deterministic_host");
  });

  it("reports a pending permission as pending, not as a completed decision", () => {
    const turn = buildActivityTurn(
      msg({
        tools: [
          { id: "t1", name: "save_memory", summary: "Awaiting permission" },
        ],
      }),
      { record: null },
    );
    const perm = turn.events.find((e) => e.origin === "user_decision")!;
    expect(perm.status).toBe("pending");
    expect(perm.phase).toBe("started");
  });

  it("marks a failed tool as failed", () => {
    const turn = buildActivityTurn(
      msg({ tools: [{ id: "t1", name: "search_kb", summary: "boom", ok: false }] }),
      { record: null },
    );
    expect(turn.events[0]!.status).toBe("failed");
  });
});
