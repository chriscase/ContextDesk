/**
 * Main-chat scroll / jump / unread honesty (#696).
 * Drives the real `useChatScroll` hook with a scrollable transcript.
 */
import { useState, type Dispatch, type SetStateAction } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatScroll } from "./useChatScroll";
import type { ChatSession, Msg } from "../lib/session";

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
  streaming = false,
): Msg {
  return { id, role, content, streaming };
}

type ScrollMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

function mockScrollMetrics(
  el: HTMLElement,
  opts: ScrollMetrics,
): ScrollMetrics {
  const existing = (el as HTMLElement & { __scrollMetrics?: ScrollMetrics })
    .__scrollMetrics;
  const state: ScrollMetrics = existing ?? { ...opts };
  state.scrollHeight = opts.scrollHeight;
  state.clientHeight = opts.clientHeight;
  state.scrollTop = opts.scrollTop;
  (el as HTMLElement & { __scrollMetrics?: ScrollMetrics }).__scrollMetrics =
    state;

  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => state.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v;
    },
  });
  el.scrollTo = ((options?: ScrollToOptions | number) => {
    if (typeof options === "number") {
      state.scrollTop = options;
      return;
    }
    if (options && typeof options.top === "number") {
      state.scrollTop = options.top;
    }
  }) as typeof el.scrollTo;
  return state;
}

type HarnessProps = {
  initialSessionId?: string;
  initialMessages?: Msg[];
};

