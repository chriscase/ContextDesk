import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useResponsiveSidebar } from "./useResponsiveSidebar";

function resizeTo(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  resizeTo(1_100);
});

function renderSidebar(initialWideCollapsed: boolean) {
  return renderHook(() => {
    const [wideCollapsed, setWideCollapsed] = useState(initialWideCollapsed);
    return {
      wideCollapsed,
      ...useResponsiveSidebar(wideCollapsed, setWideCollapsed),
    };
  });
}

describe("responsive chat sidebar", () => {
  it("starts a narrow window on the safe rail", () => {
    resizeTo(720);
    const { result } = renderSidebar(false);
    expect(result.current.narrow).toBe(true);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.wideCollapsed).toBe(false);
  });

  it("enters narrow mode on the safe rail and restores the wide preference", () => {
    const { result } = renderSidebar(false);
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(false);

    act(() => resizeTo(720));
    expect(result.current.narrow).toBe(true);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.wideCollapsed).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.dismissNarrow());
    expect(result.current.collapsed).toBe(true);

    act(() => resizeTo(1_100));
    expect(result.current.narrow).toBe(false);
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(false);
  });

  it("keeps wide toggles durable without opening the narrow drawer", () => {
    const { result } = renderSidebar(false);
    act(() => result.current.toggle());
    expect(result.current.wideCollapsed).toBe(true);
    expect(result.current.collapsed).toBe(true);

    act(() => resizeTo(720));
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(true);
  });
});
