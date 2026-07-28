import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";

const { hostReadFile } = vi.hoisted(() => ({ hostReadFile: vi.fn() }));

vi.mock("../../lib/host", () => ({
  hostOpenExternalUrl: vi.fn(),
  hostReadFile: (...args: unknown[]) => hostReadFile(...args),
}));

describe("MessageRow Help citation routing (#439)", () => {
  it("keeps raw activity and provider details collapsed by default", () => {
    const { container } = render(
      <MessageRow
        msg={{
          id: "details",
          role: "assistant",
          content: "Done.",
          streaming: false,
          trail: ["budget:rounds=12", "tool:save_memory"],
          meta: {
            model: "private-model",
            host_confirmed: true,
            provider_label: "Local provider",
            base_url: "http://127.0.0.1:11434",
          },
        }}
        turnStartedAt={null}
        effectiveChatModel="private-model"
        setSourcePath={vi.fn()}
        setSourceContent={vi.fn()}
        setPane={vi.fn()}
      />,
    );

    const activity = screen.getByText("Activity · 2 steps").closest("details");
    const responseDetails = screen
      .getByText("Response details")
      .closest("details");
    expect(activity?.hasAttribute("open")).toBe(false);
    expect(responseDetails?.hasAttribute("open")).toBe(false);
    expect(container.querySelector(".msg__meta")?.textContent).toContain(
      "private-model",
    );

    fireEvent.click(screen.getByText("Response details"));
    expect(responseDetails?.hasAttribute("open")).toBe(true);
  });

  it("opens help:// in the Help pane path and never reads it as a workspace file", () => {
    const openHelp = vi.fn();
    const setPane = vi.fn();
    render(
      <MessageRow
        msg={{
          id: "help-citation",
          role: "assistant",
          content: "Use the bundled guide.",
          streaming: false,
          citations: [
            {
              id: "help://log-analysis-pipeline#pipeline",
              label: "How log analysis works",
              title: "Pipeline",
            },
          ],
        }}
        turnStartedAt={null}
        effectiveChatModel="test"
        setSourcePath={vi.fn()}
        setSourceContent={vi.fn()}
        setPane={setPane}
        onOpenHelpCitation={openHelp}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: /Pipeline/ }));

    expect(openHelp).toHaveBeenCalledWith(
      "help://log-analysis-pipeline#pipeline",
    );
    expect(hostReadFile).not.toHaveBeenCalled();
    expect(setPane).not.toHaveBeenCalledWith("source");
  });

  it("routes a governed log citation to the attached corpus instead of file access", () => {
    const openLog = vi.fn();
    const setPane = vi.fn();
    render(
      <MessageRow
        msg={{
          id: "log-citation",
          role: "assistant",
          content: "The bounded search found one template.",
          streaming: false,
          citations: [
            {
              id: "log_template:7",
              label: "api/app.log",
              title: "Template 7",
            },
          ],
        }}
        turnStartedAt={null}
        effectiveChatModel="test"
        setSourcePath={vi.fn()}
        setSourceContent={vi.fn()}
        setPane={setPane}
        onOpenLogCitation={openLog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: /Template 7/ }));

    expect(openLog).toHaveBeenCalledWith("log_template:7");
    expect(hostReadFile).not.toHaveBeenCalled();
    expect(setPane).not.toHaveBeenCalledWith("source");
  });
});