function ScrollHarness({
  initialSessionId = "s1",
  initialMessages = [
    msg("u1", "user", "Hello"),
    msg("a1", "assistant", "Hi there, longer body so the transcript can scroll."),
  ],
}: HarnessProps) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  const scroll = useChatScroll(
    messages,
    sessionId,
    setSessions as Dispatch<SetStateAction<ChatSession[]>>,
  );

  return (
    <div>
      <div data-testid="session-id">{sessionId}</div>
      <div data-testid="show-jump">{String(scroll.showJumpToLatest)}</div>
      <div data-testid="has-new">{String(scroll.hasNewResponseBelow)}</div>
      <div
        ref={scroll.chatScrollRef}
        data-testid="chat-scroll"
        className="chat-scroll"
        onScroll={scroll.onChatScroll}
        style={{ height: 200, overflow: "auto" }}
      >
        {messages.map((m) => (
          <div key={m.id} data-testid={`msg-${m.id}`} style={{ height: 120 }}>
            {m.role}: {m.content}
          </div>
        ))}
      </div>
      {scroll.showJumpToLatest ? (
        <button
          type="button"
          data-testid="chat-jump-latest"
          aria-label={
            scroll.hasNewResponseBelow
              ? "New response · Jump to latest"
              : "Jump to latest"
          }
          onClick={() => scroll.scrollChatToBottom("smooth")}
        >
          {scroll.hasNewResponseBelow
            ? "New response · Jump to latest"
            : "Jump to latest"}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="detach"
        onClick={() => {
          const el = scroll.chatScrollRef.current;
          if (!el) return;
          mockScrollMetrics(el, {
            scrollHeight: 2000,
            clientHeight: 200,
            scrollTop: 0,
          });
          // Drive the shipped scroll handler (same path as the DOM onScroll prop).
          scroll.onChatScroll();
        }}
      >
        detach
      </button>
      <button
        type="button"
        data-testid="return-bottom"
        onClick={() => {
          const el = scroll.chatScrollRef.current;
          if (!el) return;
          // Near-bottom even if scrollTop stays 0: scrollHeight - clientHeight <= 120.
          mockScrollMetrics(el, {
            scrollHeight: 300,
            clientHeight: 200,
            scrollTop: 0,
          });
          scroll.onChatScroll();
        }}
      >
        return-bottom
      </button>
      <button
        type="button"
        data-testid="append-assistant"
        onClick={() =>
          setMessages((m) => [
            ...m,
            msg(`a-new-${m.length}`, "assistant", "Brand new reply"),
          ])
        }
      >
        append-assistant
      </button>
      <button
        type="button"
        data-testid="stream-same"
        onClick={() =>
          setMessages((m) => {
            const last = m[m.length - 1];
            if (!last || last.role !== "assistant") {
              return [
                ...m,
                msg("a-stream", "assistant", "chunk-1", true),
              ];
            }
            return m.map((row) =>
              row.id === last.id
                ? {
                    ...row,
                    content: `${row.content}|chunk`,
                    streaming: true,
                  }
                : row,
            );
          })
        }
      >
        stream-same
      </button>
      <button
        type="button"
        data-testid="user-send-follow"
        onClick={() =>
          setMessages((m) => [
            ...m,
            msg(`u-${m.length}`, "user", "Follow-up question"),
            msg(`a-placeholder-${m.length}`, "assistant", "", true),
          ])
        }
      >
        user-send-follow
      </button>
      <button
        type="button"
        data-testid="switch-s2"
        onClick={() => {
          setSessionId("s2");
          setMessages([
            msg("s2-u1", "user", "Session two"),
            msg("s2-a1", "assistant", "Session two answer"),
          ]);
        }}
      >
        switch-s2
      </button>
      <button
        type="button"
        data-testid="switch-s1"
        onClick={() => {
          setSessionId("s1");
          setMessages(initialMessages);
        }}
      >
        switch-s1
      </button>
      <button
        type="button"
        data-testid="switch-s1-keep-msgs"
        onClick={() => setSessionId("s1")}
      >
        switch-s1-keep
      </button>
      {/* expose sessions for read-marking side effects */}
      <div data-testid="session-count">{sessions.length}</div>
    </div>
  );
}

describe("useChatScroll (#696 main chat jump / unread)", () => {
  it("shows neutral Jump to latest after manual scroll-up with no new content", async () => {
    render(<ScrollHarness />);
    const el = screen.getByTestId("chat-scroll");
    mockScrollMetrics(el, {
      scrollHeight: 2000,
      clientHeight: 200,
      scrollTop: 1800,
    });

    fireEvent.click(screen.getByTestId("detach"));

    await waitFor(() => {
      expect(screen.getByTestId("show-jump").textContent).toBe("true");
      expect(screen.getByTestId("has-new").textContent).toBe("false");
    });
    const jump = screen.getByTestId("chat-jump-latest");
    expect(jump.textContent).toBe("Jump to latest");
    expect(jump.getAttribute("aria-label")).toBe("Jump to latest");
  });

  it("marks New response only when a new assistant message arrives while detached", async () => {
    render(<ScrollHarness />);
    fireEvent.click(screen.getByTestId("detach"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-jump-latest").textContent).toBe(
        "Jump to latest",
      ),
    );

    fireEvent.click(screen.getByTestId("append-assistant"));

    await waitFor(() => {
      expect(screen.getByTestId("has-new").textContent).toBe("true");
      expect(screen.getByTestId("chat-jump-latest").textContent).toBe(
        "New response · Jump to latest",
      );
    });
    expect(
      screen.getByTestId("chat-jump-latest").getAttribute("aria-label"),
    ).toBe("New response · Jump to latest");
  });

  it("does not re-arm or inflate on streaming chunks of the same assistant response", async () => {
    render(
      <ScrollHarness
        initialMessages={[
          msg("u1", "user", "Hello"),
          msg("a1", "assistant", "start", true),
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId("detach"));
    await waitFor(() =>
      expect(screen.getByTestId("show-jump").textContent).toBe("true"),
    );

    // First stream chunk after detach on same id — already-seen assistant id, not a new response.
    fireEvent.click(screen.getByTestId("stream-same"));
    fireEvent.click(screen.getByTestId("stream-same"));
    fireEvent.click(screen.getByTestId("stream-same"));

    await waitFor(() =>
      expect(screen.getByTestId("msg-a1").textContent).toMatch(/chunk/),
    );
    expect(screen.getByTestId("has-new").textContent).toBe("false");
    expect(screen.getByTestId("chat-jump-latest").textContent).toBe(
      "Jump to latest",
    );

    // A brand-new assistant id while still detached → new response once.
    fireEvent.click(screen.getByTestId("append-assistant"));
    await waitFor(() =>
      expect(screen.getByTestId("has-new").textContent).toBe("true"),
    );
    fireEvent.click(screen.getByTestId("stream-same"));
    fireEvent.click(screen.getByTestId("stream-same"));
    expect(screen.getByTestId("has-new").textContent).toBe("true");
    // Still a single truthful label — no numeric multi-message counter.
    expect(screen.getByTestId("chat-jump-latest").textContent).toBe(
      "New response · Jump to latest",
    );
    expect(screen.getByTestId("chat-jump-latest").textContent).not.toMatch(
      /\d+\s*new/,
    );
  });

  it("clears new-response and resumes follow when returning near the bottom", async () => {
    render(<ScrollHarness />);
    fireEvent.click(screen.getByTestId("detach"));
    fireEvent.click(screen.getByTestId("append-assistant"));
    await waitFor(() =>
      expect(screen.getByTestId("has-new").textContent).toBe("true"),
    );

    fireEvent.click(screen.getByTestId("return-bottom"));

    await waitFor(() => {
      expect(screen.getByTestId("show-jump").textContent).toBe("false");
      expect(screen.getByTestId("has-new").textContent).toBe("false");
    });
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
  });

  it("Jump activation clears unread state and hides the control", async () => {
    render(<ScrollHarness />);
    fireEvent.click(screen.getByTestId("detach"));
    fireEvent.click(screen.getByTestId("append-assistant"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-jump-latest")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("chat-jump-latest"));

    await waitFor(() => {
      expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
      expect(screen.getByTestId("show-jump").textContent).toBe("false");
      expect(screen.getByTestId("has-new").textContent).toBe("false");
    });
  });

  it("isolates follow/detach/new-response state across two sessions", async () => {
    render(<ScrollHarness />);
    // Detach s1 and receive a new response.
    fireEvent.click(screen.getByTestId("detach"));
    fireEvent.click(screen.getByTestId("append-assistant"));
    await waitFor(() =>
      expect(screen.getByTestId("has-new").textContent).toBe("true"),
    );

    // Switch to s2 (defaults to follow) — no leak of s1 new-response flag.
    fireEvent.click(screen.getByTestId("switch-s2"));
    await waitFor(() =>
      expect(screen.getByTestId("session-id").textContent).toBe("s2"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("show-jump").textContent).toBe("false");
      expect(screen.getByTestId("has-new").textContent).toBe("false");
    });

    // Detach s2 without new content.
    fireEvent.click(screen.getByTestId("detach"));
    await waitFor(() => {
      expect(screen.getByTestId("show-jump").textContent).toBe("true");
      expect(screen.getByTestId("has-new").textContent).toBe("false");
    });

    // Return to s1 — stick/new-response maps restore detached + hasNew.
    fireEvent.click(screen.getByTestId("switch-s1"));
    await waitFor(() =>
      expect(screen.getByTestId("session-id").textContent).toBe("s1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("show-jump").textContent).toBe("true");
      expect(screen.getByTestId("has-new").textContent).toBe("true");
    });
    expect(screen.getByTestId("chat-jump-latest").textContent).toBe(
      "New response · Jump to latest",
    );
  });

  it("keeps a followed transcript pinned through user send + assistant placeholder", async () => {
    render(<ScrollHarness />);
    const el = screen.getByTestId("chat-scroll");
    mockScrollMetrics(el, {
      scrollHeight: 800,
      clientHeight: 200,
      scrollTop: 600,
    });
    // Start followed (default): no jump control.
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();

    fireEvent.click(screen.getByTestId("user-send-follow"));

    await waitFor(() =>
      expect(screen.getByText(/Follow-up question/)).toBeTruthy(),
    );
    // Still following — no jump affordance while stick remains true.
    expect(screen.getByTestId("show-jump").textContent).toBe("false");
    expect(screen.queryByTestId("chat-jump-latest")).toBeNull();
  });

  it("ChatPane jump button exposes accessible name and is keyboard activatable", async () => {
    const { ChatPane } = await import("../components/shell/ChatPane");
    const scrollRef = { current: document.createElement("div") };
    const onJump = vi.fn();
    render(
      <ChatPane
        branding={{
          name: "ContextDesk",
          tagline: "t",
          slug: "contextdesk",
          version: "0.1.0",
          protocol: "cd.v1",
          channel: "dev",
        }}
        openChatSessions={[]}
        resolvedSessionId="s1"
        messages={[]}
        visibleMessages={[]}
        isFolded={false}
        hiddenCount={0}
        compactKeep={6}
        hiddenPreview=""
        showFullHistory
        setShowFullHistory={vi.fn()}
        openChatCtxMenu={vi.fn()}
        createSession={vi.fn()}
        setPane={vi.fn()}
        chatScrollRef={scrollRef}
        onChatScroll={vi.fn()}
        showJumpToLatest
        hasNewResponseBelow
        scrollChatToBottom={onJump}
        busy={false}
        turnStartedAt={null}
        effectiveChatModel={null}
        effectiveModelKey="default"
        modelOptions={[]}
        setSessionModel={vi.fn()}
        setAppDefaultModel={vi.fn()}
        onSubmit={vi.fn(async () => true)}
        onStop={vi.fn()}
        preflightBlocking={false}
        openSettings={vi.fn()}
        setSourcePath={vi.fn()}
        setSourceContent={vi.fn()}
      />,
    );
    const jump = screen.getByTestId("chat-jump-latest");
    expect(jump.getAttribute("aria-label")).toBe(
      "New response · Jump to latest",
    );
    expect(jump.textContent).toContain("New response · Jump to latest");
    jump.focus();
    expect(document.activeElement).toBe(jump);
    fireEvent.keyDown(jump, { key: "Enter", code: "Enter" });
    // Native button activates on click; simulate activation.
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalled();
  });
});
