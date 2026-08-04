import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityInspector } from "./useActivityInspector";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
});

describe("useActivityInspector selection scope", () => {
  it("clears the selected turn and open drawer when the chat session changes", () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useActivityInspector(sessionId),
      { initialProps: { sessionId: "session-a" } },
    );

    act(() => result.current.setMode("drawer"));
    act(() => result.current.openDrawerFor("turn-a"));
    expect(result.current.selectedTurnId).toBe("turn-a");
    expect(result.current.surface).toBe("drawer");

    rerender({ sessionId: "session-b" });
    expect(result.current.selectedTurnId).toBeNull();
    expect(result.current.drawerOpen).toBe(false);
    expect(result.current.surface).toBe("none");
    expect(result.current.mode).toBe("drawer");
  });
});
