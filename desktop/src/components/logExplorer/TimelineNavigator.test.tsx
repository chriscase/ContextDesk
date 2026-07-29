import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import { TimelineNavigator } from "./TimelineNavigator";

vi.mock("../../lib/host", () => ({
  hostLogSharedTimelineSummary: vi.fn(),
  hostLogQueryEvents: vi.fn(),
}));

const summary: host.SharedTimelineSummaryDto = {
  timeQuality: "wall",
  spanFrom: 1_700_000_000,
  spanTo: 1_700_000_040,
  bucketWidth: 10,
  bucketCount: 4,
  totalMatched: 42,
  buckets: [
    { index: 0, start: 1_700_000_000, end: 1_700_000_010 },
    { index: 1, start: 1_700_000_010, end: 1_700_000_020 },
    { index: 2, start: 1_700_000_020, end: 1_700_000_030 },
    { index: 3, start: 1_700_000_030, end: 1_700_000_040 },
  ],
  counts: [30, 0, 0, 12],
  severitySeries: [
    { severity: "error", counts: [1, 0, 0, 12] },
    { severity: "warn", counts: [0, 0, 0, 0] },
    { severity: "info", counts: [29, 0, 0, 0] },
    { severity: "debug", counts: [0, 0, 0, 0] },
    { severity: "other", counts: [0, 0, 0, 0] },
  ],
  lanes: [],
};

const target: host.ExplorerEventDto = {
  seq: 77,
  ts: 1_700_000_031,
  timeQuality: "wall",
  level: "error",
  service: null,
  host: null,
  templateId: 1,
  traceId: null,
  message: "target event",
  source: "api.log",
};

const sessionMetrics = {
  schemaVersion: 1,
  id: "performance-run",
  name: "Performance run",
  series: [
    {
      id: "cpu-percent",
      name: "CPU",
      unit: "%",
      timeQuality: "wall",
      provenance: { source: "synthetic test" },
      points: [
        { timestamp: 1_700_000_000, value: 20 },
        { timestamp: 1_700_000_040, value: 95 },
      ],
    },
    {
      id: "heap-bytes",
      name: "Heap",
      unit: "bytes",
      timeQuality: "wall",
      provenance: { source: "synthetic test" },
      points: [
        { timestamp: 1_700_000_000, value: 400_000_000 },
        { timestamp: 1_700_000_040, value: 800_000_000 },
      ],
    },
    {
      id: "clients",
      name: "Concurrent clients",
      unit: "clients",
      timeQuality: "wall",
      provenance: { source: "synthetic test" },
      points: [
        { timestamp: 1_700_000_000, value: 10 },
        { timestamp: 1_700_000_040, value: 120 },
      ],
    },
  ],
};

