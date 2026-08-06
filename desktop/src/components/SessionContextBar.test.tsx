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

  it("portals Add context outside a clipped composer dock", async () => {
    const { container } = render(
      <div style={{ height: 80, overflow: "hidden" }}>
        <SessionContextBar sessionId="session-1" />
      </div>,
    );
    await waitFor(() => expect(host.list).toHaveBeenCalledWith("session-1"));
    // Expand the bar so Add context is reachable.
    fireEvent.click(screen.getByText("Context for this chat"));
    const trigger = screen.getByRole("button", { name: /Add context/ });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 12,
      right: 120,
      top: 40,
      bottom: 64,
      width: 108,
      height: 24,
      x: 12,
      y: 40,
      toJSON: () => ({}),
    });
    fireEvent.click(trigger);
    const panel = await screen.findByTestId("session-context-add-panel");
    expect(container.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain("session-context-add__panel--portal");
    // Inline viewport clamp from useLayoutEffect (styles are asserted in
    // stackingPlanes.test.ts against the stylesheet source).
    expect(panel.style.left).not.toBe("");
    expect(panel.style.bottom).not.toBe("");
    expect(panel.style.width).not.toBe("");
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
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("dismisses Add context in capture phase without stealing interactive destination focus", async () => {
    render(
      <>
        <SessionContextBar sessionId="session-1" />
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          Outside destination
        </button>
      </>,
    );

    const trigger = screen.getByRole("button", { name: /Add context/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Add context" })).toBeTruthy();

    const destination = screen.getByRole("button", {
      name: "Outside destination",
    });
    fireEvent.pointerDown(destination);
    destination.focus();

    expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
    expect(document.activeElement).toBe(destination);
  });

  it("restores trigger focus when blank-space dismissal has no focus destination", async () => {
    render(
      <>
        <SessionContextBar sessionId="session-1" />
        <div data-testid="outside-blank">Outside blank space</div>
      </>,
    );

    const trigger = screen.getByRole("button", { name: /Add context/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Add context" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId("outside-blank"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("keeps inside interactions open until a menu action dismisses it", () => {
    render(<SessionContextBar sessionId="session-1" />);

    const trigger = screen.getByRole("button", { name: /Add context/ });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Add context" });

    fireEvent.pointerDown(
      screen.getByText("Imported under this chat’s bounded context pack."),
    );
    fireEvent.click(
      screen.getByText("Imported under this chat’s bounded context pack."),
    );

    expect(screen.getByRole("dialog", { name: "Add context" })).toBe(dialog);
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
  });

  it("keeps Escape scoped to the topmost Add context peer", async () => {
    render(
      <>
        <SessionContextBar sessionId="session-1" />
        <SessionContextBar sessionId="session-2" />
      </>,
    );

    const triggers = screen.getAllByRole("button", { name: /Add context/ });
    fireEvent.click(triggers[0]);
    fireEvent.click(triggers[1]);

    expect(screen.getAllByRole("dialog", { name: "Add context" })).toHaveLength(
      1,
    );
    expect(triggers[0].getAttribute("aria-expanded")).toBe("false");
    expect(triggers[1].getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Add context" })).toBeNull();
      expect(document.activeElement).toBe(triggers[1]);
    });
    expect(triggers[0].getAttribute("aria-expanded")).toBe("false");
  });
});
