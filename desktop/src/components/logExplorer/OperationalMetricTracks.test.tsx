import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  validateOperationalMetricsDocument,
  type OperationalMetricsDocumentV1,
} from "../../lib/logExplorer/operationalMetrics";
import { OperationalMetricTracks } from "./OperationalMetricTracks";

function checkedInFixtureJson(name: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      `../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/metrics/${name}`,
    ),
    "utf8",
  );
}

function checkedFixture(raw: string): OperationalMetricsDocumentV1 {
  const result = validateOperationalMetricsDocument(JSON.parse(raw));
  if (!result.ok) {
    throw new Error(
      `invalid checked-in fixture: ${result.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join(", ")}`,
    );
  }
  return result.data;
}

const coherentFixture = checkedFixture(
  checkedInFixtureJson("operational-metrics.v1.json"),
);
const patternFixture = checkedFixture(
  checkedInFixtureJson("operational-metrics-patterns.v1.json"),
);

function setPlotBounds(element: HTMLElement) {
  Object.defineProperty(element, "getBoundingClientRect", {
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
}

describe("OperationalMetricTracks", () => {
  it("keeps unlike units in separate stacked tracks with their own scales", () => {
    render(<OperationalMetricTracks document={coherentFixture} />);

    expect(
      screen
        .getByTestId("operational-metric-track-cpu-percent")
        .textContent?.includes("Scale 22 %–96 %"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("operational-metric-track-heap-used-bytes")
        .textContent?.includes("Scale 410M bytes–824M bytes"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("operational-metric-track-concurrent-clients")
        .textContent?.includes("Scale 10 clients–120 clients"),
    ).toBe(true);
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });

  it("shows compact axes and synchronized non-sticky cursor readings", () => {
    render(
      <OperationalMetricTracks document={coherentFixture} density="compact" />,
    );
    const track = screen.getByTestId("operational-metric-track-cpu-percent");
    const plot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    setPlotBounds(plot);

    expect(
      Array.from(
        track.querySelectorAll(".operational-metric-track__scale-label"),
      ).map((label) => label.textContent),
    ).toEqual(["Max 96 %", "Min 22 %"]);
    expect(
      screen.queryByTestId("operational-metric-hover-reading-cpu-percent"),
    ).toBeNull();

    fireEvent.pointerEnter(plot);
    fireEvent.pointerMove(plot, { clientX: 75, pointerId: 1 });
    for (const id of ["cpu-percent", "heap-used-bytes", "concurrent-clients"]) {
      expect(
        screen.getByTestId(`operational-metric-hover-reading-${id}`)
          .textContent,
      ).toMatch(/at .*UTC/);
    }
    expect(plot.style.getPropertyValue("--metric-reading-position")).toMatch(
      /%$/,
    );
    fireEvent.pointerLeave(plot);
    for (const id of ["cpu-percent", "heap-used-bytes", "concurrent-clients"]) {
      expect(
        screen.queryByTestId(`operational-metric-hover-reading-${id}`),
      ).toBeNull();
    }

    fireEvent.focus(plot);
    expect(
      screen.getAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(3);
    fireEvent.pointerEnter(plot);
    fireEvent.pointerLeave(plot);
    expect(
      screen.getAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(3);
    fireEvent.blur(plot);
    expect(
      screen.queryAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(0);

    fireEvent.pointerEnter(plot);
    fireEvent.pointerDown(plot, { clientX: 50, pointerId: 2 });
    fireEvent.pointerLeave(plot);
    expect(
      screen.getAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(3);
    fireEvent.pointerUp(plot, { clientX: 50, pointerId: 2 });
    expect(
      screen.queryAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(0);
  });

  it("keeps shared readings visible while any other track remains active", () => {
    render(<OperationalMetricTracks document={coherentFixture} />);
    const cpuPlot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    const heapPlot = screen.getByRole("slider", {
      name: "Heap used shared time cursor",
    });
    setPlotBounds(cpuPlot);
    setPlotBounds(heapPlot);

    fireEvent.focus(cpuPlot);
    fireEvent.pointerEnter(heapPlot);
    fireEvent.pointerMove(heapPlot, { clientX: 40, pointerId: 4 });
    fireEvent.pointerLeave(heapPlot);

    expect(
      screen.getAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(3);
    fireEvent.blur(cpuPlot);
    expect(
      screen.queryAllByTestId(/operational-metric-hover-reading-/),
    ).toHaveLength(0);
  });

  it("uses one shared renderer and interaction model in compact side presentation", () => {
    const { container } = render(
      <OperationalMetricTracks
        document={coherentFixture}
        presentation="compact-side"
      />,
    );

    const root = container.querySelector(".operational-metric-tracks");
    expect(root?.getAttribute("data-presentation")).toBe("compact-side");
    expect(
      root?.classList.contains("operational-metric-tracks--compact-side"),
    ).toBe(true);
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });

  it.each(["compact", "standard", "detailed"] as const)(
    "exposes the %s density as a stable class and data attribute",
    (density) => {
      const { container } = render(
        <OperationalMetricTracks
          document={coherentFixture}
          density={density}
        />,
      );

      const root = container.querySelector(".operational-metric-tracks");
      expect(root?.getAttribute("data-density")).toBe(density);
      expect(
        root?.classList.contains(
          `operational-metric-tracks--density-${density}`,
        ),
      ).toBe(true);
      expect(root?.getAttribute("data-shared-plot-alignment")).toBe(
        density === "compact" ? "outer-content" : "inset",
      );
      expect(
        screen
          .getByRole("slider", {
            name: "CPU shared time cursor",
          })
          .hasAttribute("aria-valuetext"),
      ).toBe(true);
    },
  );

  it("previews one shared pointer crosshair across every track", () => {
    const onCursorChange = vi.fn();
    render(
      <OperationalMetricTracks
        document={coherentFixture}
        onCursorChange={onCursorChange}
      />,
    );
    const cpuPlot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    setPlotBounds(cpuPlot);

    fireEvent.pointerMove(cpuPlot, { clientX: 50, pointerId: 1 });

    expect(onCursorChange).toHaveBeenCalledTimes(1);
    for (const series of coherentFixture.series) {
      expect(
        screen
          .getByTestId(`operational-metric-crosshair-${series.id}`)
          .getAttribute("x1"),
      ).toBe("50");
    }
  });

  it("emits one bounded nearby-log seek only when pointer interaction ends", () => {
    const onSeekTimestamp = vi.fn();
    const onRangeSelect = vi.fn();
    render(
      <OperationalMetricTracks
        document={coherentFixture}
        onSeekTimestamp={onSeekTimestamp}
        onRangeSelect={onRangeSelect}
      />,
    );
    const cpuPlot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    setPlotBounds(cpuPlot);

    fireEvent.pointerUp(cpuPlot, { clientX: 90, pointerId: 1 });
    expect(onSeekTimestamp).not.toHaveBeenCalled();

    expect(fireEvent.pointerDown(cpuPlot, { clientX: 20, pointerId: 1 })).toBe(
      false,
    );
    fireEvent.pointerMove(cpuPlot, {
      buttons: 1,
      clientX: 70,
      pointerId: 1,
    });
    expect(onSeekTimestamp).not.toHaveBeenCalled();
    fireEvent.pointerUp(cpuPlot, { clientX: 120, pointerId: 1 });

    expect(onSeekTimestamp).toHaveBeenCalledTimes(1);
    expect(onSeekTimestamp).toHaveBeenCalledWith(1736100000);
    const finalRange = onRangeSelect.mock.calls.at(-1)?.[0];
    expect(finalRange.from).toBeGreaterThanOrEqual(1736078400);
    expect(finalRange.to).toBeLessThanOrEqual(1736100000);
    const selections = screen.getAllByTestId(/operational-metric-selection-/);
    expect(selections).toHaveLength(3);
    expect(
      new Set(
        selections.map(
          (selection) =>
            `${selection.getAttribute("x")}:${selection.getAttribute("width")}`,
        ),
      ).size,
    ).toBe(1);
  });

  it("cancels a captured drag without retaining a phantom range anchor", () => {
    const onRangeSelect = vi.fn();
    const onSeekTimestamp = vi.fn();
    render(
      <OperationalMetricTracks
        document={coherentFixture}
        onRangeSelect={onRangeSelect}
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const plot = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    setPlotBounds(plot);

    fireEvent.pointerDown(plot, { clientX: 20, pointerId: 8 });
    fireEvent.pointerMove(plot, {
      buttons: 1,
      clientX: 70,
      pointerId: 8,
    });
    expect(onRangeSelect.mock.calls.at(-1)?.[0]).not.toBeNull();

    fireEvent.pointerCancel(plot, { pointerId: 8 });
    expect(onRangeSelect).toHaveBeenLastCalledWith(null);
    fireEvent.pointerUp(plot, { clientX: 90, pointerId: 8 });

    expect(onSeekTimestamp).not.toHaveBeenCalled();
    expect(
      screen.queryAllByTestId(/operational-metric-selection-/),
    ).toHaveLength(0);
  });

  it("commits the one shared keyboard cursor with Enter or Space", () => {
    const onSeekTimestamp = vi.fn();
    render(
      <OperationalMetricTracks
        document={coherentFixture}
        onSeekTimestamp={onSeekTimestamp}
      />,
    );
    const heapPlot = screen.getByRole("slider", {
      name: "Heap used shared time cursor",
    });

    fireEvent.keyDown(heapPlot, { key: "ArrowRight" });
    fireEvent.keyDown(heapPlot, { key: "Enter" });
    expect(onSeekTimestamp).toHaveBeenLastCalledWith(1736078616);

    const clientsPlot = screen.getByRole("slider", {
      name: "Concurrent clients shared time cursor",
    });
    fireEvent.keyDown(clientsPlot, { key: " " });
    expect(onSeekTimestamp).toHaveBeenLastCalledWith(1736078616);
    expect(onSeekTimestamp).toHaveBeenCalledTimes(2);
  });

  it("moves the shared cursor by keyboard and extends a bounded range with Shift", () => {
    const onCursorChange = vi.fn();
    const onRangeSelect = vi.fn();
    render(
      <OperationalMetricTracks
        document={coherentFixture}
        onCursorChange={onCursorChange}
        onRangeSelect={onRangeSelect}
      />,
    );
    const heapPlot = screen.getByRole("slider", {
      name: "Heap used shared time cursor",
    });
    heapPlot.focus();

    fireEvent.keyDown(heapPlot, { key: "ArrowRight" });
    fireEvent.keyDown(heapPlot, { key: "ArrowRight", shiftKey: true });

    expect(onCursorChange).toHaveBeenCalledTimes(2);
    expect(onRangeSelect).toHaveBeenLastCalledWith({
      from: 1736078616,
      to: 1736078832,
    });
    expect(screen.getAllByTestId(/operational-metric-selection-/)).toHaveLength(
      3,
    );
  });

  it("renders explicit gaps as broken lines with compact expandable detail", () => {
    render(<OperationalMetricTracks document={patternFixture} />);

    expect(screen.getAllByTestId(/operational-metric-gap-/)).toHaveLength(3);
    const summaries = screen.getAllByText("1 data gap");
    expect(summaries).toHaveLength(3);
    expect(
      summaries.every(
        (summary) => summary.closest("details")?.hasAttribute("open") === false,
      ),
    ).toBe(true);
    fireEvent.click(summaries[0]!);
    expect(screen.getByText("synthetic CPU collector outage")).toBeTruthy();
    expect(
      screen.getAllByText(
        "The line stays broken; missing samples are not interpolated.",
      ),
    ).toHaveLength(3);
    expect(
      screen.getAllByTestId(/operational-metric-segment-/).length,
    ).toBeGreaterThan(patternFixture.series.length);
  });

  it("does not bridge a declared gap with no sample timestamp inside it", () => {
    const betweenSamples = structuredClone(patternFixture);
    betweenSamples.series = [
      {
        ...betweenSamples.series[0],
        points: [
          { timestamp: 1736164800, value: 20 },
          { timestamp: 1736168400, value: 80 },
        ],
        gaps: [
          {
            from: 1736166000,
            to: 1736167200,
            reason: "missing samples between endpoints",
          },
        ],
      },
    ];

    render(<OperationalMetricTracks document={betweenSamples} />);

    const segments = screen.getAllByTestId(
      "operational-metric-segment-cpu-percent",
    );
    expect(segments).toHaveLength(2);
    expect(segments.map((path) => path.getAttribute("d"))).toEqual([
      "M 0.000 100.000",
      "M 100.000 0.000",
    ]);
  });

  it("plots irregularly timed samples without inventing a data gap", () => {
    const irregular = structuredClone(patternFixture);
    irregular.series = [
      {
        ...irregular.series[0],
        gaps: undefined,
        points: [
          { timestamp: 1736164800, value: 20 },
          { timestamp: 1736164867, value: 24 },
          { timestamp: 1736168400, value: 80 },
          { timestamp: 1736179200, value: 30 },
        ],
      },
    ];

    render(<OperationalMetricTracks document={irregular} />);

    expect(screen.queryByText(/data gap/)).toBeNull();
    expect(screen.queryByTestId(/operational-metric-gap-/)).toBeNull();
    expect(
      screen
        .getByTestId("operational-metric-segment-cpu-percent")
        .getAttribute("d")
        ?.match(/[ML]/g),
    ).toHaveLength(irregular.series[0].points.length);
  });

  it("uses shared time bounds while preserving actual irregular sample positions", () => {
    const irregular = structuredClone(patternFixture);
    irregular.series = [
      {
        ...irregular.series[0],
        gaps: undefined,
        points: [
          { timestamp: 100, value: 20 },
          { timestamp: 110, value: 24 },
          { timestamp: 190, value: 80 },
          { timestamp: 200, value: 30 },
        ],
      },
    ];

    render(
      <OperationalMetricTracks
        document={irregular}
        sharedTimeBounds={{ from: 0, to: 400 }}
      />,
    );

    expect(
      screen
        .getByTestId("operational-metric-segment-cpu-percent")
        .getAttribute("d"),
    ).toBe("M 25.000 100.000 L 27.500 93.333 L 47.500 0.000 L 50.000 83.333");
    expect(
      screen
        .getByRole("slider", {
          name: "CPU shared time cursor",
        })
        .getAttribute("aria-valuemax"),
    ).toBe("400");
    expect(screen.queryByText(/data gap/)).toBeNull();
  });

  it("normalizes too-narrow reversed shared bounds without dropping samples", () => {
    const irregular = structuredClone(patternFixture);
    irregular.series = [
      {
        ...irregular.series[0],
        gaps: undefined,
        points: [
          { timestamp: 100, value: 20 },
          { timestamp: 110, value: 24 },
          { timestamp: 190, value: 80 },
          { timestamp: 200, value: 30 },
        ],
      },
    ];

    render(
      <OperationalMetricTracks
        document={irregular}
        sharedTimeBounds={{ from: 190, to: 110 }}
      />,
    );

    const path = screen.getByTestId("operational-metric-segment-cpu-percent");
    expect(path.getAttribute("d")?.match(/[ML]/g)).toHaveLength(4);
    expect(path.getAttribute("d")).toMatch(/^M 0\.000 /);
    expect(path.getAttribute("d")).toContain("L 100.000 ");
    const slider = screen.getByRole("slider", {
      name: "CPU shared time cursor",
    });
    expect(slider.getAttribute("aria-valuemin")).toBe("100");
    expect(slider.getAttribute("aria-valuemax")).toBe("200");
  });

  it("keeps SVG work bounded for dense inputs", () => {
    const dense = structuredClone(coherentFixture);
    dense.series[0].points = Array.from({ length: 2_000 }, (_, index) => ({
      timestamp: 1736078400 + index,
      value: index === 1001 ? 99 : index % 20,
    }));

    render(
      <OperationalMetricTracks
        document={dense}
        maxRenderedPointsPerTrack={40}
      />,
    );
    const paths = screen.getAllByTestId(
      "operational-metric-segment-cpu-percent",
    );
    const renderedCommands = paths.reduce(
      (count, path) =>
        count + ((path.getAttribute("d") ?? "").match(/[ML]/g)?.length ?? 0),
      0,
    );
    expect(renderedCommands).toBeLessThanOrEqual(40);
  });
});
