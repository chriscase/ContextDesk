import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SKINS, type SkinId } from "../../lib/skins";
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

describe("Appearance theme selector (#630)", () => {
  it("uses a labeled native select containing every registered theme", () => {
    const { onUiScaleChange } = renderAppearance();
    const select = screen.getByRole("combobox", {
      name: "Theme",
    }) as HTMLSelectElement;
    const options = within(select).getAllByRole(
      "option",
    ) as HTMLOptionElement[];

    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("slate");
    expect(options.map((option) => [option.value, option.textContent])).toEqual(
      SKINS.map((skin) => [skin.id, skin.label]),
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();

    const preview = screen.getByRole("status", {
      name: "Selected theme preview",
    });
    expect(preview.textContent).toContain("Slate");
    expect(preview.textContent).toContain(
      "GitHub-adjacent dark blue-gray",
    );

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
    const select = screen.getByRole("combobox", {
      name: "Theme",
    }) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "sand" } });

    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledWith("sand");
    expect(select.value).toBe("sand");
    const preview = screen.getByRole("status", {
      name: "Selected theme preview",
    });
    expect(preview.textContent).toContain("Sand");
    expect(preview.textContent).toContain(
      "Warm paper light for long reading",
    );
  });
});
