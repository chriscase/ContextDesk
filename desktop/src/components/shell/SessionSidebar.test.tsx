import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../lib/session";
import { SessionSidebar } from "./SessionSidebar";

const sessions: ChatSession[] = [
  {
    id: "s1",
    title: "Incident review",
    messages: [],
    compactKeepLast: 6,
    showFullHistory: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    trashed: false,
    trashedAt: null,
    pinned: true,
    titleLocked: false,
    chatModel: null,
    providerProfileId: null,
    lastReadMessageId: null,
    pinnedSkillId: null,
    linkedCorpusId: null,
  },
  {
    id: "s2",
    title: "Release notes",
    messages: [],
    compactKeepLast: 6,
    showFullHistory: false,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
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
];

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {},
) {
  const props: React.ComponentProps<typeof SessionSidebar> = {
    sessionsReady: true,
    openChatSessions: sessions,
    activeSessionId: "s1",
    sidebarW: 200,
    collapsed: false,
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onResizeStart: vi.fn(),
    onResizeKey: vi.fn(),
    onOpenArchive: vi.fn(),
    onToggleCollapsed: vi.fn(),
    archiveActive: false,
    ...overrides,
  };
  render(<SessionSidebar {...props} />);
  return props;
}

describe("SessionSidebar", () => {
  it("is the single expanded conversation navigator", () => {
    const props = renderSidebar();
    expect(screen.getByRole("complementary", { name: "Chat navigation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Incident review" }));
    expect(props.onSelect).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(props.onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Archive & trash" }));
    expect(props.onOpenArchive).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse chat navigation" }),
    );
    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("collapses to a labeled rail without leaving duplicate chat titles", () => {
    const props = renderSidebar({ collapsed: true });
    expect(screen.queryByRole("button", { name: "Incident review" })).toBeNull();
    expect(screen.queryByText("Release notes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(props.onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Expand chats to switch conversation" }),
    );
    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Archive and trash" }));
    expect(props.onOpenArchive).toHaveBeenCalledTimes(1);
  });
});
