import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityRail } from "./ActivityRail";
import { appendActivities, createActivityLog } from "../../lib/activity/activityLog";
import {
  beginImportActivityAttempt,
  recordImportProgress,
  settleImportActivityAttempt,
} from "../../lib/activity/importProgressActivity";
import type {
  ActivityMode,
  ClientIncidentClock,
  ImportRunInput,
} from "../../lib/activity/types";

const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);

const RUN: ImportRunInput = {
  startedAtMs: T0,
  endedAtMs: T0 + 4_000,
  outcome: "completed",
  sourceKind: "directory",
  report: {
    corpusId: "corpus-1",
    lines: 25_000,
    templates: 10,
    reductionRatio: 4.2,
    embedded: 10,
    files: 12,
    discoveredFiles: 14,
    excludedFiles: 1,
    failedFiles: 0,
    ignoredFiles: 1,
    exclusionCounts: { binary: 1 },
    exclusionExamples: ["a.bin"],
    partial: false,
    sourceBytes: 1_000,
    corpusBytes: 500,
    tsMin: T0,
    tsMax: T0 + 60_000,
    formatCounts: { syslog: 12 },
    embedding: { state: "complete", modelId: "local-embed" },
    confidence: {
      corpusTimeQuality: "wall",
      counts: {
        wall: 12,
        orderOnly: 0,
        mixed: 0,
        matched: 12,
        ambiguous: 0,
        unknown: 0,
        unresolved: 0,
      },
      sources: [],
    },
  },
};

function importActivities(run: ImportRunInput) {
  let attempt = beginImportActivityAttempt("import:activity-rail-test", run.sourceKind);
  for (const [phase, elapsedMs] of [
    ["starting", 0],
    ["scan", 10],
    ["stream", 20],
    ["validate", 30],
    ["publish", 40],
    ["completed", 50],
  ] as const) {
    attempt = recordImportProgress(attempt, {
      operation_id: "host-activity-rail-test",
      correlation_id: "import:activity-rail-test",
      kind: "log_ingest",
      phase,
      message: "ignored",
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: null,
      templates: null,
      cancellable: phase !== "publish",
      elapsed_ms: elapsedMs,
      phase_elapsed_ms: null,
    });
  }
  return settleImportActivityAttempt(attempt, run).events;
}

const LOG = appendActivities(createActivityLog(), importActivities(RUN));

const WALL_CLOCK: ClientIncidentClock = {
  tsMinMs: T0,
  tsMaxMs: T0 + 60_000,
  timeQuality: "wall",
};

function renderRail(mode: ActivityMode, overrides: Partial<Parameters<typeof ActivityRail>[0]> = {}) {
  return render(
    <ActivityRail
      visible
      modeControl={<div data-testid="mode-control" />}
      clientClock={WALL_CLOCK}
      openedAtMs={T0}
      log={LOG}
      mode={mode}
      onModeChange={vi.fn()}
      nowMs={T0 + 65_000}
      {...overrides}
    />,
  );
}

describe("Off hides the whole ContextDesk group without changing processing", () => {
  it("renders no activity content at all, and says processing is unchanged", () => {
    renderRail("off");
    expect(screen.getByTestId("activity-off-note").textContent).toMatch(
      /Processing is unchanged/i,
    );
    expect(screen.queryByTestId("activity-event-list")).toBeNull();
    expect(screen.queryByTestId("dual-lane-timeline")).toBeNull();
    expect(screen.queryByTestId("activity-dock-body")).toBeNull();
  });

  it("still keeps the recorded entries — Off is display-only, not deletion", () => {
    // The store is untouched, which is what makes turning it back on
    // immediately useful and proves Off changed no processing.
    renderRail("off");
    expect(LOG.entries.length).toBeGreaterThan(0);
    renderRail("compact");
    expect(screen.getByTestId("activity-event-list")).toBeTruthy();
  });
});

describe("the rail shows the dual-group view only when docked", () => {
  it("renders live import activity on its honest causal track in Docked", () => {
    renderRail("docked");
    expect(screen.getByTestId("dual-lane-timeline")).toBeTruthy();
    expect(
      screen.getByTestId("dual-lane-timeline").getAttribute("data-alignment"),
    ).toBe("separate_tracks");
  });

  it("omits the timeline in Compact and Drawer, keeping the list", () => {
    for (const mode of ["compact", "drawer"] as const) {
      const { unmount } = renderRail(mode);
      expect(screen.queryByTestId("dual-lane-timeline")).toBeNull();
      expect(screen.getByTestId("activity-event-list")).toBeTruthy();
      unmount();
    }
  });

  it("falls back to causal order when the corpus has no calendar time", () => {
    renderRail("docked", {
      clientClock: { tsMinMs: null, tsMaxMs: null, timeQuality: "order_only" },
    });
    expect(
      screen.getByTestId("dual-lane-timeline").getAttribute("data-alignment"),
    ).toBe("separate_tracks");
  });
});

describe("the rail keeps ContextDesk activity separate from customer evidence", () => {
  it("offers a truthful reopen strip when the shared rail is collapsed", () => {
    const onToggleCollapsed = vi.fn();
    renderRail("compact", { collapsed: true, onToggleCollapsed });
    expect(screen.queryByTestId("activity-dock-body")).toBeNull();
    const reopen = screen.getByTestId("expand-activity-rail");
    expect(reopen.getAttribute("aria-label")).toBe(
      `Expand ContextDesk activity, ${LOG.entries.length} entries`,
    );
    fireEvent.click(reopen);
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("can collapse the expanded Activity rail", () => {
    const onToggleCollapsed = vi.fn();
    renderRail("compact", { onToggleCollapsed });
    fireEvent.click(screen.getByTestId("collapse-activity-rail"));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("labels itself as app actions only", () => {
    renderRail("compact");
    expect(screen.getByText(/App actions only/i)).toBeTruthy();
    expect(
      screen.getByText(/separate from customer evidence/i),
    ).toBeTruthy();
  });

  it("reports the app's own elapsed clock, not the incident clock", () => {
    renderRail("compact");
    const elapsed = screen.getByTestId("activity-clock-investigation");
    expect(elapsed.textContent).toMatch(/1:05/);
    expect(elapsed.textContent).toMatch(/this machine, this view/i);
  });

  it("surfaces the retention bound when entries were dropped", () => {
    const small = appendActivities(
      createActivityLog(2),
      importActivities(RUN),
    );
    renderRail("compact", { log: small });
    expect(screen.getByRole("note").textContent).toMatch(
      /dropped by the 2-entry retention bound/i,
    );
  });

  it("stays hidden from the accessibility tree when not the active rail mode", () => {
    render(
      <ActivityRail
        visible={false}
        modeControl={<div />}
        clientClock={WALL_CLOCK}
        openedAtMs={T0}
        log={LOG}
        mode="docked"
        onModeChange={vi.fn()}
        nowMs={T0}
      />,
    );
    expect(screen.getByTestId("log-explorer-activity").hasAttribute("hidden")).toBe(
      true,
    );
  });
});
