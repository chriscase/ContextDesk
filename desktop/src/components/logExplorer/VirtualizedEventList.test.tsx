import { act, render, screen } from "@testing-library/react";
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

  it("applies only the incremental prepend/eviction anchor adjustment", () => {
    const events = makeEvents(20);
    const props = {
      events,
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(
      <VirtualizedEventList {...props} scrollAnchorAdjust={0} />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });

    act(() => {
      rerender(<VirtualizedEventList {...props} scrollAnchorAdjust={2} />);
    });
    expect((list as HTMLDivElement).scrollTop).toBe(156);

    // A second +2 rows is cumulative=4, but must add only another 56px.
    act(() => {
      rerender(<VirtualizedEventList {...props} scrollAnchorAdjust={4} />);
    });
    expect((list as HTMLDivElement).scrollTop).toBe(212);

    // Head eviction moves the cumulative adjustment back by one row.
    act(() => {
      rerender(<VirtualizedEventList {...props} scrollAnchorAdjust={3} />);
    });
    expect((list as HTMLDivElement).scrollTop).toBe(184);
  });
});
