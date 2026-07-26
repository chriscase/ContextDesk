import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpTip } from "./HelpTip";
import { HELP_FIND_VS_FILTER } from "../lib/helpContent";

describe("HelpTip", () => {
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
});
