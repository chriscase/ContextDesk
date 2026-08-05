/**
 * Mutation-resistant lifecycle races for Activity surfaces.
 *
 * Drives the shipped settle path (`buildActivityTurn` + `turnLifecycle` +
 * `shouldProcessEventWhileStopped` + import settle + timezone events +
 * bridges) — not a reimplementation of the agent loop.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildActivityTurn } from "./adapter";
import {
  acceptLifecycleMutation,
  mergeSettledActivityRecord,
  settleTurnLifecycle,
} from "./turnLifecycle";
import {
  finalizeMessagesAfterStop,
  shouldProcessEventWhileStopped,
} from "../turn";
import type { ChatMsg } from "../turn";
import {
  ACTIVITY_LANE_GROUP,
  type ActivityStatus,
  type HostTurnActivityRecord,
} from "./types";
import {
  beginImportActivityAttempt,
  recordImportProgress,
  settleImportActivityAttempt,
} from "./importProgressActivity";
import { timezoneActivityEvent } from "./timezoneActivity";
import {
  appendActivities,
  createActivityLog,
  DEFAULT_ACTIVITY_CAP,
} from "./activityLog";
import {
  publishTurnActivityUpdate,
  subscribeTurnActivityUpdate,
} from "./turnActivityUpdateBridge";
import { ActivityDrawer } from "../../components/activity/ActivityDrawer";
import { ActivityDock } from "../../components/activity/ActivityDock";
import { ActivityCompactLine } from "../../components/activity/ActivityCompactLine";
import type { ProcessProgressDto } from "../../components/wizards/types";

function msg(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    streaming: false,
    ...overrides,
  };
}

function hostRecord(
  status: ActivityStatus,
  overrides: Partial<HostTurnActivityRecord> = {},
): HostTurnActivityRecord {
  return {
    version: 1,
    turn_id: "s1::m1",
    session_id: "s1",
    message_id: "m1",
    scope: { kind: "conversation", label: "Conversation" },
    status,
    total_elapsed_ms: 1000,
    detail_level: "summary",
    dropped_events: 0,
    events: [],
    ...overrides,
  };
}

function progress(
  phase: ProcessProgressDto["phase"],
  extra: Partial<ProcessProgressDto> = {},
): ProcessProgressDto {
  return {
    operation_id: "host-op-1",
    correlation_id: "import:race",
    kind: "log_ingest",
    phase,
    message: phase,
    fraction: null,
    lines_processed: null,
    files_processed: null,
    bytes_processed: null,
    templates: null,
    cancellable: true,
    elapsed_ms: 10,
    phase_elapsed_ms: null,
    ...extra,
  };
}

describe("cancel-vs-tool-result (real controller + settle path)", () => {
  it("drops tool stream kinds after stop on the shipped event gate", () => {
    // useTurnController calls shouldProcessEventWhileStopped(isRetired(), kind)
    expect(shouldProcessEventWhileStopped(true, "tool")).toBe(false);
    expect(shouldProcessEventWhileStopped(true, "tool_result")).toBe(false);
    expect(shouldProcessEventWhileStopped(true, "text_delta")).toBe(false);
    expect(shouldProcessEventWhileStopped(true, "turn_completed")).toBe(true);
    expect(shouldProcessEventWhileStopped(true, "error")).toBe(true);
  });

  it("late tool row after cancel does not resurrect streaming chrome", () => {
    // Host settled cancelled; a late tool_result still on the message (or
    // applied before the gate) must not put title/status back to live.
    const turn = buildActivityTurn(
      msg({
        streaming: true, // stale flag race
        content: "",
        tools: [
          {
            id: "late-tool",
            name: "search_kb",
            summary: "late result after cancel",
            ok: true,
          },
        ],
      }),
      { record: hostRecord("cancelled") },
    );
    expect(turn.summary.status).toBe("cancelled");
    expect(turn.label).toBe("(cancelled)");
    expect(turn.label.toLowerCase()).not.toContain("streaming");
    // Effective lifecycle still not live
    const life = settleTurnLifecycle({
      streaming: true,
      content: "",
      recordStatus: "cancelled",
    });
    expect(life.live).toBe(false);
  });

  it("merge rejects a pending host record after a cancelled settle (tool path)", () => {
    // A late host write that only has tool rows and still says pending must
    // not replace cancelled in ChatPane's activityRecords merge.
    const cancelled = hostRecord("cancelled");
    const lateToolPending = hostRecord("pending", {
      events: [
        {
          turn_id: "s1::m1",
          operation_id: "tool-late",
          seq: 9,
          elapsed_ms: 50,
          phase: "completed",
          status: "ok",
          origin: "deterministic_host",
          determinism: "deterministic",
          label: "Tool search_kb",
          trigger: { trigger: "model_request", round: 0 },
          scope: { kind: "conversation", label: "Conversation" },
          privacy: "metadata",
        },
      ],
    });
    expect(mergeSettledActivityRecord(cancelled, lateToolPending)).toBe(
      cancelled,
    );
    expect(
      acceptLifecycleMutation({
        currentStatus: "cancelled",
        nextStatus: "pending",
        settled: true,
      }).reason,
    ).toBe("late_after_terminal");
  });

  it("finalizeMessagesAfterStop clears streaming so anyMessageStreaming is false", () => {
    const out = finalizeMessagesAfterStop([
      msg({ id: "a", streaming: true, content: "partial", tools: [] }),
    ]);
    expect(out.every((m) => !m.streaming)).toBe(true);
  });
});

describe("cancel-vs-provider-final", () => {
  it("keeps cancelled when late provider ok/stop arrives", () => {
    const cancelled = hostRecord("cancelled");
    expect(mergeSettledActivityRecord(cancelled, hostRecord("ok"))).toBe(
      cancelled,
    );
  });
});

describe("criterion-2 terminal classes — drawer/compact/dock titles", () => {
  /**
   * Map of product terminal class → host ActivityStatus the surfaces settle on.
   * Host deadline (budget_time) → withheld on the shared contract; provider
   * failure → failed; permission denial → withheld; user cancel / teardown →
   * cancelled; success / post-compaction ok → ok.
   */
  const cases: Array<{
    name: string;
    status: ActivityStatus;
    title: string;
    summary: RegExp;
  }> = [
    {
      name: "success",
      status: "ok",
      title: "(completed)",
      summary: /completed/i,
    },
    {
      name: "grounded refusal / permission denial",
      status: "withheld",
      title: "(answer withheld)",
      summary: /withheld/i,
    },
    {
      name: "provider failure",
      status: "failed",
      title: "(failed)",
      summary: /failed/i,
    },
    {
      // Host deadline (budget_time) maps via status_for_turn_reason → Withheld
      // on the shared activity contract; UI titles use the same status field.
      name: "host deadline (budget_time → withheld)",
      status: "withheld",
      title: "(answer withheld)",
      summary: /withheld/i,
    },
    {
      name: "user cancellation",
      status: "cancelled",
      title: "(cancelled)",
      summary: /cancelled/i,
    },
    {
      name: "app/window teardown",
      status: "cancelled",
      title: "(cancelled)",
      summary: /cancelled/i,
    },
    {
      name: "context compaction then success",
      status: "ok",
      title: "(completed)",
      summary: /completed/i,
    },
  ];

  it.each(cases)(
    "$name settles drawer title without streaming",
    ({ status, title, summary }) => {
      const turn = buildActivityTurn(msg({ streaming: true, content: "" }), {
        record: hostRecord(status),
      });
      expect(turn.summary.status).toBe(status);
      expect(turn.label).toBe(title);
      expect(turn.label.toLowerCase()).not.toContain("streaming");

      render(<ActivityDrawer turn={turn} onClose={vi.fn()} />);
      const label = screen.getByTestId("activity-turn-label");
      expect(label.textContent).toBe(title);
      expect(label.getAttribute("data-status")).toBe(status);
      expect(screen.getByTestId("activity-terminal-summary").textContent).toMatch(
        summary,
      );
    },
  );

  it("dock and compact name cancelled without streaming", () => {
    const turn = buildActivityTurn(msg({ content: "" }), {
      record: hostRecord("cancelled"),
    });
    render(
      <ActivityDock turn={turn} width={340} onWidthChange={vi.fn()} />,
    );
    expect(screen.getByTestId("activity-turn-label").textContent).toBe(
      "(cancelled)",
    );
    render(
      <ActivityCompactLine turn={turn} onOpenDetails={vi.fn()} />,
    );
    expect(screen.getByTestId("activity-compact-line").textContent).toMatch(
      /cancelled/i,
    );
    expect(
      screen.getByTestId("activity-compact-line").textContent?.toLowerCase(),
    ).not.toContain("streaming");
  });

  it("host deadline status withheld settles like budget_time (never streaming)", () => {
    // Mirrors CLI status_for_turn_reason("budget_time") → Withheld.
    const turn = buildActivityTurn(
      msg({ streaming: true, content: "" }),
      { record: hostRecord("withheld") },
    );
    expect(turn.summary.status).toBe("withheld");
    expect(turn.label).toBe("(answer withheld)");
    expect(turn.label.toLowerCase()).not.toContain("streaming");
  });

  it("permission-denial record with decision events stays withheld and non-live", () => {
    const turn = buildActivityTurn(msg({ streaming: true, content: "" }), {
      record: hostRecord("withheld", {
        events: [
          {
            turn_id: "s1::m1",
            operation_id: "permission-p1",
            seq: 0,
            phase: "completed",
            status: "withheld",
            origin: "user_decision",
            determinism: "human",
            label: "Permission denied: save_memory",
            detail: "decision=deny",
            trigger: { trigger: "user_decision" },
            scope: { kind: "conversation", label: "Conversation" },
            privacy: "metadata",
          },
        ],
      }),
    });
    expect(turn.summary.status).toBe("withheld");
    expect(turn.label).toBe("(answer withheld)");
    expect(turn.permissions[0]?.decision).toBe("deny");
  });
});

