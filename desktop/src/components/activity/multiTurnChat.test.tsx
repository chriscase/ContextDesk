/**
 * End-to-end proof over the per-turn pipeline a real chat exercises:
 * host record (as `get_turn_activity` returns it) + the ChatMsg the renderer
 * folded from stream events → `buildActivityTurn` → the rendered inspector.
 *
 * Two turns, because the interesting failures are cross-turn: a later turn's
 * record must not leak into an earlier one, and a turn the host never
 * recorded must not borrow its neighbour's numbers.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildActivityTurn } from "../../lib/activity/adapter";
import { ActivityInspectorBody } from "./ActivityInspectorBody";
import { ActivityCompactLine } from "./ActivityCompactLine";
import type { ChatMsg } from "../../lib/turn";
import type { HostTurnActivityRecord } from "../../lib/activity/types";

/** Turn 1: the model asked for a tool, got a result, then answered. */
const TURN_1_MSG: ChatMsg = {
  id: "m-assistant-1",
  role: "assistant",
  content: "Checkout failed because the payment gateway timed out.",
  trail: ["corpus_search:timeout"],
  tools: [
    { id: "tool-1", name: "search_kb", summary: "12 matches", ok: true },
    { id: "tool-2", name: "read_file_slice", summary: "48 lines", ok: true },
  ],
  citations: [
    { id: "evt-9001", label: "gateway.log", title: "gateway.log:412" },
  ],
};

const TURN_1_RECORD: HostTurnActivityRecord = {
  version: 1,
  turn_id: "s1::m-assistant-1",
  session_id: "s1",
  message_id: "m-assistant-1",
  scope: { kind: "log_corpus", id: "corpus-1", label: "Log corpus corpus-1" },
  status: "ok",
  total_elapsed_ms: 4_800,
  detail_level: "summary",
  dropped_events: 0,
  events: [
    {
      turn_id: "s1::m-assistant-1",
      operation_id: "provider-round-0",
      seq: 0,
      elapsed_ms: 1_500,
      phase: "completed",
      status: "ok",
      origin: "probabilistic_model",
      determinism: "probabilistic",
      label: "Model request (round 1)",
      detail: "finish_reason=tool_calls; requested 2 tool call(s)",
      trigger: { trigger: "user_message" },
      scope: { kind: "log_corpus", id: "corpus-1", label: "Log corpus corpus-1" },
      privacy: "metadata",
      context: {
        round: 0,
        message_count: 3,
        context_used_chars: 6_400,
        messages_capped: false,
        tool_names: ["search_kb", "read_file_slice", "cluster_problems"],
        roles: [
          { role: "system", messages: 1, chars: 4_000 },
          { role: "user", messages: 2, chars: 2_400 },
        ],
      },
    },
    {
      turn_id: "s1::m-assistant-1",
      operation_id: "provider-round-1",
      seq: 1,
      elapsed_ms: 3_100,
      phase: "completed",
      status: "ok",
      origin: "probabilistic_model",
      determinism: "probabilistic",
      label: "Model request (round 2)",
      detail: "finish_reason=stop; no tool calls",
      trigger: { trigger: "host_policy" },
      scope: { kind: "log_corpus", id: "corpus-1", label: "Log corpus corpus-1" },
      privacy: "metadata",
      context: {
        round: 1,
        message_count: 6,
        context_used_chars: 11_200,
        messages_capped: true,
        tool_names: ["search_kb", "read_file_slice", "cluster_problems"],
        roles: [{ role: "assistant", messages: 3, chars: 5_000 }],
      },
    },
  ],
};

/** Turn 2: the host recorded nothing (capture off / evicted / pre-process). */
const TURN_2_MSG: ChatMsg = {
  id: "m-assistant-2",
  role: "assistant",
  content: "No, the retry queue was unaffected.",
};

