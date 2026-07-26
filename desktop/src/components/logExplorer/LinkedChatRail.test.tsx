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
import { LinkedChatRail, type AgentContextSummary } from "./LinkedChatRail";

vi.mock("../../lib/host", () => ({
  hostListChatSessionsForCorpus: vi.fn(async () => []),
  hostLoadChatSession: vi.fn(async () => null),
  hostSaveChatSession: vi.fn(),
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
    vi.mocked(host.agentTurn).mockResolvedValue([]);
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
