import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTip } from "./HelpTip";
import { HELP_FIND_VS_FILTER } from "../lib/helpContent";
import { subscribeHelpAcrossWindows } from "../lib/help";

describe("HelpTip", () => {
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    fireEvent(window, new Event("resize"));
  });

  it("opens in a portal dialog and closes on Escape with focus restore", async () => {
    render(
      <HelpTip label="Find vs Filter" title="Find vs Filter" content={HELP_FIND_VS_FILTER} />,
    );
    const btn = screen.getByRole("button", { name: "Help: Find vs Filter" });
    fireEvent.click(btn);
    const pop = await screen.findByTestId("help-tip-popover");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.textContent).toMatch(/Find highlights/);
    // Portal: not a descendant of the tip root for clipping reasons.
    expect(document.body.contains(pop)).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("help-tip-popover")).toBeNull(),
    );
    expect(document.activeElement).toBe(btn);
  });

  it("keeps only one tip open at a time", async () => {
    render(
      <>
        <HelpTip label="A" title="Alpha" content={{ title: "Alpha", definition: "first" }} />
        <HelpTip label="B" title="Beta" content={{ title: "Beta", definition: "second" }} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: A" }));
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Help: B" }));
    await screen.findByText("second");
    await waitFor(() => expect(screen.queryByText("first")).toBeNull());
  });

  it("offers full Help deep link when locator + handler provided", async () => {
    const onOpenHelp = vi.fn();
    render(
      <HelpTip
        label="Find"
        title="Find"
        content={HELP_FIND_VS_FILTER}
        onOpenHelp={onOpenHelp}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: Find" }));
    fireEvent.click(await screen.findByTestId("help-tip-full-link"));
    expect(onOpenHelp).toHaveBeenCalledWith("log-explorer", "find-vs-filter");
  });

  it("hands full Help to the main window when opened from a standalone surface", async () => {
    const received = vi.fn();
    const unsubscribe = subscribeHelpAcrossWindows(received);
    render(
      <HelpTip
        label="Find"
        title="Find"
        content={HELP_FIND_VS_FILTER}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: Find" }));
    fireEvent.click(await screen.findByTestId("help-tip-full-link"));
    expect(received).toHaveBeenCalledWith({
      pageId: "log-explorer",
      anchor: "find-vs-filter",
    });
    unsubscribe();
  });

  it("uses a modal narrow sheet with trapped focus and restores the trigger", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 480,
    });
    fireEvent(window, new Event("resize"));
    render(
      <HelpTip
        label="Find"
        title="Find"
        content={HELP_FIND_VS_FILTER}
        onOpenHelp={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Help: Find" });
    fireEvent.click(trigger);
    const panel = await screen.findByTestId("help-tip-popover");
    expect(panel.getAttribute("data-presentation")).toBe("sheet");
    expect(panel.getAttribute("aria-modal")).toBe("true");

    const close = screen.getByRole("button", { name: "Close help" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    const full = screen.getByTestId("help-tip-full-link");
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(full);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.pointerDown(screen.getByTestId("help-tip-backdrop"));
    await waitFor(() =>
      expect(screen.queryByTestId("help-tip-popover")).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });
});
