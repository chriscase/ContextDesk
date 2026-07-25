import { render, screen } from "@testing-library/react";
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
});