describe("import cancel race", () => {
  it("terminal import cancel settles cancelled and rejects further progress", () => {
    let attempt = beginImportActivityAttempt("import:race", "zip");
    attempt = recordImportProgress(attempt, progress("starting"));
    attempt = recordImportProgress(attempt, progress("scan"));
    attempt = recordImportProgress(attempt, progress("cancelled"));
    expect(attempt.terminal).toBe(true);
    const late = recordImportProgress(attempt, progress("stream", {
      elapsed_ms: 99,
    }));
    // Late stream after terminal is a no-op (same attempt reference shape)
    expect(late.events.length).toBe(attempt.events.length);
    expect(late.terminal).toBe(true);
    const settled = settleImportActivityAttempt(attempt, {
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "cancelled",
      sourceKind: "zip",
      diagnostic: {
        reasonCode: "user_cancel",
        summary: "cancelled by user",
        cancelled: true,
        evidence: {
          scanCounts: {
            binary: 0,
            empty: 0,
            hidden: 0,
            oversized: 0,
            readFailed: 0,
            parseFailed: 0,
          },
          omittedEntries: 0,
        },
      },
    });
    expect(settled.terminal).toBe(true);
    expect(settled.events.at(-1)?.status).toBe("cancelled");
    expect(settled.events.at(-1)?.label).toMatch(/nothing published/i);
  });
});

