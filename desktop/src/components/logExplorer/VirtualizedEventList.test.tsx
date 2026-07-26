import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VirtualizedEventList } from "./VirtualizedEventList";
import type { ExplorerEventDto } from "../../lib/host";

function makeEvents(n: number): ExplorerEventDto[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    ts: 1_700_000_000 + i,
    timeQuality: "wall" as const,
    level: i % 5 === 0 ? "error" : "info",
    service: "api",
    host: null,
    templateId: 1,
    traceId: null,
    message: `message line ${i + 1}`,
    source: "api.log",
  }));
}

describe("VirtualizedEventList", () => {
  it("virtualizes: renders far fewer DOM rows than total events", () => {
    const events = makeEvents(500);
    render(
      <div style={{ height: 200 }}>
        <VirtualizedEventList
          events={events}
          timeQuality="wall"
          selected={new Set()}
          highlight={new Set()}
          density="comfortable"
          onRowClick={vi.fn()}
        />
      </div>,
    );
    const list = screen.getByTestId("virtualized-event-list");
    expect(list.getAttribute("data-virtualized")).toBe("true");
    expect(Number(list.getAttribute("data-total"))).toBe(500);
    const rendered = Number(list.getAttribute("data-rendered"));
    // Visible ~200px / 28px ≈ 7 + overscan*2 — well under 500
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(120);
    expect(rendered).toBeLessThan(events.length);
  });

  it("preserves a stable event pixel anchor across prepend and head eviction", () => {
    const events = makeEvents(12).slice(2);
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(
      <VirtualizedEventList {...props} events={events} />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      writable: true,
      value: 56,
    });

    act(() => {
      rerender(
        <VirtualizedEventList {...props} events={makeEvents(12)} />,
      );
    });
    expect((list as HTMLDivElement).scrollTop).toBe(112);

    // Append one newer row while evicting one row from the head.
    act(() => {
      rerender(
        <VirtualizedEventList
          {...props}
          events={makeEvents(13).slice(1)}
        />,
      );
    });
    expect((list as HTMLDivElement).scrollTop).toBe(84);
  });

  it("uses measured variable row offsets when preserving the anchor", () => {
    const base = makeEvents(8).slice(2);
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      lineMode: "full" as const,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(
      <VirtualizedEventList {...props} events={base} />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      writable: true,
      value: 96,
    });

    act(() => {
      rerender(
        <VirtualizedEventList {...props} events={makeEvents(8)} />,
      );
    });
    expect((list as HTMLDivElement).scrollTop).toBe(288);
  });

  it("requests older and newer pages when the viewport reaches either edge", () => {
    const onNearTop = vi.fn();
    const onNearBottom = vi.fn();
    const { unmount } = render(
      <VirtualizedEventList
        events={makeEvents(100)}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        onRowClick={vi.fn()}
        onNearTop={onNearTop}
      />,
    );
    const topList = screen.getByTestId("virtualized-event-list");
    Object.defineProperties(topList, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_800 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(topList);
    expect(onNearTop).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <VirtualizedEventList
        events={makeEvents(100)}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        onRowClick={vi.fn()}
        onNearBottom={onNearBottom}
      />,
    );
    const bottomList = screen.getByTestId("virtualized-event-list");
    Object.defineProperties(bottomList, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2_800 },
      scrollTop: { configurable: true, writable: true, value: 2_400 },
    });
    fireEvent.scroll(bottomList);
    expect(onNearBottom).toHaveBeenCalledTimes(1);
  });
});
