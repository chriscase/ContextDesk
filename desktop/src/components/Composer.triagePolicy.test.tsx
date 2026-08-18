import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { TriagePolicyMode } from "../lib/triagePolicyV2";

describe("Composer Triage Policy V2 control", () => {
  it("shows all modes and changing mode performs no send work", () => {
    const onSubmit = vi.fn();

    function Harness() {
      const [mode, setMode] = useState<TriagePolicyMode>("standard");
      return (
        <Composer
          onSubmit={onSubmit}
          triageMode={mode}
          onTriageModeChange={setMode}
        />
      );
    }

    render(<Harness />);
    const selector = screen.getByRole("combobox", {
      name: "Triage Policy V2 mode",
    }) as HTMLSelectElement;
    const options = screen.getAllByRole("option");

    expect(options.map((option) => option.getAttribute("value"))).toEqual([
      "standard",
      "enhanced",
      "advanced",
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      "Standard",
      "Enhanced · unavailable",
      "Advanced · unavailable",
    ]);

    fireEvent.change(selector, { target: { value: "enhanced" } });

    expect(selector.value).toBe("enhanced");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Choose Standard here/i).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps the native select keyboard operable", () => {
    const onModeChange = vi.fn();
    render(
      <Composer
        onSubmit={vi.fn()}
        triageMode="standard"
        onTriageModeChange={onModeChange}
      />,
    );
    const selector = screen.getByRole("combobox", {
      name: "Triage Policy V2 mode",
    });
    selector.focus();
    fireEvent.change(selector, { target: { value: "advanced" } });

    expect(document.activeElement).toBe(selector);
    expect(onModeChange).toHaveBeenCalledWith("advanced");
  });
});
