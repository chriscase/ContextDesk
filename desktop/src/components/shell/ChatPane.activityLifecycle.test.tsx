import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTurnActivityRecord } from "../../lib/activity/types";
import { saveActivityMode, saveDeveloperActivityDetail } from "../../lib/activity/prefs";
import { publishTurnActivityUpdate } from "../../lib/activity/turnActivityUpdateBridge";
import type { Msg } from "../../lib/session";
import { ChatPane } from "./ChatPane";

const engine = vi.hoisted(() => ({
  fetchTurnActivity: vi.fn(),
  fetchDeveloperTurnActivity: vi.fn(async () => []),
}));
const hostMocks = vi.hoisted(() => ({
  suppressDeveloperActivityDetail: vi.fn(async () => undefined),
}));

vi.mock("../../lib/engine/turnActivity", () => engine);
vi.mock("../../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/host")>();
  return {
    ...original,
    hostSuppressDeveloperActivityDetail: hostMocks.suppressDeveloperActivityDetail,
  };
});
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
  saveDeveloperActivityDetail(false);
  engine.fetchTurnActivity.mockReset();
  hostMocks.suppressDeveloperActivityDetail.mockClear();
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

  // Item 2: a permission decision that resolves while Activity is Off must
  // not leave the eventual On view stuck on stale/absent state — see
  // ChatPane's subscribeTurnActivityUpdate effect for the eviction design.
  it("evicts (not fetches) on an update while Off, so turning On refetches fresh", async () => {
    engine.fetchTurnActivity
      .mockResolvedValueOnce(permissionRecord(false)) // initial load, mode On
      .mockResolvedValueOnce(permissionRecord(true)); // refetch after Off->On
    render(<ChatPane {...props()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    const state = await screen.findByTestId("activity-state-assistant-1");
    await waitFor(() => expect(state.textContent).toContain("pending:Awaiting permission"));
    expect(engine.fetchTurnActivity).toHaveBeenCalledTimes(1);

    // Turn Activity Off. The permission then resolves while Off — the
    // update must be observed (eviction), not silently missed.
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-off"));
    publishTurnActivityUpdate({ sessionId: "session-a" });

    // No new fetch while Off — eviction is local, not an IPC round trip.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.fetchTurnActivity).toHaveBeenCalledTimes(1);

    // Turn back On: the evicted cache entry must be re-fetched, landing on
    // the CURRENT (resolved) record — not the stale pending one a
    // non-evicting implementation would have kept showing.
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));
    await waitFor(() =>
      expect(state.textContent).toContain("ok:Permission allowed: save_memory"),
    );
    expect(engine.fetchTurnActivity).toHaveBeenCalledTimes(2);
  });

  // Item 3: trash/delete must invalidate this pane's cache even though this
  // pane did not initiate the trash (e.g. triggered from the archive list,
  // or — via the cross-webview bridge — from a different Tauri window).
  it("clears cached activity for a session reported retired, regardless of mode", async () => {
    engine.fetchTurnActivity
      .mockResolvedValueOnce(permissionRecord(true))
      // The host has genuinely forgotten this session's activity by the
      // time any subsequent fetch (mode is still On, so the ordinary
      // pending-fetch effect legitimately re-asks for the now-evicted
      // entry) reaches it — a retired session's record is null.
      .mockResolvedValue(null);
    render(<ChatPane {...props()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    const state = await screen.findByTestId("activity-state-assistant-1");
    await waitFor(() => expect(state.textContent).toMatch(/^recorded by host/));

    publishTurnActivityUpdate({ sessionId: "session-a", retired: true });

    // The subscription handler itself evicts synchronously; the eventual
    // settled state (after any legitimate mode-on refetch) must reflect
    // that the host has nothing for this turn — never the stale
    // pre-retirement record.
    await waitFor(() =>
      expect(state.textContent).toMatch(/^not recorded by host/),
    );
  });

  it("does not clear an unrelated session's cache on a retirement update", async () => {
    engine.fetchTurnActivity.mockResolvedValue(permissionRecord(true));
    render(<ChatPane {...props()} />);
    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-compact"));

    const state = await screen.findByTestId("activity-state-assistant-1");
    await waitFor(() => expect(state.textContent).toMatch(/^recorded by host/));

    publishTurnActivityUpdate({ sessionId: "some-other-session", retired: true });
    // Give any (incorrect) handler a turn to run before asserting nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.textContent).toMatch(/^recorded by host/);
  });
});

// Item 4: turning Developer detail off while a turn is streaming must stop
// live delivery immediately (see `suppress_developer_activity_detail`),
// not silently continue until the turn ends.
describe("ChatPane developer detail mid-turn toggle", () => {
  it("suppresses the in-flight turn when turned off while a message is streaming", async () => {
    engine.fetchTurnActivity.mockResolvedValue(null);
    const streamingMessage: Msg = { ...message, id: "assistant-2", streaming: true };
    const base = props();
    render(
      <ChatPane
        {...base}
        messages={[streamingMessage]}
        visibleMessages={[streamingMessage]}
      />,
    );

    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-developer-detail")); // On
    expect(hostMocks.suppressDeveloperActivityDetail).not.toHaveBeenCalled();

    // The developer-detail checkbox does not close the menu, so it can be
    // clicked again directly to toggle back off.
    fireEvent.click(screen.getByTestId("activity-toggle-developer-detail")); // Off, mid-stream

    await waitFor(() =>
      expect(hostMocks.suppressDeveloperActivityDetail).toHaveBeenCalledWith("session-a"),
    );
    expect(hostMocks.suppressDeveloperActivityDetail).toHaveBeenCalledTimes(1);
  });

  it("does not call suppress when turned off with no streaming turn", async () => {
    engine.fetchTurnActivity.mockResolvedValue(null);
    render(<ChatPane {...props()} />); // `message` here is not streaming

    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-developer-detail")); // On
    fireEvent.click(screen.getByTestId("activity-toggle-developer-detail")); // Off

    // Give the (would-be) call a turn to happen before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostMocks.suppressDeveloperActivityDetail).not.toHaveBeenCalled();
  });

  it("does not call suppress when turning developer detail ON", async () => {
    engine.fetchTurnActivity.mockResolvedValue(null);
    const streamingMessage: Msg = { ...message, id: "assistant-2", streaming: true };
    render(
      <ChatPane
        {...props()}
        messages={[streamingMessage]}
        visibleMessages={[streamingMessage]}
      />,
    );

    fireEvent.click(screen.getByTestId("activity-toggle-trigger"));
    fireEvent.click(screen.getByTestId("activity-toggle-developer-detail")); // Off -> On

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostMocks.suppressDeveloperActivityDetail).not.toHaveBeenCalled();
  });
});