function metricFile(value: unknown, name = "metrics.json") {
  const json = JSON.stringify(value);
  const file = new File([json], name, { type: "application/json" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: async () => json,
  });
  return file;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function moveTimelineTo(index: number, commit = false) {
  const scrubber = screen.getByLabelText("Timeline position");
  fireEvent.change(scrubber, { target: { value: String(index) } });
  if (commit) {
    fireEvent.pointerUp(scrubber, { target: { value: String(index) } });
  }
  return scrubber;
}

describe("TimelineNavigator", () => {
  it("keeps the timeline on a full lane-strip row when adjacent disclosures can fit", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    const navigator = await screen.findByTestId("timeline-navigator");
    const style = getComputedStyle(navigator);
    expect(style.flexBasis).toBe("100%");
    expect(style.flexShrink).toBe("0");
    expect(style.maxWidth).toBe("100%");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue(summary);
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
  });

  it("is visible by default, collapses accessibly, and does no work while closed", async () => {
    const { rerender } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
        "c1",
        { levels: ["error"] },
        [],
        96,
      ),
    );
    expect(screen.getAllByTestId(/^timeline-bucket-/)).toHaveLength(4);
    expect(screen.getByText(/42 matching events summarized/)).toBeTruthy();
    const toggle = screen.getByTestId("timeline-navigator-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse timeline");

    fireEvent.click(toggle);
    const collapsedToggle = screen.getByTestId("timeline-navigator-toggle");
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(collapsedToggle.getAttribute("aria-label")).toBe("Expand timeline");
    expect(screen.getByText("Collapsed · no timeline work")).toBeTruthy();
    const callsWhileOpen = vi.mocked(host.hostLogSharedTimelineSummary).mock
      .calls.length;
    rerender(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["warning"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(
      callsWhileOpen,
    );

    collapsedToggle.focus();
    fireEvent.click(collapsedToggle);
    const reopenedToggle = screen.getByTestId("timeline-navigator-toggle");
    expect(reopenedToggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(reopenedToggle));
    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(
        callsWhileOpen + 1,
      ),
    );
  });

  it("closes on Escape and restores focus to the disclosure", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    fireEvent.focus(scrubber);
    expect(screen.getByTestId("timeline-bucket-detail")).toBeTruthy();
    fireEvent.keyDown(scrubber, { key: "Escape" });
    expect(screen.queryByTestId("timeline-bucket-detail")).toBeNull();
    expect(
      screen
        .getByTestId("timeline-navigator-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.keyDown(scrubber, { key: "Escape" });
    expect(
      screen
        .getByTestId("timeline-navigator-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("timeline-navigator-toggle"),
      ),
    );
  });

  it("does not duplicate the global summary query for one visible lane", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: ["api.log"] }}
        residentEvents={[]}
        lanes={[{ id: "lane-1", label: "API", sources: ["api.log"] }]}
        onSeekSeq={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(1),
    );
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
      "c1",
      { sources: ["api.log"] },
      [],
      96,
    );
    expect(screen.queryByTestId("timeline-lane-coverage")).toBeNull();
  });

  it("does not broaden an empty visible-lane source intersection", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: [] }}
        emptySourceScope
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No events match the visible lane sources"),
    ).toBeTruthy();
    expect(host.hostLogSharedTimelineSummary).not.toHaveBeenCalled();
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
  });

  it("seeks one bounded bucket page then delegates stable neighborhood loading", async () => {
    const onSeekSeq = vi.fn(async () => {});
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: ["api.log"] }}
        residentEvents={[target]}
        onSeekSeq={onSeekSeq}
      />,
    );
    await screen.findByTestId("timeline-bucket-3");
    moveTimelineTo(3, true);

    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sources: ["api.log"],
          timeFrom: 1_700_000_030,
          timeTo: 1_700_000_040,
          limit: 1,
        }),
      ),
    );
    expect(onSeekSeq).toHaveBeenCalledWith(77, target);
    expect(screen.getByText(/Moved to seq 77/)).toBeTruthy();
    expect(screen.getByTestId("timeline-bucket-3").className).toContain(
      "resident",
    );
  });

  it("previews range dragging without querying until the position is committed", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const range = await screen.findByLabelText("Timeline position");
    fireEvent.change(range, { target: { value: "3" } });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    expect(screen.getByTestId("timeline-bucket-detail").textContent).toContain(
      "12 events",
    );
    fireEvent.pointerUp(range, { target: { value: "3" } });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
  });

  it("materializes zero buckets and exposes stacked canonical levels", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      counts: [30, 0, 0, 0],
      severitySeries: [
        { severity: "error", counts: [4, 0, 0, 0] },
        { severity: "warn", counts: [3, 0, 0, 0] },
        { severity: "info", counts: [12, 0, 0, 0] },
        { severity: "debug", counts: [6, 0, 0, 0] },
        { severity: "other", counts: [5, 0, 0, 0] },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[target]}
        onSeekSeq={vi.fn()}
      />,
    );
    const first = await screen.findByTestId("timeline-bucket-0");
    expect(first.querySelectorAll(".timeline-navigator__stack i")).toHaveLength(
      5,
    );
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(
      screen.getByLabelText("Timeline position").getAttribute("aria-valuetext"),
    ).toContain("Other 5");
    expect(screen.getByTestId("timeline-bucket-1").className).toContain(
      "timeline-navigator__bucket--empty",
    );
    expect(screen.getAllByTestId(/^timeline-bucket-/)).toHaveLength(4);
    expect(screen.getByTestId("timeline-resident-range")).toBeTruthy();
  });

  it("keeps controls inside a full-width track instead of reserving a side column", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    const track = await screen.findByTestId("timeline-navigator-track");
    expect(track.querySelector(".timeline-navigator__topline")).toBeTruthy();
    expect(track.querySelector(".timeline-navigator__chart")).toBeTruthy();
    expect(screen.getByTestId("timeline-current-summary").textContent).toMatch(
      /^\d{2}:\d{2}:\d{2}Z · 30 events$/,
    );
    expect(screen.queryByText("Timeline data")).toBeNull();
    expect(screen.getByTestId("timeline-bucket-0").className).toContain(
      "timeline-navigator__bucket--has-error",
    );
    expect(screen.getByTestId("timeline-bucket-3").className).toContain(
      "timeline-navigator__bucket--has-error",
    );
    const scrubber = screen.getByLabelText("Timeline position");
    expect(scrubber.getAttribute("aria-valuetext")).toContain("Error 1");
    moveTimelineTo(3);
    expect(scrubber.getAttribute("aria-valuetext")).toContain("Error 12");
    expect(
      screen.getByTestId("timeline-error-presence-rail").querySelectorAll("i"),
    ).toHaveLength(2);
  });

  it("loads bounded session metrics and shares their committed cursor with log seeking", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(sessionMetrics)] },
    });

    const panel = await screen.findByTestId("timeline-session-metrics");
    expect(panel.textContent).toContain("session only · not persisted");
    expect(screen.getAllByRole("slider")).toHaveLength(4);
    expect(
      screen.getByTestId("operational-metric-track-cpu-percent"),
    ).toBeTruthy();
    const trackSize = screen.getByRole("combobox", {
      name: "Metric track size",
    }) as HTMLSelectElement;
    expect(trackSize.value).toBe("compact");
    expect(
      panel
        .querySelector(".operational-metric-tracks")
        ?.getAttribute("data-density"),
    ).toBe("compact");
    fireEvent.change(trackSize, { target: { value: "detailed" } });
    expect(trackSize.value).toBe("detailed");
    expect(
      panel
        .querySelector(".operational-metric-tracks")
        ?.getAttribute("data-density"),
    ).toBe("detailed");

    const cpu = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    Object.defineProperty(cpu, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.pointerDown(cpu, { clientX: 75, pointerId: 1 });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    fireEvent.pointerUp(cpu, { clientX: 75, pointerId: 1 });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          timeFrom: 1_700_000_030,
          timeTo: 1_700_000_040,
          limit: 1,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide tracks" }));
    expect(screen.queryByTestId("timeline-session-metrics")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show tracks" }));
    expect(screen.getByTestId("timeline-session-metrics")).toBeTruthy();
  });

  it("shares log-histogram hover with every metric readout without seeking", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(sessionMetrics)] },
    });
    await screen.findByTestId("timeline-session-metrics");

    const chart = screen.getByTestId("timeline-navigator-bars");
    Object.defineProperty(chart, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    act(() => {
      fireEvent.pointerMove(chart, { clientX: 90, pointerId: 1 });
    });

    expect(
      screen
        .getByTestId("timeline-navigator-bars")
        .querySelector<HTMLElement>(".timeline-navigator__preview-marker")
        ?.style.getPropertyValue("left"),
    ).toBe("90%");
    expect(
      screen.getByTestId("operational-metric-reading-cpu-percent").textContent,
    ).toContain("95 %");
    expect(
      screen.getByTestId("operational-metric-reading-heap-bytes").textContent,
    ).toContain("800M bytes");
    expect(
      screen.getByTestId("operational-metric-reading-clients").textContent,
    ).toContain("120 clients");
    expect(screen.getByTestId("timeline-bucket-detail").textContent).toContain(
      "12 events",
    );
    for (const id of ["cpu-percent", "heap-bytes", "clients"]) {
      expect(
        screen.getByTestId(`operational-metric-hover-reading-${id}`),
      ).toBeTruthy();
      expect(
        screen
          .getByTestId(`operational-metric-track-${id}`)
          .querySelector<HTMLElement>(".operational-metric-track__plot")
          ?.style.getPropertyValue("--metric-cursor-position"),
      ).toBe("90%");
    }
    expect(
      screen.getByTestId("timeline-bucket-detail").getAttribute("role"),
    ).toBe("note");
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerLeave(chart);
    });
    expect(screen.queryByTestId("timeline-bucket-detail")).toBeNull();
    expect(
      screen.queryAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(0);

    const cpuPlot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    Object.defineProperty(cpuPlot, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.pointerEnter(cpuPlot);
    fireEvent.pointerMove(cpuPlot, { clientX: 10, pointerId: 2 });
    expect(screen.getByTestId("timeline-bucket-detail").textContent).toContain(
      "30 events",
    );
    expect(
      screen.getAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(3);
    fireEvent.pointerLeave(cpuPlot);
    expect(screen.queryByTestId("timeline-bucket-detail")).toBeNull();
  });

  it("keeps detailed metric tracks inside a bounded scrollable timeline pane", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(sessionMetrics)] },
    });
    await screen.findByTestId("timeline-session-metrics");
    fireEvent.change(
      screen.getByRole("combobox", { name: "Metric track size" }),
      { target: { value: "detailed" } },
    );

    const body = document.getElementById("log-explorer-timeline-navigator");
    expect(body).toBeTruthy();
    const style = getComputedStyle(body!);
    expect(style.overflowY).toBe("auto");
    expect((body as HTMLElement).style.maxHeight).toBe("min(44vh, 30rem)");
    expect(body?.getAttribute("aria-label")).toBe(
      "Timeline and aligned metric tracks",
    );
    expect(body?.getAttribute("tabindex")).toBe("0");
    expect(
      screen
        .getByTestId("timeline-session-metrics")
        .querySelector(".operational-metric-tracks")
        ?.getAttribute("data-density"),
    ).toBe("detailed");
  });

  it("zooms a brushed metric range and restores the full shared timeline", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(sessionMetrics)] },
    });

    const cpu = await screen.findByRole("slider", {
      name: "CPU shared time cursor",
    });
    Object.defineProperty(cpu, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(cpu, { clientX: 25.5, pointerId: 1 });
    fireEvent.pointerMove(cpu, { clientX: 74.5, pointerId: 1 });
    fireEvent.pointerUp(cpu, { clientX: 74.5, pointerId: 1 });
    const histogramSelection = screen.getByTestId(
      "timeline-selection-range",
    ) as HTMLElement;
    expect(Number.parseFloat(histogramSelection.style.left)).toBeCloseTo(25.5);
    expect(Number.parseFloat(histogramSelection.style.width)).toBeCloseTo(49);
    const zoom = screen.getByRole("button", { name: "Zoom to selection" });
    expect(zoom.hasAttribute("disabled")).toBe(false);
    fireEvent.click(zoom);

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          levels: ["error"],
          timeFrom: 1_700_000_010,
          timeTo: 1_700_000_030,
        }),
        [],
        96,
      ),
    );
    const zoomedCpu = await screen.findByRole("slider", {
      name: "CPU shared time cursor",
    });
    expect(zoomedCpu.getAttribute("aria-valuemin")).toBe("1700000010.2");
    expect(zoomedCpu.getAttribute("aria-valuemax")).toBe("1700000029.8");
    expect(screen.getByText(/zoomed/)).toBeTruthy();
    expect(screen.queryByTestId("timeline-selection-range")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Zoom to selection" }),
    ).toBeNull();

    const reset = screen.getByRole("button", { name: "Reset full range" });
    expect(
      screen.getAllByRole("button", { name: "Reset full range" }),
    ).toHaveLength(1);
    fireEvent.click(reset);
    await waitFor(() => {
      const calls = vi.mocked(host.hostLogSharedTimelineSummary).mock.calls;
      expect(calls[calls.length - 1]?.[1]).toEqual({ levels: ["error"] });
    });
    const restoredCpu = await screen.findByRole("slider", {
      name: "CPU shared time cursor",
    });
    expect(restoredCpu.getAttribute("aria-valuemin")).toBe("1700000000");
    expect(restoredCpu.getAttribute("aria-valuemax")).toBe("1700000040");
  });

  it("keeps partially overlapping metrics on the exact log timeline domain", async () => {
    const extended = structuredClone(sessionMetrics);
    for (const series of extended.series) {
      series.points = [
        { ...series.points[0]!, timestamp: 1_699_999_980 },
        { ...series.points[1]!, timestamp: 1_700_000_060 },
      ];
    }
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(extended)] },
    });

    const cpu = await screen.findByRole("slider", {
      name: "CPU shared time cursor",
    });
    expect(cpu.getAttribute("aria-valuemin")).toBe("1700000000");
    expect(cpu.getAttribute("aria-valuemax")).toBe("1700000040");
    expect(screen.getByText(/clipped to the shared log timeline/)).toBeTruthy();
  });

  it("fails closed when session metric time cannot align honestly", async () => {
    const invalid = structuredClone(sessionMetrics);
    invalid.series[1]!.timeQuality = "order_only";
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-navigator-track");
    fireEvent.change(screen.getByTestId("timeline-metric-input"), {
      target: { files: [metricFile(invalid, "ambiguous.json")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "requires explicit wall-clock timestamps",
    );
    expect(screen.queryByTestId("timeline-session-metrics")).toBeNull();
  });

  it("commits keyboard seeks only after a navigation key is released", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    fireEvent.change(scrubber, { target: { value: "3" } });
    fireEvent.keyDown(scrubber, { key: "End" });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    fireEvent.keyUp(scrubber, { key: "End" });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByTestId("timeline-committed-position"),
    ).toBeTruthy();
  });

  it("uses concise UTC labels while retaining exact bucket details", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    expect(scrubber.getAttribute("aria-valuetext")).toMatch(
      /^\d{2}:\d{2}:\d{2}Z · 30 events · Error 1, Info 29 · wall clock$/,
    );
    expect(scrubber.getAttribute("title")).toContain("2023-");
    expect(
      document.querySelectorAll(".timeline-navigator__axis span"),
    ).toHaveLength(2);
    expect(
      screen
        .getAllByTestId(/^timeline-bucket-/)
        .every((bucket) => bucket.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
    fireEvent.focus(scrubber);
    const focusedDetail = screen.getByTestId("timeline-bucket-detail");
    expect(focusedDetail.getAttribute("role")).toBe("note");
    expect(focusedDetail.textContent).toContain("30 events");
    expect(focusedDetail.textContent).toContain("Error 1");
    expect(focusedDetail.textContent).toContain("2023-");
    fireEvent.keyDown(scrubber, { key: "F10", shiftKey: true });
    expect(scrubber.getAttribute("aria-describedby")).toBe(
      "timeline-bucket-detail",
    );
    fireEvent.keyDown(scrubber, { key: "Escape" });
    expect(screen.queryByTestId("timeline-bucket-detail")).toBeNull();
    fireEvent.blur(scrubber);
    expect(screen.queryByTestId("timeline-bucket-detail")).toBeNull();
    expect(
      screen
        .getByTestId("timeline-navigator-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("labels order-only summaries as order rather than calendar time", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      timeQuality: "order_only",
      spanFrom: 1,
      spanTo: 41,
      buckets: [
        { index: 0, start: 1, end: 11 },
        { index: 1, start: 11, end: 21 },
        { index: 2, start: 21, end: 31 },
        { index: 3, start: 31, end: 41 },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    expect(scrubber.getAttribute("title")).toBe("order 1–10");
    expect(scrubber.getAttribute("aria-valuetext")).toContain(
      "order only (not calendar time)",
    );
  });

  it("shows bounded per-lane coverage without upgrading an order-only lane", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      lanes: [
        {
          laneIndex: 0,
          sourceCount: 1,
          timeQuality: "wall",
          totalMatched: 30,
          counts: [30, 0, 0, 0],
        },
        {
          laneIndex: 1,
          sourceCount: 1,
          timeQuality: "order_only",
          totalMatched: 12,
          counts: [0, 0, 0, 12],
        },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        lanes={[
          { id: "lane-0", label: "API", sources: ["api.log"] },
          { id: "lane-1", label: "Worker", sources: ["worker.log"] },
        ]}
        onSeekSeq={vi.fn()}
      />,
    );
    const coverage = await screen.findByTestId("timeline-lane-coverage");
    expect(within(coverage).getByText("API")).toBeTruthy();
    expect(within(coverage).getByText("Worker")).toBeTruthy();
    expect(within(coverage).getByText("wall clock")).toBeTruthy();
    expect(
      within(coverage).getByText("order only (not calendar time)"),
    ).toBeTruthy();
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(1);
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
      "c1",
      { levels: ["error"] },
      [{ sources: ["api.log"] }, { sources: ["worker.log"] }],
      96,
    );
    expect(coverage.querySelectorAll("i")).toHaveLength(8);
    const scrubber = moveTimelineTo(3);
    fireEvent.focus(scrubber);
    fireEvent.keyDown(scrubber, { key: "F10", shiftKey: true });
    const detail = screen.getByTestId("timeline-bucket-detail");
    const breakdown = within(detail).getByRole("list", {
      name: "Bucket lane breakdown",
    });
    expect(within(breakdown).getByText("API")).toBeTruthy();
    expect(within(breakdown).getByText("Worker")).toBeTruthy();
    expect(within(breakdown).getByText("12")).toBeTruthy();
  });

  it("ignores a stale summary after filters change", async () => {
    const old = deferred<host.SharedTimelineSummaryDto>();
    vi.mocked(host.hostLogSharedTimelineSummary)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ ...summary, totalMatched: 7 });
    const { rerender } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["info"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    rerender(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/7 matching events summarized/),
    ).toBeTruthy();
    old.resolve({ ...summary, totalMatched: 999 });
    await Promise.resolve();
    expect(screen.queryByText(/999 matching events/)).toBeNull();
  });

  it("ignores a stale seek and reports an empty sparse bucket honestly", async () => {
    const old = deferred<host.EventPageDto>();
    const newerTarget = { ...target, seq: 88, ts: 1_700_000_031 };
    vi.mocked(host.hostLogQueryEvents)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({
        events: [newerTarget],
        nextCursor: null,
        totalMatched: 1,
        timeQuality: "wall",
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: null,
        totalMatched: 0,
        timeQuality: "wall",
      });
    const onSeekSeq = vi.fn(async () => {});
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={onSeekSeq}
      />,
    );
    await screen.findByTestId("timeline-bucket-0");
    moveTimelineTo(0, true);
    moveTimelineTo(3, true);
    await waitFor(() =>
      expect(onSeekSeq).toHaveBeenCalledWith(88, newerTarget),
    );
    old.resolve({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
    await Promise.resolve();
    expect(onSeekSeq).not.toHaveBeenCalledWith(77, target);

    moveTimelineTo(2, true);
    expect(await screen.findByText(/No event in/)).toBeTruthy();
  });

  it("shows summary and seek failures as visible errors", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockRejectedValueOnce(
      new Error("summary unavailable"),
    );
    const { unmount } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "summary unavailable",
    );
    unmount();

    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue(summary);
    vi.mocked(host.hostLogQueryEvents).mockRejectedValueOnce(
      new Error("seek unavailable"),
    );
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    await screen.findByTestId("timeline-bucket-0");
    moveTimelineTo(0, true);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "seek unavailable",
    );
  });
});
