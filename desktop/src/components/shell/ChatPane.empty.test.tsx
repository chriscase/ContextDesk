/**
 * First-chat product home interactions (#539).
 * Real ChatPane rendering — not CSS-only or testid-existence checks.
 */
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("renders product home and starters fill composer without sending", () => {
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
    const starter = screen.getAllByTestId("chat-starter")[0]!;
    expect(starter.getAttribute("data-action")).toBe("fill-composer");
    fireEvent.click(starter);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("guided workflows share the action-card primitive but launch on click", () => {
    const onStartWizard = vi.fn();
    render(
      <ChatPane
        {...baseProps({
          onStartWizard,
          onOpenGuidedSetup: vi.fn(),
        })}
      />,
    );
    const guided = screen.getAllByTestId("chat-guided-workflow")[0]!;
    expect(guided.getAttribute("data-action")).toBe("launch-workflow");
    expect(guided.className).toMatch(/chat-action-card/);
    expect(screen.getAllByTestId("chat-starter")[0]!.className).toMatch(
      /chat-action-card/,
    );
    fireEvent.click(guided);
    expect(onStartWizard).toHaveBeenCalled();
  });

  it("preflight-blocked state shows recovery and disables starters", () => {
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
    for (const s of screen.getAllByTestId("chat-starter")) {
      expect((s as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
