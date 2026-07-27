/**
 * Linked chat rail: follow-latest (#529), compact multi-chat (#543), tool UI (#530).
 * Tests use the real rendered rail — not source-string or helper-only assertions.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import {
  LinkedChatRail,
  shouldApplyChatLoad,
  type AgentContextSummary,
} from "./LinkedChatRail";

vi.mock("../../lib/host", () => ({
  hostListChatSessionsForCorpus: vi.fn(async () => []),
  hostLoadChatSession: vi.fn(async () => null),
  hostSaveChatSession: vi.fn(),
  hostRenameChatSession: vi.fn(),
  hostPinChatSession: vi.fn(),
  hostArchiveChatSession: vi.fn(),
  agentTurn: vi.fn(async () => []),
}));

const baseContext: AgentContextSummary = {
  corpusId: "c1",
  timeQuality: "wall",
  linkMode: false,
  lanes: ["All:[*]"],
  levels: [],
  sources: [],
  keyword: null,
  selectedCount: 0,
  bookmarkCount: 0,
  brief: "corpusId=c1; timeQuality=wall",
};

function sessionDto(
  id: string,
  title: string,
  messages: { id: string; role: string; content: string }[] = [],
): host.ChatSessionDto {
  return {
    id,
    title,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tools: null,
      citations: null,
      trail: null,
      meta: null,
    })),
    compact_keep_last: 6,
    show_full_history: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived: false,
    trashed: false,
    trashed_at: null,
    pinned: false,
    title_locked: false,
    chat_model: null,
    provider_profile_id: null,
    last_read_message_id: null,
    pinned_skill_id: null,
    linked_corpus_id: "c1",
  };
}

describe("LinkedChatRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostRenameChatSession).mockResolvedValue(null);
    vi.mocked(host.hostPinChatSession).mockResolvedValue(null);
    vi.mocked(host.hostArchiveChatSession).mockResolvedValue(null);
    vi.mocked(host.agentTurn).mockResolvedValue([]);
  });

  it("explains the bounded linked-chat context and privacy boundary", async () => {
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Help: How linked chat context works",
      }),
    );
    const help = await screen.findByRole("dialog", {
      name: "Linked chat and agent context",
    });
    expect(help.textContent).toContain("small immutable snapshot");
    expect(help.textContent).toContain("bounded result pages");
    expect(help.textContent).toContain("tools-enabled provider profile");
    expect(help.textContent).toContain("Raw corpus dumps");
    expect(help.textContent).toContain(
      "Switching chats cannot move a pending turn",
    );
  });

  it("renames, pins, archives, and reopens only the active linked chat", async () => {
    let stored = sessionDto("s1", "Incident chat");
    const meta = (): host.SessionMetaDto => ({
      id: stored.id,
      title: stored.title,
      archived: stored.archived,
      pinned: stored.pinned,
      created_at: stored.created_at,
      updated_at: stored.updated_at,
      message_count: stored.messages.length,
      preview: "",
      linked_corpus_id: "c1",
    });
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(async () => [
      meta(),
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostRenameChatSession).mockImplementation(
      async (id, title) => {
        expect(id).toBe("s1");
        stored = { ...stored, title, title_locked: true };
        return stored;
      },
    );
    vi.mocked(host.hostPinChatSession).mockImplementation(
      async (id, pinned) => {
        expect(id).toBe("s1");
        stored = { ...stored, pinned };
        return stored;
      },
    );
    vi.mocked(host.hostArchiveChatSession).mockImplementation(
      async (id, archived) => {
        expect(id).toBe("s1");
        stored = { ...stored, archived };
        return stored;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Incident chat",
      ),
    );
    fireEvent.click(await screen.findByTestId("linked-chat-manage-toggle"));
    const manage = await screen.findByRole("dialog", {
      name: "Manage Incident chat",
    });

    fireEvent.change(within(manage).getByLabelText("Chat title"), {
      target: { value: "Checkout evidence" },
    });
    fireEvent.click(within(manage).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(host.hostRenameChatSession).toHaveBeenCalledWith(
        "s1",
        "Checkout evidence",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Checkout evidence")).toBeTruthy(),
    );

    fireEvent.click(within(manage).getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(host.hostPinChatSession).toHaveBeenCalledWith("s1", true),
    );
    await waitFor(() =>
      expect(within(manage).getByRole("button", { name: "Unpin" })).toBeTruthy(),
    );

    fireEvent.click(within(manage).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(host.hostArchiveChatSession).toHaveBeenCalledWith("s1", true),
    );
    await waitFor(() =>
      expect(within(manage).getByRole("button", { name: "Reopen" })).toBeTruthy(),
    );
    fireEvent.click(within(manage).getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(host.hostArchiveChatSession).toHaveBeenLastCalledWith("s1", false),
    );

    fireEvent.keyDown(manage, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-manage")).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("linked-chat-manage-toggle"),
    );
  });

  it("keeps a compact header for 0, 1, 5, and 50 chats without stacking the list", async () => {
    const makeMetas = (n: number): host.SessionMetaDto[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `chat-${i}`,
        title: `Investigation ${i}`,
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 1,
        preview: `preview ${i}`,
        linked_corpus_id: "c1",
      }));

    for (const n of [0, 1, 5, 50]) {
      vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue(
        makeMetas(n),
      );
      const { unmount, container } = render(
        <div style={{ height: 640, display: "flex" }}>
          <LinkedChatRail
            corpusId="c1"
            corpusName="fixture"
            agentContext={baseContext}
            onApplyNav={() => undefined}
          />
        </div>,
      );
      await screen.findByTestId("linked-chat-header");
      // Steady-state: chat list is not permanently stacked above the thread.
      expect(screen.queryByTestId("linked-chat-switcher")).toBeNull();
      expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
      expect(screen.getByTestId("log-explorer-chat-composer")).toBeTruthy();
      expect(container.textContent).toMatch(
        new RegExp(`${n} chat${n === 1 ? "" : "s"}`),
      );

      if (n > 0) {
        fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
        const switcher = await screen.findByTestId("linked-chat-switcher");
        expect(within(switcher).getAllByRole("option").length).toBe(
          Math.min(n, 50),
        );
        if (n >= 8) {
          expect(
            screen.getByTestId("linked-chat-switcher-search"),
          ).toBeTruthy();
        }
        // Thread still present and not replaced by the list.
        expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
      }
      unmount();
    }
  });

  it("auto-follows appended messages while near bottom and offers jump when detached", async () => {
    let stored = sessionDto("s1", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => {
      stored = s;
      return s;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );

    let resolveTurn: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) => {
        return new Promise((resolve) => {
          resolveTurn = (events) => {
            for (const event of events) onEvent?.(event);
            resolve(events);
          };
        });
      },
    );

    render(
      <div style={{ height: 480 }}>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored.linked_corpus_id).toBe("c1"));

    // Seed a long thread so the viewport can detach.
    const longHistory = Array.from({ length: 24 }, (_, i) => ({
      id: `h-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `History line ${i} — ${"x".repeat(40)}`,
    }));
    stored = sessionDto("s1", "Logs · fixture", longHistory);
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        "Logs · fixture",
      ),
    );
    const thread = await screen.findByTestId("log-explorer-chat-thread");
    await within(thread).findByText(/History line 23/);

    // Detach: scroll to top intentionally.
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    fireEvent.scroll(thread);
    await waitFor(() =>
      expect(screen.getByTestId("linked-chat-jump-latest")).toBeTruthy(),
    );

    // Sending re-engages follow.
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Continue investigation" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-jump-latest")).toBeNull(),
    );

    await act(async () => {
      resolveTurn?.([
        {
          kind: "text_delta",
          payload: { text: "Fresh assistant evidence answer." },
        },
        { kind: "turn_completed", payload: {} },
      ]);
    });

    expect(
      await within(thread).findByText("Fresh assistant evidence answer."),
    ).toBeTruthy();
    expect(
      await within(thread).findByText("Continue investigation"),
    ).toBeTruthy();
  });

  it("persists and visibly surfaces a tools-disabled linked result", async () => {
    let stored = sessionDto("s-tools-off", "Logs · fixture");
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () => [
        {
          id: stored.id,
          title: stored.title,
          archived: false,
          pinned: false,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
          message_count: stored.messages.length,
          preview: stored.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        },
      ],
    );
    const unavailable =
      "Linked log investigation is unavailable because profile “Grok Build session” has tools disabled (capabilities.tools=false). Select or configure a tools-enabled profile in Settings → AI, then retry this linked chat.";
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _text, _fl, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "error",
            payload: {
              code: "linked_tools_unavailable",
              message: unavailable,
            },
          },
          {
            kind: "turn_completed",
            payload: { reason: "linked_tools_unavailable" },
          },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored.linked_corpus_id).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "Investigate with the linked log tools" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    const assistant = await screen.findByTestId("linked-chat-msg-assistant");
    expect(assistant.textContent).toContain(unavailable);
    expect(screen.queryByText(/I'll use .*log tool/i)).toBeNull();
    await screen.findByText("Linked chat response saved");
    await waitFor(() =>
      expect(
        stored.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes("capabilities.tools=false"),
        ),
      ).toBe(true),
    );
  });

  it("jump-to-latest restores follow mode after deliberate upward scroll", async () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Row ${i}`,
    }));
    const stored = sessionDto("s-jump", "Jump chat", history);
    vi.mocked(host.hostSaveChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: history.length,
        preview: "Row 19",
        linked_corpus_id: "c1",
      },
    ]);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Jump chat"),
    );
    const thread = await screen.findByTestId("log-explorer-chat-thread");
    await within(thread).findByText("Row 19");

    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      value: 1800,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      writable: true,
      value: 10,
    });
    fireEvent.scroll(thread);

    const jump = await screen.findByTestId("linked-chat-jump-latest");
    // Keyboard-accessible control.
    jump.focus();
    expect(document.activeElement).toBe(jump);
    fireEvent.click(jump);
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-jump-latest")).toBeNull(),
    );
  });

  it("rejects wrong-corpus nav chips fail-closed", async () => {
    const onApplyNav = vi.fn();
    vi.mocked(host.agentTurn).mockImplementation(
      async (_id, _t, _f, _m, _p, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: {
              text: 'See {"type":"log_nav","corpusId":"other","sources":["x.log"],"label":"Other corpus"}',
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const e of events) onEvent?.(e);
        return events;
      },
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (s) => s);
    vi.mocked(host.hostLoadChatSession).mockImplementation(async (id) =>
      sessionDto(id, "Logs · fixture"),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={onApplyNav}
      />,
    );
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() =>
      expect(host.hostSaveChatSession).toHaveBeenCalled(),
    );
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "nav please" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    const chip = await screen.findByTestId("linked-chat-nav-chip");
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(onApplyNav).not.toHaveBeenCalled();
  });

  it("does not permanently expose raw viewBrief dump", async () => {
    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
        developerMode={false}
      />,
    );
    expect(screen.queryByTestId("log-explorer-view-context")).toBeNull();
    expect(screen.getByTestId("linked-chat-agent-context")).toBeTruthy();
    expect(screen.queryByLabelText("Paste log_nav JSON")).toBeNull();
  });

  it("shouldApplyChatLoad rejects stale generations and mismatched ids", () => {
    expect(shouldApplyChatLoad(2, 2, "b", "b")).toBe(true);
    expect(shouldApplyChatLoad(1, 2, "a", "b")).toBe(false);
    expect(shouldApplyChatLoad(2, 2, "a", "b")).toBe(false);
    expect(shouldApplyChatLoad(3, 3, "b", null)).toBe(false);
  });

  it("late openChat for A cannot overwrite active chat B", async () => {
    const chatA = sessionDto("a", "Chat A", [
      { id: "a1", role: "user", content: "message-from-A-only" },
    ]);
    const chatB = sessionDto("b", "Chat B", [
      { id: "b1", role: "user", content: "message-from-B-only" },
    ]);
    const resolvers = new Map<string, (value: host.ChatSessionDto | null) => void>();
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: chatA.created_at,
        updated_at: chatA.updated_at,
        message_count: 1,
        preview: "A",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: chatB.created_at,
        updated_at: chatB.updated_at,
        message_count: 1,
        preview: "B",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          resolvers.set(id, resolve);
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    // Request A, then B before A resolves.
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );

    // B resolves first.
    await act(async () => {
      resolvers.get("b")?.(chatB);
    });
    await waitFor(() =>
      expect(screen.getByText("message-from-B-only")).toBeTruthy(),
    );
    expect(screen.queryByText("message-from-A-only")).toBeNull();

    // A resolves later — must not clobber B.
    await act(async () => {
      resolvers.get("a")?.(chatA);
    });
    // Allow microtasks to flush any stale setters.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("message-from-B-only")).toBeTruthy();
    expect(screen.queryByText("message-from-A-only")).toBeNull();
    expect(screen.getByTestId("linked-chat-header").textContent).toMatch(
      /Chat B/,
    );
  });

  it("late openChat error for A does not clear active chat B", async () => {
    const chatB = sessionDto("b", "Chat B", [
      { id: "b1", role: "assistant", content: "stable-B-content" },
    ]);
    const resolvers = new Map<
      string,
      {
        resolve: (value: host.ChatSessionDto | null) => void;
        reject: (err: Error) => void;
      }
    >();
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: chatB.created_at,
        updated_at: chatB.updated_at,
        message_count: 1,
        preview: "B",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      (id) =>
        new Promise((resolve, reject) => {
          resolvers.set(id, { resolve, reject });
        }),
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );
    await act(async () => {
      resolvers.get("b")?.resolve(chatB);
    });
    await waitFor(() =>
      expect(screen.getByText("stable-B-content")).toBeTruthy(),
    );
    await act(async () => {
      resolvers.get("a")?.reject(new Error("load-A-failed"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("stable-B-content")).toBeTruthy();
    expect(screen.queryByText(/load-A-failed/)).toBeNull();
  });

  it("keeps pending turn status, errors, and navigation scoped to the originating chat", async () => {
    const sessions = new Map([
      ["a", sessionDto("a", "Chat A")],
      ["b", sessionDto("b", "Chat B")],
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        [...sessions.values()].map((s) => ({
          id: s.id,
          title: s.title,
          archived: false,
          pinned: false,
          created_at: s.created_at,
          updated_at: s.updated_at,
          message_count: s.messages.length,
          preview: s.messages.at(-1)?.content ?? "",
          linked_corpus_id: "c1",
        })),
    );
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => sessions.get(id) ?? null,
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (dto) => {
      sessions.set(dto.id, dto);
      return dto;
    });

    let resolveA: ((events: host.EventDto[]) => void) | null = null;
    vi.mocked(host.agentTurn).mockImplementation(
      async (id, _text, _fl, _m, _p, onEvent) => {
        if (id === "a") {
          return new Promise((resolve) => {
            resolveA = (events) => {
              for (const event of events) onEvent?.(event);
              resolve(events);
            };
          });
        }
        const events: host.EventDto[] = [
          { kind: "text_delta", payload: { text: "B completed normally." } },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );

    const openNamedChat = async (name: string) => {
      fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
      fireEvent.click(
        within(screen.getByTestId("linked-chat-switcher")).getByText(name),
      );
    };

    await openNamedChat("Chat A");
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "investigate A" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await waitFor(() =>
      expect(screen.getByTestId("send-linked-chat").textContent).toMatch(
        /Investigating/,
      ),
    );

    // Switching to B must expose B's independent composer while A is pending.
    await openNamedChat("Chat B");
    expect((screen.getByLabelText("Chat message") as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "investigate B" },
    });
    expect((screen.getByTestId("send-linked-chat") as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    await screen.findByText("B completed normally.");
    await screen.findByText("Linked chat response saved");

    // A completes later with an A-only navigation proposal. B must not show it.
    await act(async () => {
      resolveA?.([
        {
          kind: "text_delta",
          payload: {
            text: 'A evidence {"type":"log_nav","corpusId":"c1","sources":["a.log"],"label":"A-only nav"}',
          },
        },
        { kind: "turn_completed", payload: {} },
      ]);
    });
    expect(screen.queryByText("A-only nav")).toBeNull();
    await screen.findByText("Linked chat response saved");

    await openNamedChat("Chat A");
    expect(await screen.findByText(/A evidence/)).toBeTruthy();
    expect(screen.getByText("A-only nav")).toBeTruthy();
    await screen.findByText("Linked chat response saved");
  });

  it("virtualizes long transcripts and keeps pending turns mounted", async () => {
    const history = Array.from({ length: 120 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Long thread row ${i} ${"·".repeat(20)}`,
    }));
    const stored = sessionDto("long", "Long chat", history);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: stored.id,
        title: stored.title,
        archived: false,
        pinned: false,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: history.length,
        preview: "tail",
        linked_corpus_id: "c1",
      },
    ]);

    render(
      <div style={{ height: 480 }}>
        <LinkedChatRail
          corpusId="c1"
          corpusName="fixture"
          agentContext={baseContext}
          onApplyNav={() => undefined}
        />
      </div>,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Long chat"),
    );
    const transcript = await screen.findByTestId("linked-chat-transcript");
    await waitFor(() =>
      expect(transcript.getAttribute("data-message-count")).toBe("120"),
    );
    expect(transcript.getAttribute("data-virtualized")).toBe("true");
    const mounted = Number(transcript.getAttribute("data-mounted-count"));
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(120);
    // Last row (pending/latest) remains force-mounted by the window policy.
    expect(screen.getByText(/Long thread row 119/)).toBeTruthy();
    // Early rows outside the window are not all mounted.
    const earlyMatches = screen.queryAllByText(/Long thread row 0 /);
    // Depending on scroll position, row 0 may or may not be in the overscan;
    // the key proof is mounted < total.
    expect(mounted + earlyMatches.length).toBeLessThanOrEqual(120);
  });

  it("switcher supports Escape dismissal and keyboard option focus", async () => {
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "k1",
        title: "Keyboard one",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "k2",
        title: "Keyboard two",
        archived: false,
        pinned: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    const toggle = await screen.findByTestId("linked-chat-switcher-toggle");
    fireEvent.click(toggle);
    const switcher = await screen.findByTestId("linked-chat-switcher");
    const options = within(switcher).getAllByRole("option");
    options[0]!.focus();
    fireEvent.keyDown(switcher, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(switcher, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("linked-chat-switcher")).toBeNull(),
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("scopes drafts per chat when switching", async () => {
    const a = sessionDto("a", "Chat A");
    const b = sessionDto("b", "Chat B");
    const store = new Map([
      ["a", a],
      ["b", b],
    ]);
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([
      {
        id: "a",
        title: "Chat A",
        archived: false,
        pinned: false,
        created_at: a.created_at,
        updated_at: a.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
      {
        id: "b",
        title: "Chat B",
        archived: false,
        pinned: false,
        created_at: b.created_at,
        updated_at: b.updated_at,
        message_count: 0,
        preview: "",
        linked_corpus_id: "c1",
      },
    ]);
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => store.get(id) ?? null,
    );

    render(
      <LinkedChatRail
        corpusId="c1"
        corpusName="fixture"
        agentContext={baseContext}
        onApplyNav={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "draft for A" },
    });
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat B"),
    );
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).value,
    ).toBe("");
    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText("Chat A"),
    );
    expect(
      (screen.getByLabelText("Chat message") as HTMLTextAreaElement).value,
    ).toBe("draft for A");
  });
});
