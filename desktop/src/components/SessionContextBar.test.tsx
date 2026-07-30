import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContextBar } from "./SessionContextBar";

const host = vi.hoisted(() => ({
  list: vi.fn(),
  corpora: vi.fn(),
  openExplorer: vi.fn(),
  skills: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/host", () => ({
  hostListLogCorpora: host.corpora,
  hostListSkills: host.skills,
  hostListenProcessProgress: host.listen,
  hostOpenLogExplorer: host.openExplorer,
  hostSessionContextImportBytes: vi.fn(),
  hostSessionContextImportZip: vi.fn(),
  hostSessionContextList: host.list,
  hostSessionContextRemove: vi.fn(),
}));

describe("SessionContextBar compact disclosure", () => {
  beforeEach(() => {
    host.list.mockReset().mockResolvedValue([]);
    host.corpora.mockReset().mockResolvedValue([]);
    host.openExplorer.mockReset().mockResolvedValue("log-explorer-corpus-a");
    host.skills.mockReset().mockResolvedValue([]);
    host.listen.mockReset().mockResolvedValue(() => {});
  });

  it("stays compact when empty and discloses the session-only boundary", async () => {
    render(<SessionContextBar sessionId="session-1" />);

    const context = screen.getByTestId("session-context-bar");
    await waitFor(() => expect(host.list).toHaveBeenCalledWith("session-1"));
    expect(context.hasAttribute("open")).toBe(false);
    expect(
      screen.getByText("No files, skill, or log corpus · session-only"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Context for this chat"));
    await waitFor(() => expect(context.hasAttribute("open")).toBe(true));
    expect(
      screen.getByText(
        /Files stay scoped to this chat.*not an entire attached log corpus/,
      ),
    ).toBeTruthy();
  });

  it("discloses and disables context controls while host validation is pending", async () => {
    render(<SessionContextBar sessionId="session-1" updating disabled />);

    const context = screen.getByTestId("session-context-bar");
    await waitFor(() => expect(host.list).toHaveBeenCalledWith("session-1"));
    expect(context.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(/updating…/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Add context/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("opens and summarizes material file and skill context without a path dump", async () => {
    host.list.mockResolvedValue([
      {
        name: "incident.txt",
        rel_path: "session-1/context/incident.txt",
        bytes: 42,
      },
    ]);
    host.skills.mockResolvedValue([
      { id: "incident-review", name: "Incident review", disabled: false },
    ]);

    render(
      <SessionContextBar
        sessionId="session-1"
        pinnedSkillId="incident-review"
        onPinnedSkillChange={vi.fn()}
      />,
    );

    const context = screen.getByTestId("session-context-bar");
    await waitFor(() => expect(context.hasAttribute("open")).toBe(true));
    expect(
      screen.getByText(
        "1 attached file · Skill: Incident review · No log corpus",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/session-1\/context/)).toBeNull();
    expect(screen.getByText("incident.txt")).toBeTruthy();
  });

  it("attaches one imported corpus from the compact Add context dialog", async () => {
    host.corpora.mockResolvedValue([
      {
        id: "corpus-a",
        name: "Incident logs",
        eventCount: 25000,
        templateCount: 120,
        engine: "duckdb",
        createdAt: 1,
        sourceLabel: null,
        stats: null,
        topTemplates: [],
      },
    ]);
    const onLinkedCorpusChange = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionContextBar
        sessionId="session-1"
        onLinkedCorpusChange={onLinkedCorpusChange}
      />,
    );

    fireEvent.click(screen.getByText("Context for this chat"));
    fireEvent.click(screen.getByRole("button", { name: /Add context/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add context" });
    expect(dialog.textContent).toContain("Files…");
    expect(dialog.textContent).toContain("Folder…");
    fireEvent.click(
      await screen.findByRole("button", { name: /Incident logs/ }),
    );

    await waitFor(() =>
      expect(onLinkedCorpusChange).toHaveBeenCalledWith("corpus-a"),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Add context/ }),
      );
    });
  });

  it("shows availability, event count, Explorer action, and reversible detach", async () => {
    host.corpora.mockResolvedValue([
      {
        id: "corpus-a",
        name: "Incident logs",
        eventCount: 25000,
        templateCount: 120,
        engine: "duckdb",
        createdAt: 1,
        sourceLabel: null,
        stats: null,
        topTemplates: [],
      },
    ]);
    const onLinkedCorpusChange = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionContextBar
        sessionId="session-1"
        linkedCorpusId="corpus-a"
        onLinkedCorpusChange={onLinkedCorpusChange}
      />,
    );

    expect(await screen.findByText("Incident logs")).toBeTruthy();
    expect(screen.getByText("25,000 events · available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Explorer" }));
    await waitFor(() =>
      expect(host.openExplorer).toHaveBeenCalledWith("corpus-a"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Detach Incident logs" }),
    );
    await waitFor(() =>
      expect(onLinkedCorpusChange).toHaveBeenCalledWith(null),
    );
  });

  it("fails stale corpus context closed and dismisses Add context with Escape", async () => {
    const triggerName = "Add context";
    render(
      <SessionContextBar
        sessionId="session-1"
        linkedCorpusId="discarded-corpus"
        onLinkedCorpusChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/grounded log chat is blocked/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Open in Explorer" })
        .hasAttribute("disabled"),
    ).toBe(true);

    const trigger = screen.getByRole("button", { name: /Add context/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: triggerName })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: triggerName })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses Add context on an outside pointer without stealing destination focus", async () => {
    render(
      <>
        <SessionContextBar sessionId="session-1" />
        <button type="button">Outside destination</button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: /Add context/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Add context" })).toBeTruthy();

    const destination = screen.getByRole("button", {
      name: "Outside destination",
    });
    fireEvent.mouseDown(destination);
    destination.focus();

    expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
    expect(document.activeElement).toBe(destination);
  });
});
