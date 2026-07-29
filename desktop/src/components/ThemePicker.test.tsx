import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SKINS, type SkinId } from "../lib/skins";
import { ThemePicker } from "./ThemePicker";

function ControlledPicker({
  variant = "settings",
  onChange = vi.fn(),
}: {
  variant?: "settings" | "toolbar";
  onChange?: (theme: SkinId) => void;
}) {
  const [theme, setTheme] = useState<SkinId>("slate");
  return (
    <ThemePicker
      variant={variant}
      theme={theme}
      onThemeChange={(next) => {
        onChange(next);
        setTheme(next);
      }}
    />
  );
}

describe("ThemePicker (#638)", () => {
  it("shows every registered theme with descriptions and selected semantics", async () => {
    render(<ControlledPicker />);
    const trigger = screen.getByRole("button", { name: /Theme Slate/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", {
      name: "Choose appearance theme",
    });
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(SKINS.length);
    expect(options.map((option) => option.textContent)).toEqual(
      SKINS.map((skin) => expect.stringContaining(skin.description)),
    );
    expect(
      screen.getByRole("option", { name: /Slate/ }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("option", { name: /Slate/ }),
      ),
    );
  });

  it("applies once, dismisses, and restores focus to the trigger", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /Theme Slate/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Forest/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("forest");
    expect(screen.queryByRole("listbox")).toBeNull();
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Theme Forest/ }),
    );
    vi.useRealTimers();
  });

  it("supports arrow navigation, Escape, outside dismissal, and honest focus", async () => {
    vi.useFakeTimers();
    render(
      <div>
        <ControlledPicker />
        <button type="button">Outside</button>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: /Theme Slate/ });
    fireEvent.click(trigger);
    act(() => vi.runAllTimers());
    const slate = screen.getByRole("option", { name: /Slate/ });
    expect(document.activeElement).toBe(slate);

    fireEvent.keyDown(slate, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: /Sand/ }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    act(() => vi.runAllTimers());
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.pointerDown(outside);
    outside.focus();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(outside);
    vi.useRealTimers();
  });

  it("uses the same bounded gallery from the compact titlebar trigger", () => {
    render(<ControlledPicker variant="toolbar" />);
    const trigger = screen.getByRole("button", {
      name: "Appearance, current theme Slate",
    });
    expect(trigger.getAttribute("title")).toBe("Appearance · Slate");
    fireEvent.click(trigger);
    expect(
      screen.getByRole("listbox", { name: "Choose appearance theme" }),
    ).toBeTruthy();
  });

  it("keeps option identifiers unique when both product surfaces are open", () => {
    render(
      <>
        <ControlledPicker variant="toolbar" />
        <ControlledPicker variant="settings" />
      </>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Appearance, current theme Slate",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Theme Slate/ }));

    const ids = screen
      .getAllByRole("option")
      .map((option) => option.getAttribute("id"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
