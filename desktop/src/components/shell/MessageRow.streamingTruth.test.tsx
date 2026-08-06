/**
 * Host terminal status must beat a stale streaming:true flag on ordinary chat
 * rows (same settle contract as LinkedChatRail). Packaged-GUI bug class:
 * cancelled host record while the bubble still shows ThinkingIndicator /
 * data-streaming="true".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";
import type { ActivityTurn } from "../../lib/activity/types";
import type { Msg } from "../../lib/session";

vi.mock("../../lib/host", () => ({
  hostOpenExternalUrl: vi.fn(),
  hostOpenLogExplorer: vi.fn(),
  hostOpenLogExplorerTarget: vi.fn(),
  hostReadFile: vi.fn(),
  hostLogCancelInvestigationEvidencePrepare: vi.fn(),
  hostLogCommitInvestigationEvidence: vi.fn(),
  hostLogPrepareInvestigationEvidence: vi.fn(),
  hostLogQueryEventNeighborhood: vi.fn(),
}));

function baseTurn(
  messageId: string,
  status: "cancelled" | "pending",
): ActivityTurn {
  return {
    turnId: `chat::${messageId}`,
    liveRecord: true,
    label: status === "cancelled" ? "(cancelled)" : "(streaming…)",
    summary: {
      status,
      modelRounds: status === "pending" ? null : 0,
      toolCalls: status === "pending" ? null : 0,
      contextUsedChars: null,
      grounded: null,
    },
    budget: {
      usedChars: null,
      totalChars: null,
      truncationNote: null,
    },
    requestRounds: [],
    events: [],
    citations: [],
    permissions: [],
    elapsedMs: status === "cancelled" ? 1200 : null,
    droppedEvents: 0,
    contractVersion: 1,
  };
}

describe("MessageRow streaming truth after host cancel", () => {
  it("does not paint streaming chrome when host status is cancelled", () => {
    const msg: Msg = {
      id: "asst-1",
      role: "assistant",
      content: "",
      streaming: true,
    };
    render(
      <MessageRow
        msg={msg}
        turnStartedAt={Date.now() - 2000}
        effectiveChatModel="test-model"
        setSourcePath={() => {}}
        setSourceContent={() => {}}
        setPane={() => {}}
        activityMode="compact"
        activityTurn={baseTurn(msg.id, "cancelled")}
      />,
    );

    const row = screen.getByTestId("chat-msg-assistant");
    expect(row.getAttribute("data-streaming")).toBe("false");
    expect(row.textContent?.toLowerCase() ?? "").not.toMatch(/thinking|streaming/);
    // Compact Activity line must still appear so cancelled is visible.
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
  });

  it("keeps live streaming chrome when host status is still pending", () => {
    const msg: Msg = {
      id: "asst-2",
      role: "assistant",
      content: "",
      streaming: true,
    };
    render(
      <MessageRow
        msg={msg}
        turnStartedAt={Date.now() - 500}
        effectiveChatModel="test-model"
        setSourcePath={() => {}}
        setSourceContent={() => {}}
        setPane={() => {}}
        activityMode="compact"
        activityTurn={baseTurn(msg.id, "pending")}
      />,
    );

    const row = screen.getByTestId("chat-msg-assistant");
    expect(row.getAttribute("data-streaming")).toBe("true");
  });
});
