import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContextBar } from "./SessionContextBar";

const host = vi.hoisted(() => ({
  list: vi.fn(),
  skills: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/host", () => ({
  hostListSkills: host.skills,
  hostListenProcessProgress: host.listen,
  hostSessionContextImportBytes: vi.fn(),
  hostSessionContextImportZip: vi.fn(),
  hostSessionContextList: host.list,
  hostSessionContextRemove: vi.fn(),
}));

describe("SessionContextBar compact disclosure", () => {
  beforeEach(() => {
    host.list.mockReset().mockResolvedValue([]);
    host.skills.mockReset().mockResolvedValue([]);
    host.listen.mockReset().mockResolvedValue(() => {});
  });

  it("stays compact when empty and discloses the session-only boundary", async () => {
    render(<SessionContextBar sessionId="session-1" />);

    const context = screen.getByTestId("session-context-bar");
    await waitFor(() => expect(host.list).toHaveBeenCalledWith("session-1"));
    expect(context.hasAttribute("open")).toBe(false);
    expect(screen.getByText("No files or skill · session-only")).toBeTruthy();

    fireEvent.click(screen.getByText("Context for this chat"));
    await waitFor(() => expect(context.hasAttribute("open")).toBe(true));
    expect(
      screen.getByText(/They do not become permanent workspace sources/),
    ).toBeTruthy();
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
      screen.getByText("1 attached file · Skill: Incident review"),
    ).toBeTruthy();
    expect(screen.queryByText(/session-1\/context/)).toBeNull();
    expect(screen.getByText("incident.txt")).toBeTruthy();
  });
});
