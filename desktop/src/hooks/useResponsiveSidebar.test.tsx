import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useResponsiveSidebar } from "./useResponsiveSidebar";

type ChangeListener = (event: MediaQueryListEvent) => void;

let narrow = false;
let listeners: ChangeListener[] = [];

function emitNarrow(matches: boolean) {
  narrow = matches;
  for (const listener of listeners) {
    listener({ matches } as MediaQueryListEvent);
  }
}

beforeEach(() => {
  narrow = false;
  listeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: ChangeListener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: ChangeListener) => {
      listeners = listeners.filter((candidate) => candidate !== listener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
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
    narrow = true;
    const { result } = renderSidebar(false);
    expect(result.current.narrow).toBe(true);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.wideCollapsed).toBe(false);
  });

  it("enters narrow mode on the safe rail and restores the wide preference", () => {
    const { result } = renderSidebar(false);
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(false);

    act(() => emitNarrow(true));
    expect(result.current.narrow).toBe(true);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.wideCollapsed).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.dismissNarrow());
    expect(result.current.collapsed).toBe(true);

    act(() => emitNarrow(false));
    expect(result.current.narrow).toBe(false);
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(false);
  });

  it("keeps wide toggles durable without opening the narrow drawer", () => {
    const { result } = renderSidebar(false);
    act(() => result.current.toggle());
    expect(result.current.wideCollapsed).toBe(true);
    expect(result.current.collapsed).toBe(true);

    act(() => emitNarrow(true));
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.wideCollapsed).toBe(true);
  });
});