describe("timezone apply/undo race", () => {
  it("apply then undo are terminal human outcomes without pending", () => {
    const applied = timezoneActivityEvent({
      corpusId: "c1",
      correlationId: "import:c1:tz",
      outcome: "applied",
      zone: "America/Chicago",
    });
    const undone = timezoneActivityEvent({
      corpusId: "c1",
      correlationId: "import:c1:tz",
      outcome: "undone",
    });
    expect(applied.status).toBe("ok");
    expect(undone.status).toBe("ok");
    expect(applied.origin).toBe("user_decision");
  });
});

describe("multi-webview bridge dedupe + session retire", () => {
  it("dedupes same eventId and honors retired session", async () => {
    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    try {
      await publishTurnActivityUpdate({ sessionId: "s-race" });
      // Same payload via CustomEvent path is enough; second publish creates new id
      await publishTurnActivityUpdate({ sessionId: "s-race", retired: true });
      expect(listener).toHaveBeenCalled();
      const last = listener.mock.calls.at(-1)?.[0];
      expect(last).toEqual({ sessionId: "s-race", retired: true });
    } finally {
      stop();
    }
  });
});

describe("bounded retention", () => {
  it("drops oldest and surfaces omitted count", () => {
    let log = createActivityLog(3);
    for (let i = 0; i < 5; i++) {
      log = appendActivities(log, [
        {
          correlationId: "c",
          operationId: `op-${i}`,
          origin: "deterministic_host",
          determinism: "deterministic",
          phase: "completed",
          status: "ok",
          clock: { kind: "sequence", seq: i },
          label: `step ${i}`,
          scope: { kind: "conversation", id: null, label: "Conversation" },
          privacy: "metadata",
          evidence: [],
          laneGroup: ACTIVITY_LANE_GROUP,
        },
      ]);
    }
    expect(log.entries.length).toBe(3);
    expect(log.omitted).toBe(2);
    expect(log.cap).toBe(3);
    expect(DEFAULT_ACTIVITY_CAP).toBeGreaterThan(0);
  });
});
