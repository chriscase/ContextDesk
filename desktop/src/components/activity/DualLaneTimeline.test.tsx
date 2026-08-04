import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DualLaneTimeline } from "./DualLaneTimeline";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityClock,
  type ActivityEvent,
  type ClientIncidentClock,
} from "../../lib/activity/types";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);

function event(
  clock: ActivityClock,
  label = "Archive scanned",
  id = label,
  correlationId = "import-1",
): ActivityEvent {
  return {
    id,
    correlationId,
    operationId: `op-${id}`,
    origin: "deterministic_host",
    determinism: determinismForOrigin("deterministic_host"),
    phase: "completed",
    status: "ok",
    clock,
    label,
    scope: { kind: "log_corpus", id: "corpus-1", label: "Log corpus corpus-1" },
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
    corpusId: "corpus-1",
  };
}

const WALL_CORPUS: ClientIncidentClock = {
  tsMinMs: T0,
  tsMaxMs: T0 + 4 * HOUR,
  timeQuality: "wall",
};

const ORDER_ONLY_CORPUS: ClientIncidentClock = {
  tsMinMs: null,
  tsMaxMs: null,
  timeQuality: "order_only",
};

describe("the dual-group view shares an axis only when clock evidence permits", () => {
  it("draws BOTH groups on one wall-clock axis when both carry dates", () => {
    render(
      <DualLaneTimeline
        clientClock={{ ...WALL_CORPUS, selectedTsMs: T0 + 2 * HOUR }}
        activityEvents={[event({ kind: "wall", atMs: T0 + HOUR })]}
      />,
    );
    const root = screen.getByTestId("dual-lane-timeline");
    expect(root.getAttribute("data-alignment")).toBe("shared_wall_clock");
    expect(screen.getByTestId("dual-lane-axis-note").textContent).toMatch(
      /Shared wall clock/i,
    );
    expect(screen.getByTestId("dual-lane-shared-track")).toBeTruthy();
    // Both groups are present and distinct.
    expect(screen.getByTestId("dual-lane-customer")).toBeTruthy();
    expect(screen.getByTestId("dual-lane-contextdesk")).toBeTruthy();
  });

  it("positions a shared-axis marker at its true proportional offset", () => {
    // Activity at T0+1h within a 0..4h domain must sit at 25%, not somewhere
    // decorative — a shared axis that mispositions is worse than no axis.
    render(
      <DualLaneTimeline
        clientClock={WALL_CORPUS}
        activityEvents={[event({ kind: "wall", atMs: T0 + HOUR })]}
      />,
    );
    const marker = screen.getByTestId("dual-lane-activity-marker");
    expect(marker.getAttribute("style")).toContain("25%");
  });

  it("refuses a shared axis for an order-only corpus and says so on screen", () => {
    render(
      <DualLaneTimeline
        clientClock={ORDER_ONLY_CORPUS}
        activityEvents={[event({ kind: "wall", atMs: T0 })]}
      />,
    );
    const root = screen.getByTestId("dual-lane-timeline");
    expect(root.getAttribute("data-alignment")).toBe("separate_tracks");
    const note = screen.getByTestId("dual-lane-axis-note");
    expect(note.textContent).toMatch(/ordered by cause, not by clock/i);
    expect(note.textContent).toMatch(/carries no calendar time/i);
    // The honest fallback is a causal list, not a dated track.
    expect(screen.getByTestId("dual-lane-sequence")).toBeTruthy();
    expect(screen.queryByTestId("dual-lane-shared-track")).toBeNull();
  });

  it("never prints a calendar date for an order-only corpus", () => {
    render(
      <DualLaneTimeline
        clientClock={ORDER_ONLY_CORPUS}
        activityEvents={[event({ kind: "wall", atMs: T0 })]}
      />,
    );
    const customer = screen.getByTestId("dual-lane-customer");
    expect(customer.textContent).toMatch(/no calendar time/i);
    expect(customer.textContent).not.toMatch(/\b(19|20)\d{2}-\d{2}-\d{2}\b/);
  });

  it("falls back to causal order when ANY activity lacks calendar time", () => {
    render(
      <DualLaneTimeline
        clientClock={WALL_CORPUS}
        activityEvents={[
          event({ kind: "wall", atMs: T0 }, "Dated", "a"),
          event({ kind: "sequence", seq: 1 }, "Undated", "b"),
        ]}
      />,
    );
    expect(
      screen.getByTestId("dual-lane-timeline").getAttribute("data-alignment"),
    ).toBe("separate_tracks");
    expect(screen.getByTestId("dual-lane-axis-note").textContent).toMatch(
      /order or elapsed time only/i,
    );
    // Both events still appear — refusing an axis is not refusing to show.
    const seq = screen.getByTestId("dual-lane-sequence");
    expect(within(seq).getByText("Dated")).toBeTruthy();
    expect(within(seq).getByText("Undated")).toBeTruthy();
  });

  it("labels a mixed-quality corpus honestly rather than dating the remainder", () => {
    render(
      <DualLaneTimeline
        clientClock={{ ...WALL_CORPUS, timeQuality: "mixed" }}
        activityEvents={[event({ kind: "wall", atMs: T0 })]}
      />,
    );
    expect(screen.getByTestId("dual-lane-axis-note").textContent).toMatch(
      /invented dates/i,
    );
  });
});

describe("the two groups synchronize independently", () => {
  it("selects an activity correlation without touching customer state", () => {
    const onSelectCorrelation = vi.fn();
    render(
      <DualLaneTimeline
        clientClock={ORDER_ONLY_CORPUS}
        activityEvents={[
          event({ kind: "sequence", seq: 0 }, "Scan", "a", "import-1"),
          event({ kind: "sequence", seq: 1 }, "Publish", "b", "import-1"),
        ]}
        onSelectCorrelation={onSelectCorrelation}
      />,
    );
    fireEvent.click(screen.getAllByTestId("dual-lane-sequence-row")[0]!);
    // The callback carries a ContextDesk correlation id — never an event id,
    // source id, or corpus filter, which is what customer lanes are keyed by.
    expect(onSelectCorrelation).toHaveBeenCalledWith("import-1");
  });

  it("toggles a selected correlation back off", () => {
    const onSelectCorrelation = vi.fn();
    render(
      <DualLaneTimeline
        clientClock={ORDER_ONLY_CORPUS}
        activityEvents={[event({ kind: "sequence", seq: 0 }, "Scan", "a")]}
        selectedCorrelationId="import-1"
        onSelectCorrelation={onSelectCorrelation}
      />,
    );
    const row = screen.getByTestId("dual-lane-sequence-row");
    expect(row.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(row);
    expect(onSelectCorrelation).toHaveBeenCalledWith(null);
  });

  it("says plainly when there is no activity yet", () => {
    render(
      <DualLaneTimeline clientClock={WALL_CORPUS} activityEvents={[]} />,
    );
    expect(
      screen.getByTestId("dual-lane-contextdesk").textContent,
    ).toMatch(/No ContextDesk activity recorded/i);
  });
});
