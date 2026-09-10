import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordedContextCombo } from "./RecordedContextCombo.js";

describe("RecordedContextCombo", () => {
  it("uses honest native datalist semantics and exact-literal match copy", () => {
    const onChange = vi.fn();
    render(<RecordedContextCombo id="product" label="Product" value="storefront" options={["Storefront"]} catalogStatus="available" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Product" });
    expect(input.getAttribute("list")).toBe("product-options");
    expect(input.getAttribute("role")).toBeNull();
    expect(input.getAttribute("aria-autocomplete")).toBeNull();
    expect(screen.queryByText("New value; it will be recorded exactly as entered.")).not.toBeNull();
    fireEvent.change(input, { target: { value: "Storefront" } });
    expect(onChange).toHaveBeenCalledWith("Storefront");
  });

  it("is truthful when values are stale or unavailable while leaving free entry enabled", () => {
    const { rerender } = render(<RecordedContextCombo id="build" label="Build" value="" options={["B-1"]} catalogStatus="stale" onChange={() => undefined} />);
    expect(screen.queryByText(/last recorded values while refresh is unavailable/i)).not.toBeNull();
    expect((screen.getByRole("combobox", { name: "Build" }) as HTMLInputElement).disabled).toBe(false);
    rerender(<RecordedContextCombo id="build" label="Build" value="" options={[]} catalogStatus="unavailable" onChange={() => undefined} />);
    expect(screen.queryByText(/recorded values are unavailable/i)).not.toBeNull();
    expect((screen.getByRole("combobox", { name: "Build" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("describes a no-read catalog without a live region and keeps free entry available", () => {
    const onChange = vi.fn();
    render(<RecordedContextCombo id="component" label="Component" value="" options={[]} catalogStatus="not-requested" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Component" });
    const hint = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Recorded values were not requested because your current access does not include reading investigations. You can still enter a value.");
    expect(hint?.getAttribute("aria-live")).toBeNull();
    expect((input as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "Gateway" } });
    expect(onChange).toHaveBeenCalledWith("Gateway");
  });

  it("describes loading, empty, and outer-whitespace normalization truthfully", () => {
    const { rerender } = render(<RecordedContextCombo id="product" label="Product" value="" options={[]} catalogStatus="loading" onChange={() => undefined} />);
    expect(screen.queryByText("Recorded values are loading. You can still enter a value.")).not.toBeNull();
    rerender(<RecordedContextCombo id="product" label="Product" value="New product" options={[]} catalogStatus="empty" normalizesOuterWhitespace onChange={() => undefined} />);
    expect(screen.queryByText("No recorded values yet. This will be saved as a new value after removing outer whitespace.")).not.toBeNull();
    rerender(<RecordedContextCombo id="product" label="Product" value=" Storefront " submittedValue="Storefront" options={["Storefront"]} catalogStatus="available" normalizesOuterWhitespace onChange={() => undefined} />);
    expect(screen.queryByText("Matches a recorded value after removing outer whitespace; it will be saved without outer whitespace.")).not.toBeNull();
    rerender(<RecordedContextCombo id="product" label="Product" value=" Storefront " submittedValue="Storefront" options={["Billing"]} catalogStatus="available" normalizesOuterWhitespace onChange={() => undefined} />);
    expect(screen.queryByText("No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.")).not.toBeNull();
  });
});
