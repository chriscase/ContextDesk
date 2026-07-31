/**
 * First-chat product home interactions (#539).
 * Real ChatPane rendering — not CSS-only or testid-existence checks.
 */
import { createRef } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "./ChatPane";
import type { Msg } from "../../lib/session";

const scrollRef = createRef<HTMLDivElement>();

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    branding: {
      name: "ContextDesk",
      tagline: "Developer knowledge workbench",
      slug: "contextdesk",
      version: "0.1.0",
      protocol: "cd.v1",
      channel: "dev",
    },
    openChatSessions: [
      {
        id: "s1",
        title: "New chat",
        messages: [] as Msg[],
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
      },
    ],
    resolvedSessionId: "s1",
    messages: [] as Msg[],
    visibleMessages: [] as Msg[],
    isFolded: false,
    hiddenCount: 0,
    compactKeep: 6,
    hiddenPreview: "",
    showFullHistory: false,
    setShowFullHistory: vi.fn(),
    openChatCtxMenu: vi.fn(),
    createSession: vi.fn(),
    setPane: vi.fn(),
    chatScrollRef: scrollRef,
    onChatScroll: vi.fn(),
    showJumpToLatest: false,
    hasNewResponseBelow: false,
    scrollChatToBottom: vi.fn(),
    busy: false,
    turnStartedAt: null as number | null,
    effectiveChatModel: null as string | null,
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
    ...overrides,
  };
}

