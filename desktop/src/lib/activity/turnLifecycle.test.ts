import { describe, expect, it } from "vitest";
import { buildActivityTurn } from "./adapter";
import type { ChatMsg } from "../turn";
import type { HostTurnActivityRecord } from "./types";
import {
  acceptLifecycleMutation,
  isTurnLive,
  mergeSettledActivityRecord,
  settleTurnLifecycle,
} from "./turnLifecycle";

function msg(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    streaming: false,
    ...overrides,
  };
}

function record(
  status: HostTurnActivityRecord["status"],
  overrides: Partial<HostTurnActivityRecord> = {},
): HostTurnActivityRecord {
  return {
    version: 1,
    turn_id: "s1::m1",
    session_id: "s1",
    message_id: "m1",
    scope: { kind: "conversation", label: "Conversation" },
    status,
    total_elapsed_ms: 41027,
    detail_level: "summary",
    dropped_events: 0,
    events: [],
    ...overrides,
  };
}

describe("settleTurnLifecycle — authoritative terminal settle", () => {
  it.each([
    ["ok", "(completed)"],
    ["failed", "(failed)"],
    ["cancelled", "(cancelled)"],
    ["withheld", "(answer withheld)"],
  ] as const)(
    "empty content + host status=%s never titles as streaming",
    (status, title) => {
      const life = settleTurnLifecycle({
        streaming: false,
        content: "",
        recordStatus: status,
      });
      expect(life.live).toBe(false);
      expect(life.status).toBe(status);
      expect(life.titleLabel).toBe(title);
      expect(life.titleLabel.toLowerCase()).not.toContain("streaming");
    },
  );

  it("regression: cancelled technical detail must not leave streaming drawer title", () => {
    // Packaged-GUI: 41k context, seven rounds, status=cancelled, title still
    // "(streaming…)". Host record wins over empty content + any stale flag.
    const turn = buildActivityTurn(
      msg({ streaming: true, content: "" }),
      { record: record("cancelled") },
    );
    expect(turn.summary.status).toBe("cancelled");
    expect(turn.label).toBe("(cancelled)");
    expect(turn.label).not.toMatch(/streaming/i);
    expect(turn.summary.grounded).toBe(false); // no citations on a settled turn
  });

  it("stale streaming:true cannot keep the turn live after a terminal record", () => {
    expect(
      isTurnLive({ streaming: true, recordStatus: "cancelled" }),
    ).toBe(false);
    expect(isTurnLive({ streaming: true, recordStatus: null })).toBe(true);
    expect(isTurnLive({ streaming: false, recordStatus: null })).toBe(false);
  });

  it("live streaming with empty content still shows streaming title", () => {
    const life = settleTurnLifecycle({
      streaming: true,
      content: "",
      recordStatus: null,
    });
    expect(life.live).toBe(true);
    expect(life.titleLabel).toBe("(streaming…)");
    expect(life.status).toBe("pending");
  });

  it("content prefix is preferred over status-only titles", () => {
    const life = settleTurnLifecycle({
      streaming: false,
      content: "Partial answer before cancel",
      recordStatus: "cancelled",
    });
    expect(life.titleLabel).toMatch(/Partial answer/);
    expect(life.status).toBe("cancelled");
  });
});

describe("late post-terminal mutations", () => {
  it("rejects pending after cancelled (cancel-vs-provider-final)", () => {
    const gate = acceptLifecycleMutation({
      currentStatus: "cancelled",
      nextStatus: "pending",
      settled: true,
    });
    expect(gate.accept).toBe(false);
    expect(gate.reason).toBe("late_after_terminal");
  });

  it("rejects a second different terminal after settle (exactly one terminal)", () => {
    const gate = acceptLifecycleMutation({
      currentStatus: "cancelled",
      nextStatus: "ok",
      settled: true,
    });
    expect(gate.accept).toBe(false);
  });

  it("accepts the first terminal transition from pending", () => {
    expect(
      acceptLifecycleMutation({
        currentStatus: "pending",
        nextStatus: "cancelled",
        settled: false,
      }).accept,
    ).toBe(true);
  });

  it("mergeSettledActivityRecord keeps cancelled when late ok arrives", () => {
    const cancelled = record("cancelled");
    const lateOk = record("ok");
    expect(mergeSettledActivityRecord(cancelled, lateOk)).toBe(cancelled);
  });

  it("mergeSettledActivityRecord replaces null with first terminal record", () => {
    const cancelled = record("cancelled");
    expect(mergeSettledActivityRecord(null, cancelled)).toEqual(cancelled);
  });
});

describe("terminal classes drive adapter surfaces", () => {
  it.each([
    "ok",
    "failed",
    "cancelled",
    "withheld",
  ] as const)("status=%s is terminal on buildActivityTurn", (status) => {
    const turn = buildActivityTurn(msg({ content: "" }), {
      record: record(status),
    });
    expect(turn.summary.status).toBe(status);
    expect(turn.label.toLowerCase()).not.toContain("streaming");
  });
});