describe("a multi-turn chat with tool activity", () => {
  it("reports both provider rounds and the tools that actually ran", () => {
    const turn = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    expect(turn.liveRecord).toBe(true);
    expect(turn.summary.modelRounds).toBe(2);
    // 6,400 + 11,200 across the two rounds — summed from the record, not guessed.
    expect(turn.summary.contextUsedChars).toBe(17_600);
    expect(turn.requestRounds.map((r) => r.index)).toEqual([1, 2]);
    expect(turn.requestRounds[0]!.toolsOffered).toContain("cluster_problems");
    // Observed results attach to the final round only.
    expect(turn.requestRounds[0]!.toolsRun).toEqual([]);
    expect(turn.requestRounds[1]!.toolsRun).toEqual([
      "search_kb",
      "read_file_slice",
    ]);
  });

  it("renders host rounds and observed tool steps in one honest timeline", () => {
    const turn = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    render(<ActivityInspectorBody turn={turn} />);
    const rows = screen.getAllByTestId("activity-event-row");
    // 2 model rounds + 1 search step + 2 tools + 1 citation.
    expect(rows).toHaveLength(6);

    // The model rounds carry the contract's elapsed clock...
    const round = rows.find((r) => r.textContent?.includes("round 1"))!;
    expect(round.getAttribute("data-clock")).toBe("elapsed");
    expect(within(round).getByText("+1.5s")).toBeTruthy();

    // ...while renderer-observed steps are ordinals, with no invented timing.
    const tool = rows.find((r) => r.textContent?.includes("search_kb"))!;
    expect(tool.getAttribute("data-clock")).toBe("sequence");
    expect(tool.textContent).not.toMatch(/\b(19|20)\d{2}\b/);
  });

  it("separates deterministic work from model work in the plain summary", () => {
    const turn = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    render(<ActivityInspectorBody turn={turn} />);
    const summary = screen.getByTestId("activity-panel-summary");
    // 1 search heuristic + 2 tools + 1 citation = 4 deterministic-side steps;
    // the 2 provider rounds are the model side.
    expect(summary.textContent).toMatch(/4 steps were fixed app work/i);
    expect(summary.textContent).toMatch(/2 involved a model or an outside system/i);
    expect(summary.textContent).toMatch(/cites sources you can open/i);
  });

  it("surfaces the capped-context prefix rather than implying a full capture", () => {
    const turn = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    render(<ActivityInspectorBody turn={turn} />);
    fireEvent.click(screen.getByTestId("activity-tab-technical"));
    const technical = screen.getByTestId("activity-panel-technical");
    expect(technical.textContent).toMatch(/prefix/i);
    expect(technical.textContent).toMatch(/17,600 characters/);
    // Still no invented ceiling, even with a rich live record.
    expect(technical.textContent).toMatch(/no reported ceiling/i);
  });

  it("does NOT let a recorded turn's numbers leak into an unrecorded one", () => {
    const turn2 = buildActivityTurn(TURN_2_MSG, { record: null });
    expect(turn2.liveRecord).toBe(false);
    expect(turn2.summary.modelRounds).toBeNull();
    expect(turn2.summary.contextUsedChars).toBeNull();
    expect(turn2.requestRounds).toEqual([]);
    expect(turn2.events).toEqual([]);

    render(<ActivityInspectorBody turn={turn2} />);
    expect(screen.getByTestId("activity-not-recorded")).toBeTruthy();
    expect(screen.getByText(/No ContextDesk activity recorded/i)).toBeTruthy();
  });

  it("keeps each turn's compact line to its own facts", () => {
    const turn1 = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    const turn2 = buildActivityTurn(TURN_2_MSG, { record: null });

    const { unmount } = render(
      <ActivityCompactLine turn={turn1} onOpenDetails={vi.fn()} />,
    );
    expect(screen.getByTestId("activity-compact-line").textContent).toMatch(
      /2 model requests · 2 tool calls · 1 source cited/,
    );
    unmount();

    render(<ActivityCompactLine turn={turn2} onOpenDetails={vi.fn()} />);
    expect(screen.getByTestId("activity-compact-line").textContent).toMatch(
      /Activity was not recorded for this turn/,
    );
  });

  it("scopes a linked turn to its corpus without pulling in corpus events", () => {
    const turn = buildActivityTurn(TURN_1_MSG, { record: TURN_1_RECORD });
    const round = turn.events.find((e) => e.origin === "probabilistic_model")!;
    expect(round.scope).toEqual({
      kind: "log_corpus",
      id: "corpus-1",
      label: "Log corpus corpus-1",
    });
    expect(round.corpusId).toBe("corpus-1");
    // The citation is grounding evidence in the transcript's own sense; the
    // activity event only points at it by id, and carries no event payload.
    const citation = turn.events.find((e) => e.origin === "client_evidence")!;
    expect(citation.evidence).toEqual([{ kind: "citation", id: "evt-9001" }]);
    expect(citation).not.toHaveProperty("message");
  });

  it("marks a turn the host withheld as ungrounded, citations notwithstanding", () => {
    const withheld = buildActivityTurn(TURN_1_MSG, {
      record: { ...TURN_1_RECORD, status: "withheld" },
    });
    render(<ActivityInspectorBody turn={withheld} />);
    expect(screen.getByTestId("activity-panel-summary").textContent).toMatch(
      /cited no resolvable source/i,
    );
  });
});
