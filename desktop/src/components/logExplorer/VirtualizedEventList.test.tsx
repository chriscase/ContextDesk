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
  measuredEventRowHeight,
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

  it("keeps populated rows painted when a shared alignment axis becomes lane-local", () => {
    const events = makeEvents(200);
    const alignedRows = Array.from({ length: 10_000 }, (_, index) => ({
      key: `slot-${index}`,
      ts: 1_700_000_000 + index,
      event: index % 50 === 0 ? events[index / 50] : null,
      height: 28,
    }));
    const props = {
      events,
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(
      <VirtualizedEventList
        {...props}
        alignedRows={alignedRows}
        linkedScrollTop={140_000}
      />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 140_000 },
    });
    fireEvent.scroll(list);

    act(() => {
      rerender(<VirtualizedEventList {...props} />);
    });

    expect((list as HTMLDivElement).scrollTop).toBeLessThanOrEqual(5_200);
    expect(Number(list.getAttribute("data-rendered"))).toBeGreaterThan(0);
    expect(list.querySelector("[data-seq]")).toBeTruthy();
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

  it("resets its reported horizontal position when empty or unmounted", () => {
    const onHorizontalScroll = vi.fn();
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
      onHorizontalScroll,
    };
    const { rerender, unmount } = render(
      <VirtualizedEventList {...props} events={makeEvents(2)} />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperty(list, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 48,
    });
    fireEvent.scroll(list);
    expect(onHorizontalScroll).toHaveBeenLastCalledWith(48);

    rerender(<VirtualizedEventList {...props} events={[]} />);
    expect(onHorizontalScroll).toHaveBeenLastCalledWith(0);

    rerender(<VirtualizedEventList {...props} events={makeEvents(2)} />);
    expect(onHorizontalScroll).toHaveBeenLastCalledWith(0);

    Object.defineProperty(
      screen.getByTestId("virtualized-event-list"),
      "scrollLeft",
      {
        configurable: true,
        writable: true,
        value: 24,
      },
    );
    fireEvent.scroll(screen.getByTestId("virtualized-event-list"));
    expect(onHorizontalScroll).toHaveBeenLastCalledWith(24);
    unmount();
    expect(onHorizontalScroll).toHaveBeenLastCalledWith(0);
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

  it("waits for a sought backend page before consuming and mounting its target", async () => {
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      onRowClick: vi.fn(),
      scrollToSeq: 50,
    };
    const { rerender } = render(
      <VirtualizedEventList {...props} events={makeEvents(8)} />,
    );
    const list = screen.getByTestId("virtualized-event-list");
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      value: 140,
    });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    expect(document.querySelector('[data-seq="50"]')).toBeNull();

    rerender(<VirtualizedEventList {...props} events={makeEvents(60)} />);

    await waitFor(() => {
      expect((list as HTMLDivElement).scrollTop).toBeGreaterThan(0);
      expect(document.querySelector('[data-seq="50"]')).toBeTruthy();
    });
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

  it("remeasures wrapped payloads from painted content without clipping or blank maximum height", async () => {
    const event = makeEvents(1)[0]!;
    event.message = `STACK_TRACE_SENTINEL ${"frame detail ".repeat(40)}`;
    const props = {
      events: [event],
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      lineMode: "full" as const,
      previewLines: 4,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(<VirtualizedEventList {...props} />);
    const message = screen.getByText(/STACK_TRACE_SENTINEL/);
    Object.defineProperty(message, "scrollHeight", {
      configurable: true,
      value: 90,
    });

    rerender(<VirtualizedEventList {...props} colWidths={[7, 2, 5, 2]} />);

    const row = document.querySelector<HTMLElement>(`[data-seq="${event.seq}"]`);
    await waitFor(() => expect(row?.style.height).toBe("102px"));
    expect(message.style.maxHeight).toBe("144px");
    expect(message.style.overflowWrap).toBe("anywhere");

    Object.defineProperty(message, "scrollHeight", {
      configurable: true,
      value: 18,
    });
    rerender(<VirtualizedEventList {...props} colWidths={[7, 2, 6, 2]} />);
    await waitFor(() => expect(row?.style.height).toBe("28px"));
  });

  it("caps measured payload height at the selected preview depth", () => {
    expect(measuredEventRowHeight(900, 28, 8)).toBe(156);
    expect(measuredEventRowHeight(18, 28, 8)).toBe(28);
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

  it("uses a compact payload-first default without hiding complete provenance", () => {
    const event = makeEvents(1)[0]!;
    event.service = "checkout-api";
    event.host = "worker-01";
    const onRowClick = vi.fn();
    render(
      <VirtualizedEventList
        events={[event]}
        timeQuality="wall"
        selected={new Set([event.seq])}
        highlight={new Set([event.seq])}
        density="comfortable"
        onRowClick={onRowClick}
      />,
    );

    const list = screen.getByTestId("virtualized-event-list");
    const row = list.querySelector<HTMLElement>(`[data-seq="${event.seq}"]`)!;
    expect(list.getAttribute("data-metadata-presentation")).toBe("compact");
    expect(list.getAttribute("data-field-emphasis")).toBe("payload");
    expect(row.classList.contains("log-explorer__row--selected")).toBe(true);
    expect(row.classList.contains("log-explorer__row--highlight")).toBe(true);
    const provenance = list.querySelector<HTMLElement>("[data-source-token]")!;
    expect(provenance.getAttribute("title")).toBe(
      `Source: ${event.source}\nService: ${event.service}\nHost: ${event.host}`,
    );
    expect(provenance.getAttribute("tabindex")).toBe("0");

    fireEvent.click(row);
    expect(onRowClick).toHaveBeenLastCalledWith(event, false);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowClick).toHaveBeenLastCalledWith(event, false);
  });

  it("disambiguates colliding compact provenance labels deterministically", () => {
    const events = makeEvents(2);
    events[0]!.source = "/srv/region-a/api.log";
    events[1]!.source = "/srv/region-b/api.log";
    events[0]!.service = "checkout-A-production";
    events[1]!.service = "checkout-B-production";
    events[0]!.host = "worker-A-production";
    events[1]!.host = "worker-B-production";
    const props = {
      timeQuality: "wall" as const,
      selected: new Set<number>(),
      highlight: new Set<number>(),
      density: "comfortable" as const,
      metadataPresentation: "compact" as const,
      onRowClick: vi.fn(),
    };
    const { rerender } = render(
      <VirtualizedEventList {...props} events={events} />,
    );

    const labelsBySource = () =>
      new Map(
        Array.from(
          screen
            .getByTestId("virtualized-event-list")
            .querySelectorAll<HTMLElement>("[data-source-token]"),
        ).map((element) => [
          element.dataset.fullSource!,
          {
            source: element.dataset.sourceToken,
            service: element.dataset.serviceToken,
            host: element.dataset.hostToken,
          },
        ]),
      );
    const firstLabels = labelsBySource();
    expect(firstLabels.get(events[0]!.source)?.source).not.toBe(
      firstLabels.get(events[1]!.source)?.source,
    );
    expect(firstLabels.get(events[0]!.source)?.service).not.toBe(
      firstLabels.get(events[1]!.source)?.service,
    );
    expect(firstLabels.get(events[0]!.source)?.host).not.toBe(
      firstLabels.get(events[1]!.source)?.host,
    );

    rerender(
      <VirtualizedEventList {...props} events={[...events].reverse()} />,
    );
    expect(labelsBySource()).toEqual(firstLabels);
  });

  it("keeps unknown compact levels textual, unique, and fully explained", () => {
    const events = makeEvents(3);
    events[0]!.level = "mystery";
    events[1]!.level = "muted";
    events[2]!.level = "error";
    render(
      <VirtualizedEventList
        events={events}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        metadataPresentation="compact"
        onRowClick={vi.fn()}
      />,
    );

    const levelTokens = Array.from(
      screen
        .getByTestId("virtualized-event-list")
        .querySelectorAll<HTMLElement>("[data-level-token]"),
    );
    const mystery = levelTokens.find(
      (token) => token.dataset.fullLevel === "mystery",
    )!;
    const muted = levelTokens.find(
      (token) => token.dataset.fullLevel === "muted",
    )!;
    const error = levelTokens.find(
      (token) => token.dataset.fullLevel === "error",
    )!;
    expect(mystery.dataset.levelToken).not.toBe(muted.dataset.levelToken);
    expect(mystery.dataset.levelToken).toMatch(/^M\?/);
    expect(error.dataset.levelToken).toBe("E");
    expect(mystery.classList.contains("log-explorer__level--other")).toBe(true);
    expect(mystery.getAttribute("aria-label")).toContain("Level mystery");
    expect(mystery.getAttribute("title")).toBe("Level: mystery");
  });

  it("exposes complete Unicode provenance to pointer and keyboard users", () => {
    const event = makeEvents(1)[0]!;
    event.source = "/var/log/服务/🚀-gateway-production.jsonl";
    event.service = "结算-服务-production";
    event.host = "主机-東京-production";
    render(
      <VirtualizedEventList
        events={[event]}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        metadataPresentation="compact"
        onRowClick={vi.fn()}
      />,
    );

    const provenance = screen.getByLabelText(
      `Source ${event.source}; Service ${event.service}; Host ${event.host}`,
    );
    expect(provenance.getAttribute("title")).toBe(
      `Source: ${event.source}\nService: ${event.service}\nHost: ${event.host}`,
    );
    expect(provenance.getAttribute("tabindex")).toBe("0");
    provenance.focus();
    expect(document.activeElement).toBe(provenance);
    expect(provenance.getAttribute("data-source-token")).toContain("🚀");
  });

  it("changes emphasis as presentation only and preserves authoritative interaction data", () => {
    const event = makeEvents(1)[0]!;
    event.source = "/logs/api/app.jsonl";
    event.service = "checkout-api";
    event.host = "node-17";
    event.message = "payload=authoritative event text";
    const original = structuredClone(event);
    const onRowClick = vi.fn();
    const onToggleExpand = vi.fn();
    render(
      <VirtualizedEventList
        events={[event]}
        timeQuality="wall"
        selected={new Set()}
        highlight={new Set()}
        density="comfortable"
        metadataPresentation="compact"
        fieldEmphasis="payload"
        onRowClick={onRowClick}
        onToggleExpand={onToggleExpand}
      />,
    );

    const list = screen.getByTestId("virtualized-event-list");
    const row = list.querySelector<HTMLElement>(`[data-seq="${event.seq}"]`)!;
    const message = screen.getByText(event.message);
    expect(list.getAttribute("data-field-emphasis")).toBe("payload");
    expect(message.getAttribute("title")).toBe(event.message);
    expect(event).toEqual(original);

    fireEvent.click(row, { ctrlKey: true });
    expect(onRowClick).toHaveBeenLastCalledWith(event, true);
    fireEvent.keyDown(row, { key: "x" });
    expect(onToggleExpand).toHaveBeenCalledWith(event.seq);
  });
});
