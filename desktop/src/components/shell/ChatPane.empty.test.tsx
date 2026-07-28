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
    setActiveSessionId: vi.fn(),
    openChatCtxMenu: vi.fn(),
    createSession: vi.fn(),
    setPane: vi.fn(),
    chatScrollRef: scrollRef,
    onChatScroll: vi.fn(),
    unreadBelow: 0,
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
        (screen.getByPlaceholderText(
          "Message ContextDesk…",
        ) as HTMLTextAreaElement).value,
      ).toContain("plan a technical task"),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    const context = screen.getByTestId("session-context-bar");
    expect(context.hasAttribute("open")).toBe(false);
    expect(within(context).getByText(/No files or skill/)).toBeTruthy();
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
    expect(
      screen.getByText(/Conversation actions are paused/i),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("session-context-bar")).toBeTruthy(),
    );
  });
});
