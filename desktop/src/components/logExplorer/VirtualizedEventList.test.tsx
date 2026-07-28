import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  eventRowHeight,
  VirtualizedEventList,
} from "./VirtualizedEventList";
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

  it("keeps a large shared alignment axis virtualized and renders gaps as non-events", () => {
    const events = makeEvents(100);
    const byIndex = new Map(events.map((event, index) => [index * 100, event]));
    const alignedRows = Array.from({ length: 10_000 }, (_, index) => ({
      key: `slot-${index}`,
      ts: 1_700_000_000 + index,
      event: byIndex.get(index) ?? null,
      height: 28,
    }));
    render(
      <VirtualizedEventList
        events={events}
        alignedRows={alignedRows}
        linkedScrollTop={0}
        onLinkedScrollTop={vi.fn()}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        onRowClick={vi.fn()}
      />,
    );

    const list = screen.getByTestId("virtualized-event-list");
    expect(list.getAttribute("data-total")).toBe("100");
    expect(list.getAttribute("data-aligned-slots")).toBe("10000");
    expect(Number(list.getAttribute("data-rendered"))).toBeLessThan(120);
    expect(screen.getAllByTestId("aligned-gap").length).toBeLessThan(120);
    expect(screen.queryByText("No events match filters")).toBeNull();
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
      rerender(<VirtualizedEventList {...props} events={makeEvents(12)} />);
    });
    expect((list as HTMLDivElement).scrollTop).toBe(112);

    // Append one newer row while evicting one row from the head.
    act(() => {
      rerender(
        <VirtualizedEventList {...props} events={makeEvents(13).slice(1)} />,
      );
    });
    expect((list as HTMLDivElement).scrollTop).toBe(84);
  });

  it("focuses an explicit mounted seek target once without stealing focus later", () => {
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
    };
    const onFocusToSeq = vi.fn();
    const { rerender } = render(
      <VirtualizedEventList
        {...props}
        events={makeEvents(3)}
        scrollToSeq={2}
        focusToSeq={2}
        onFocusToSeq={onFocusToSeq}
      />,
    );
    const target = document.querySelector<HTMLElement>('[data-seq="2"]');
    expect(document.activeElement).toBe(target);
    expect(onFocusToSeq).toHaveBeenCalledWith(2);

    const other = document.querySelector<HTMLElement>('[data-seq="1"]');
    other?.focus();
    rerender(
      <VirtualizedEventList
        {...props}
        events={makeEvents(4)}
        scrollToSeq={2}
        focusToSeq={null}
        onFocusToSeq={onFocusToSeq}
      />,
    );
    expect(document.activeElement).toBe(other);
    expect(onFocusToSeq).toHaveBeenCalledTimes(1);
  });

  it("uses content-aware variable row offsets when preserving the anchor", () => {
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
      rerender(<VirtualizedEventList {...props} events={makeEvents(8)} />);
    });
    // These are short one-line events, so Deep mode keeps them at 28px rather
    // than reserving its eight-line maximum: 2 × 28px + prior 96px.
    expect((list as HTMLDivElement).scrollTop).toBe(152);
  });

  it("bounds wrapped row height by actual content instead of always reserving the maximum", () => {
    const [short, multiline, long] = makeEvents(3);
    multiline!.message = "first\nsecond\nthird";
    long!.message = "x".repeat(1_000);

    expect(eventRowHeight(short!, "full", false, 28, 4)).toBe(28);
    expect(eventRowHeight(multiline!, "full", false, 28, 4)).toBe(66);
    expect(eventRowHeight(long!, "full", false, 28, 4)).toBe(156);
  });

  it("uses the user preview depth and a backend hit-centered excerpt", () => {
    const event = makeEvents(1)[0]!;
    event.message = `prefix ${"noise ".repeat(40)}NEEDLE${" tail".repeat(40)}`;
    render(
      <VirtualizedEventList
        events={[event]}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set([event.seq])}
        density="comfortable"
        lineMode="wrap"
        previewLines={12}
        matchExcerpts={{
          [event.seq]: "…near NEEDLE with bounded context…",
        }}
        onRowClick={vi.fn()}
      />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    expect(list.getAttribute("data-total-height")).toBe("28");
    const row = list.querySelector(`[data-seq="${event.seq}"]`);
    expect(row?.getAttribute("data-match-excerpt")).toBe("true");
    expect(screen.getByText(/near NEEDLE/)).toBeTruthy();
    expect(screen.getByText(/near NEEDLE/).getAttribute("aria-label")).toMatch(
      /Open the event inspector for the complete message/,
    );
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

  it("prefetches a newer page when the first page cannot fill the viewport", async () => {
    const onNearBottom = vi.fn();
    const renderList = (count: number) => (
      <VirtualizedEventList
        events={makeEvents(count)}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        onRowClick={vi.fn()}
        onNearBottom={onNearBottom}
      />
    );
    const { rerender } = render(renderList(10));
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 280 },
    });

    rerender(renderList(11));
    await waitFor(() => expect(onNearBottom).toHaveBeenCalledTimes(1));
  });

  it("does not silently retry an underfilled page after an unrelated rerender", async () => {
    const firstRequest = vi.fn();
    const replacementRequest = vi.fn();
    const renderList = (count: number, onNearBottom: () => void) => (
      <VirtualizedEventList
        events={makeEvents(count)}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        onRowClick={vi.fn()}
        onNearBottom={onNearBottom}
      />
    );
    const { rerender } = render(renderList(10, firstRequest));
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 280 },
    });

    rerender(renderList(11, firstRequest));
    await waitFor(() => expect(firstRequest).toHaveBeenCalledTimes(1));
    rerender(renderList(11, replacementRequest));
    expect(replacementRequest).not.toHaveBeenCalled();
  });
});
