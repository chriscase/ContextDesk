import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceSeverityGlyph } from "./SourceSeverityGlyph";
const counts = { errorFatal: 2, warn: 1, info: 5, debugTrace: 1, unknown: 1 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function show(total = 10, data = counts) {
  render(<SourceSeverityGlyph source="app/service.log" total={total} counts={data} />);
  return screen.getByRole("button", { name: /Severity breakdown/ });
}
describe("source severity glyph", () => {
  it("opens labeled exact counts and percentages on hover and focus", async () => {
    const button = show();
    fireEvent.mouseEnter(button);
    const popup = screen.getByRole("tooltip");
    expect(popup.textContent).toContain("10 events in current facet scope");
    expect(popup.textContent).toContain("Error / fatal2 · 20.0%");
    expect(popup.textContent).toContain("Unknown / other1 · 10.0%");
    fireEvent.mouseLeave(button);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("keeps activation open after hover and focus and bridges the pointer gap", async () => {
    const button = show();
    fireEvent.mouseEnter(button); fireEvent.focus(button);
    fireEvent.pointerDown(button); fireEvent.mouseDown(button); fireEvent.click(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(screen.getByRole("tooltip"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
  it("dismisses on Escape, outside click, scroll and resize without source selection", () => {
    const change = vi.fn();
    render(<div><label><input type="checkbox" onChange={change} />Source</label>
      <SourceSeverityGlyph source="app.log" total={10} counts={counts} /></div>);
    const button = screen.getByRole("button");
    for (const dismiss of [() => fireEvent.keyDown(document, {key:"Escape"}),
      () => fireEvent.pointerDown(document.body), () => fireEvent.scroll(window), () => fireEvent.resize(window)]) {
      fireEvent.focus(button); expect(screen.getByRole("tooltip")).toBeTruthy();
      dismiss(); expect(screen.queryByRole("tooltip")).toBeNull();
    }
    expect(change).not.toHaveBeenCalled();
  });
  it("does not turn missing, mismatched or nonfinite counters into zeros", () => {
    const { rerender } = render(<SourceSeverityGlyph source="x" total={10} />);
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").textContent).toContain("No zero counts are implied");
    rerender(<SourceSeverityGlyph source="x" total={10} counts={{...counts, info: NaN}} />);
    expect(screen.getByRole("tooltip").textContent).toContain("unavailable");
    rerender(<SourceSeverityGlyph source="x" total={99} counts={counts} />);
    expect(screen.getByRole("tooltip").textContent).not.toContain("20.0%");
  });
  it("allows scrolling long popover content without losing the focused disclosure", () => {
    const button = show(); fireEvent.focus(button);
    fireEvent.scroll(screen.getByRole("tooltip"));
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
  it("reports zero as undefined percentages, not a fabricated distribution", () => {
    show(0, {errorFatal:0,warn:0,info:0,debugTrace:0,unknown:0});
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip").textContent).toContain("percentages are not defined");
    expect(screen.getByRole("tooltip").textContent).not.toContain("NaN");
  });
  it.each([240, 900, 1600])("clamps a long-source popover inside a %ipx viewport", (width) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
    const button = show();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({left:width-50,right:width,bottom:470,top:450,width:50,height:20,x:width-50,y:450,toJSON(){}});
    fireEvent.focus(button);
    const popup = screen.getByRole("tooltip");
    const left = parseFloat(popup.style.getPropertyValue("--severity-left"));
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + Math.min(288, width-16)).toBeLessThanOrEqual(width-8);
    expect(popup.className).toContain("--above");
    expect(parseFloat(popup.style.getPropertyValue("--severity-height"))).toBeLessThanOrEqual(438);
  });
});
