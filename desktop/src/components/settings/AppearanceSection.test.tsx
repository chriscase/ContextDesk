import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SkinId } from "../../lib/skins";
import { AppearanceSection } from "./AppearanceSection";

function renderAppearance(
  theme: SkinId = "slate",
  onThemeChange = vi.fn(),
  onUiScaleChange = vi.fn(),
) {
  return {
    onThemeChange,
    onUiScaleChange,
    ...render(
      <AppearanceSection
        baseId="appearance-test"
        theme={theme}
        onThemeChange={onThemeChange}
        uiScale="100"
        onUiScaleChange={onUiScaleChange}
      />,
    ),
  };
}

describe("Appearance theme selector (#638)", () => {
  it("uses the compact shared theme gallery without crowding UI scale", () => {
    const { onUiScaleChange } = renderAppearance();
    const trigger = screen.getByRole("button", { name: /Theme Slate/ });
    expect(trigger.textContent).toContain("GitHub-adjacent dark blue-gray");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("listbox", { name: "Choose appearance theme" }),
    ).toBeTruthy();

    const scale = screen.getByRole("combobox", {
      name: "UI scale",
    }) as HTMLSelectElement;
    fireEvent.change(scale, { target: { value: "110" } });
    expect(onUiScaleChange).toHaveBeenCalledWith("110");
  });

  it("applies a registered selection immediately and updates its preview", () => {
    const onThemeChange = vi.fn();

    function ControlledAppearance() {
      const [theme, setTheme] = useState<SkinId>("dark");
      return (
        <AppearanceSection
          baseId="controlled-appearance"
          theme={theme}
          onThemeChange={(next) => {
            onThemeChange(next);
            setTheme(next);
          }}
          uiScale="100"
        />
      );
    }

    render(<ControlledAppearance />);
    fireEvent.click(screen.getByRole("button", { name: /Theme Dark/ }));
    fireEvent.click(screen.getByRole("option", { name: /Sand/ }));

    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledWith("sand");
    const trigger = screen.getByRole("button", { name: /Theme Sand/ });
    expect(trigger.textContent).toContain(
      "Warm paper light for long reading",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
