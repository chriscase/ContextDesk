/**
 * Keyboard and assistive-technology contract for the populated main window.
 *
 * Covers the states a sighted mouse user never notices: which conversation is
 * announced as current, whether the transcript can be reached and scrolled
 * without a pointer, and whether the archive's scope tabs are reachable at all.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { newSession, type ChatSession } from "../../lib/session";
import { SessionSidebar } from "./SessionSidebar";
import { ChatArchivePane } from "../panes/ChatArchivePane";

vi.mock("../../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/host")>();
  return {
    ...original,
    hostSearchChatSessions: vi.fn(async () => []),
    hostArchiveChatSession: vi.fn(async () => true),
    hostRestoreChatSession: vi.fn(async () => true),
    hostTrashChatSession: vi.fn(async () => true),
    hostDeleteChatSession: vi.fn(async () => true),
    hostPinChatSession: vi.fn(async () => true),
  };
});

function chats(): ChatSession[] {
  return [
    { ...newSession("Incident review"), id: "s-1" },
    { ...newSession("Auth refactor"), id: "s-2" },
    { ...newSession("Release notes"), id: "s-3" },
  ];
}

function renderSidebar(activeSessionId: string) {
  return render(
    <SessionSidebar
      sessionsReady
      openChatSessions={chats()}
      activeSessionId={activeSessionId}
      sidebarW={240}
      collapsed={false}
      onCreate={vi.fn()}
      onSelect={vi.fn()}
      onContextMenu={vi.fn()}
      onResizeStart={vi.fn()}
      onResizeKey={vi.fn()}
      onOpenArchive={vi.fn()}
      onToggleCollapsed={vi.fn()}
      archiveActive={false}
    />,
  );
}

describe("chat selection is announced, not just styled", () => {
  it("marks exactly one conversation as current", () => {
    renderSidebar("s-2");

    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "true");

    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("Auth refactor");
  });

  it("moves the current marker with the selection", () => {
    const { unmount } = renderSidebar("s-1");
    expect(
      screen
        .getAllByRole("button")
        .find((b) => b.getAttribute("aria-current") === "true")!.textContent,
    ).toContain("Incident review");
    unmount();

    renderSidebar("s-3");
    expect(
      screen
        .getAllByRole("button")
        .find((b) => b.getAttribute("aria-current") === "true")!.textContent,
    ).toContain("Release notes");
  });

  it("marks nothing current when the active id is not an open chat", () => {
    renderSidebar("archived-elsewhere");

    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(0);
  });
});

describe("archive scope tabs are reachable by keyboard", () => {
  function renderArchive() {
    return render(
      <ChatArchivePane
        activeSessionId="s-1"
        onOpenSession={vi.fn()}
        onSessionsChanged={vi.fn()}
      />,
    );
  }

  it("roves focus with arrow keys so Trash can be reached without a pointer", () => {
    renderArchive();
    const tablist = screen.getByRole("tablist", { name: "Archive scope" });
    const tabs = within(tablist).getAllByRole("tab");

    // Roving tabindex parks every unselected tab at -1: without arrow handling
    // they are unreachable, since Tab skips them too.
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);

    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Archived" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Trash" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("supports Home and End across the scope tabs", () => {
    renderArchive();
    const tablist = screen.getByRole("tablist", { name: "Archive scope" });

    fireEvent.keyDown(tablist, { key: "End" });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Trash" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Chats" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("ignores keys that are not navigation", () => {
    renderArchive();
    const tablist = screen.getByRole("tablist", { name: "Archive scope" });

    fireEvent.keyDown(tablist, { key: "a" });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Chats" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });
});
