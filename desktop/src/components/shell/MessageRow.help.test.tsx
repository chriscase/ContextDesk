import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";

const { hostReadFile } = vi.hoisted(() => ({ hostReadFile: vi.fn() }));

vi.mock("../../lib/host", () => ({
  hostOpenExternalUrl: vi.fn(),
  hostReadFile: (...args: unknown[]) => hostReadFile(...args),
}));

describe("MessageRow Help citation routing (#439)", () => {
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
});
