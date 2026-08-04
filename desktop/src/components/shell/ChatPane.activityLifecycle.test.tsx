import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTurnActivityRecord } from "../../lib/activity/types";
import { saveActivityMode } from "../../lib/activity/prefs";
import { publishTurnActivityUpdate } from "../../lib/activity/turnActivityUpdateBridge";
import type { Msg } from "../../lib/session";
import { ChatPane } from "./ChatPane";

const engine = vi.hoisted(() => ({
  fetchTurnActivity: vi.fn(),
  fetchDeveloperTurnActivity: vi.fn(async () => []),
}));

vi.mock("../../lib/engine/turnActivity", () => engine);
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    msg,
    activityTurn,
  }: {
    msg: Msg;
    activityTurn: {
      liveRecord: boolean;
      events: Array<{ status: string; label: string }>;
    } | null;
  }) => (
    <div data-testid={`activity-state-${msg.id}`}>
      {activityTurn?.liveRecord ? "recorded by host" : "not recorded by host"}
      {activityTurn?.events.map((event) => `${event.status}:${event.label}`).join("|")}
    </div>
  ),
}));

const message: Msg = {
  id: "assistant-1",
  role: "assistant",
  content: "I need permission to save that.",
};

function permissionRecord(resolved: boolean): HostTurnActivityRecord {
  const pending = {
    turn_id: "turn-1",
    operation_id: "permission-request-1",
    seq: 0,
    elapsed_ms: 10,
    phase: "started" as const,
    status: "pending" as const,
    origin: "deterministic_host" as const,
    determinism: "deterministic" as const,
    label: "Awaiting permission: save_memory",
    trigger: { trigger: "host_policy" as const },
    scope: { kind: "conversation" as const, id: null, label: "Conversation" },
    privacy: "metadata" as const,
  };
  return {
    version: 2,
    turn_id: "turn-1",
    session_id: "session-a",
    message_id: message.id,
    scope: { kind: "conversation", id: null, label: "Conversation" },
    status: "ok",
    total_elapsed_ms: 20,
    detail_level: "summary",
    dropped_events: 0,
    events: resolved
      ? [
          pending,
          {
            ...pending,
            seq: 1,
            elapsed_ms: null,
            phase: "completed",
            status: "ok",
            origin: "user_decision",
            determinism: "human",
            label: "Permission allowed: save_memory",
            detail: "decision=allow_once",
            trigger: { trigger: "user_decision" },
          },
        ]
      : [pending],
  };
}

function props() {
  const session = {
    id: "session-a",
    title: "Permission chat",
    messages: [message],
    compactKeepLast: 6,
    showFullHistory: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    trashed: false,
    trashedAt: null,
    pinned: false,
    titleLocked: false,
    chatModel: null,
    providerProfileId: null,
    lastReadMessageId: null,
    pinnedSkillId: null,
    linkedCorpusId: null,
  };
  return {
    branding: {
      name: "ContextDesk",
      tagline: "Developer knowledge workbench",
      slug: "contextdesk",
      version: "0.1.0",
      protocol: "cd.v1",
      channel: "dev",
    },
    openChatSessions: [session],
    resolvedSessionId: session.id,
    messages: [message],
    visibleMessages: [message],
    isFolded: false,
    hiddenCount: 0,
    compactKeep: 6,
    hiddenPreview: "",
    showFullHistory: false,
    setShowFullHistory: vi.fn(),
    openChatCtxMenu: vi.fn(),
    createSession: vi.fn(),
    setPane: vi.fn(),
    chatScrollRef: createRef<HTMLDivElement>(),
    onChatScroll: vi.fn(),
    showJumpToLatest: false,
    hasNewResponseBelow: false,
    scrollChatToBottom: vi.fn(),
    busy: false,
    turnStartedAt: null,
    effectiveChatModel: null,
    effectiveModelKey: "default",
    modelOptions: [],
    setSessionModel: vi.fn(),
    setAppDefaultModel: vi.fn(),
    onSubmit: vi.fn(async () => true),
    onStop: vi.fn(),
    preflightBlocking: false,
    openSettings: vi.fn(),
    setSourcePath: vi.fn(),
    setSourceContent: vi.fn(),
  };
}

beforeEach(() => {
  saveActivityMode("off");
  engine.fetchTurnActivity.mockReset();
});

afterEach(() => {
  cleanup();
  saveActivityMode("off");
});

describe("ChatPane late activity lifecycle", () => {
  it("replaces a pending permission record immediately without a remount", async () => {
    engine.fetchTurnActivity
      .mockResolvedValueOnce(permissionRecord(false))
      .mockResolvedValue(permissionRecord(true));
    render(<ChatPane {...props()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    const state = await screen.findByTestId("activity-state-assistant-1");
    await waitFor(() => expect(state.textContent).toContain("pending:Awaiting permission"));

    publishTurnActivityUpdate({ sessionId: "different-session" });
    expect(engine.fetchTurnActivity).toHaveBeenCalledTimes(1);
    publishTurnActivityUpdate({ sessionId: "session-a" });

    await waitFor(() =>
      expect(state.textContent).toContain("ok:Permission allowed: save_memory"),
    );
    expect(engine.fetchTurnActivity).toHaveBeenCalledTimes(2);
  });

  it("replaces cached not-recorded truth when the host record arrives live", async () => {
    engine.fetchTurnActivity
      .mockResolvedValueOnce(null)
      .mockResolvedValue(permissionRecord(true));
    render(<ChatPane {...props()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    const state = await screen.findByTestId("activity-state-assistant-1");
    await waitFor(() => expect(state.textContent).toContain("not recorded by host"));
    publishTurnActivityUpdate({ sessionId: "session-a" });
    await waitFor(() => expect(state.textContent).toMatch(/^recorded by host/));
    expect(state.textContent).not.toMatch(/^not recorded by host/);
  });
});