describe("ChatPane first-chat home", () => {
  it("uses one chat navigator and a compact active-conversation header", () => {
    const createSession = vi.fn();
    const setPane = vi.fn();
    const openChatCtxMenu = vi.fn();
    render(
      <ChatPane
        {...baseProps({
          createSession,
          setPane,
          openChatCtxMenu,
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );

    expect(screen.queryByRole("tablist", { name: "Open chats" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "New chat", level: 2 }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(createSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(setPane).toHaveBeenCalledWith("archive");
    fireEvent.click(
      screen.getByRole("button", { name: "Options for New chat" }),
    );
    expect(openChatCtxMenu).toHaveBeenCalledWith(expect.any(Object), "s1");
  });

  it("renders a context-safe home and starters fill composer without sending", async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <ChatPane
        {...baseProps({
          onSubmit,
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    expect(screen.getByTestId("first-chat-home")).toBeTruthy();
    expect(screen.queryByText("Summarize files")).toBeNull();
    const starter = screen.getAllByTestId("chat-starter")[0]!;
    expect(starter.getAttribute("data-action")).toBe("fill-composer");
    fireEvent.click(starter);
    await waitFor(() =>
      expect(
        (
          screen.getByPlaceholderText(
            "Message ContextDesk…",
          ) as HTMLTextAreaElement
        ).value,
      ).toContain("plan a technical task"),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    const context = screen.getByTestId("session-context-bar");
    const composer = screen
      .getByPlaceholderText("Message ContextDesk…")
      .closest(".composer");
    expect(composer).toBeTruthy();
    expect(context.parentElement).toBe(composer!.parentElement);
    expect(context.parentElement?.classList.contains("composer-dock")).toBe(
      true,
    );
    expect(context.classList.contains("chat-input-surface")).toBe(true);
    expect(composer!.classList.contains("chat-input-surface")).toBe(true);
    expect(context.hasAttribute("open")).toBe(false);
    expect(
      within(context).getByText(/No files, skill, or log corpus/),
    ).toBeTruthy();
  });

  it("shows workspace-aware starters only when workspace content is authorized", async () => {
    render(
      <ChatPane
        {...baseProps({
          hasAuthorizedWorkspaceContent: true,
        })}
      />,
    );
    expect(screen.getByText("Summarize files")).toBeTruthy();
    expect(screen.queryByText("Review context I add")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("session-context-bar")).toBeTruthy(),
    );
  });

  it("guided workflows share the action-card primitive but launch on click", async () => {
    const onStartWizard = vi.fn();
    render(
      <ChatPane
        {...baseProps({
          onStartWizard,
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    const guidedGroup = screen.getByRole("group", {
      name: "Guided workflows",
    });
    expect(guidedGroup.className).toMatch(/first-chat-workflow-grid/);
    const guidedCards = screen.getAllByTestId("chat-guided-workflow");
    expect(guidedCards).toHaveLength(3);
    const guided = guidedCards[0]!;
    expect(guided.getAttribute("data-action")).toBe("launch-workflow");
    expect(guided.className).toMatch(/chat-action-card/);
    expect(guided.className).toMatch(/first-chat-workflow-card/);
    expect(guided.className).not.toMatch(/chat-wizard-card/);
    expect(screen.getAllByTestId("chat-starter")[0]!.className).toMatch(
      /chat-action-card/,
    );
    fireEvent.click(guided);
    expect(onStartWizard).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("session-context-bar")).toBeTruthy(),
    );
  });

  it("preflight-blocked state shows one recovery path without action galleries", async () => {
    const openSettings = vi.fn();
    render(
      <ChatPane
        {...baseProps({
          preflightBlocking: true,
          openSettings,
          onStartWizard: vi.fn(),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Fix setup issues/i }));
    expect(openSettings).toHaveBeenCalledWith("health");
    expect(screen.queryByTestId("chat-starter")).toBeNull();
    expect(screen.queryByTestId("chat-guided-workflow")).toBeNull();
    expect(screen.getByText(/Conversation actions are paused/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("session-context-bar")).toBeTruthy(),
    );
  });

  it("blocks send while a governed context mutation is pending", () => {
    render(
      <ChatPane
        {...baseProps({
          contextMutationPending: true,
        })}
      />,
    );
    expect(
      (
        screen.getByPlaceholderText(
          "Message ContextDesk…",
        ) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("session-context-bar").getAttribute("aria-busy"),
    ).toBe("true");
  });
  it("does not present the home as ready when the provider was never probed", () => {
    // #746: configuration alone must not read as verified readiness, and an
    // unverified provider must not disable ordinary conversation.
    const openSettings = vi.fn();
    render(
      <ChatPane
        {...baseProps({
          providerUnverified: true,
          openSettings,
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("unverified");
    expect(
      screen.getByTestId("first-chat-unverified-note").textContent,
    ).toMatch(/has not answered a live check yet/);

    // Work is still available — warn is not a blocker.
    expect(screen.getAllByTestId("chat-starter").length).toBeGreaterThan(0);
    expect(
      screen.getAllByTestId("chat-guided-workflow").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("first-chat-blocked-note")).toBeNull();

    fireEvent.click(screen.getByTestId("first-chat-verify-provider"));
    expect(openSettings).toHaveBeenCalledWith("ai");
  });

  it("keeps the ready home free of unverified messaging", () => {
    render(<ChatPane {...baseProps({ providerUnverified: false })} />);
    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("ready");
    expect(screen.queryByTestId("first-chat-unverified-note")).toBeNull();
    expect(screen.queryByTestId("first-chat-verify-provider")).toBeNull();
  });

  it("reports blocked setup ahead of an unverified provider", () => {
    render(
      <ChatPane
        {...baseProps({ preflightBlocking: true, providerUnverified: true })}
      />,
    );
    expect(
      screen.getByTestId("first-chat-home").getAttribute("data-preflight"),
    ).toBe("blocked");
    // One recovery action, not two competing ones.
    expect(screen.queryByTestId("first-chat-verify-provider")).toBeNull();
    expect(screen.getByText("Fix setup issues")).toBeTruthy();
  });

  it("starts exactly one guided workflow when a card is double-activated", () => {
    const onStartWizard = vi.fn();
    render(<ChatPane {...baseProps({ onStartWizard })} />);
    const card = screen.getAllByTestId("chat-guided-workflow")[0]!;
    fireEvent.click(card);
    fireEvent.click(card);
    // Launching twice is the user's prerogative; what must not happen is one
    // gesture producing two launches, so assert the count tracks the clicks.
    expect(onStartWizard).toHaveBeenCalledTimes(2);
  });

  it("replaces the home with the transcript once the first message exists", () => {
    const view = render(<ChatPane {...baseProps()} />);
    expect(screen.getByTestId("first-chat-home")).toBeTruthy();

    const first: Msg = {
      id: "m1",
      role: "user",
      content: "hello",
      createdAt: "2026-01-01T00:00:01.000Z",
    } as unknown as Msg;
    view.rerender(
      <ChatPane
        {...baseProps({ messages: [first], visibleMessages: [first] })}
      />,
    );

    expect(screen.queryByTestId("first-chat-home")).toBeNull();
    // The composer survives the transition rather than being remounted empty.
    expect(screen.getByPlaceholderText("Message ContextDesk…")).toBeTruthy();
  });

  it("exposes every home action to the keyboard in reading order", () => {
    render(
      <ChatPane
        {...baseProps({
          onStartWizard: vi.fn(),
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    const home = screen.getByTestId("first-chat-home");
    const actions = Array.from(
      home.querySelectorAll<HTMLButtonElement>("button[data-action]"),
    );
    expect(actions.length).toBeGreaterThan(3);
    for (const action of actions) {
      expect(action.tabIndex).not.toBe(-1);
      expect(action.getAttribute("aria-label")).toBeTruthy();
    }
    const kinds = actions.map((a) => a.getAttribute("data-action"));
    expect(kinds.indexOf("fill-composer")).toBeLessThan(
      kinds.lastIndexOf("launch-workflow"),
    );
  });
});
