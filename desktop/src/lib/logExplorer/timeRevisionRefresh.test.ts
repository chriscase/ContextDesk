import { describe, expect, it, vi } from "vitest";
import {
  refreshAfterTimeRevision,
  TIME_REVISION_REFRESH_ORDER,
  type TimeRevisionRefreshSteps,
} from "./timeRevisionRefresh";

function recordingSteps(): {
  steps: TimeRevisionRefreshSteps;
  calls: string[];
} {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  return {
    calls,
    steps: {
      invalidateInFlight: () => {
        calls.push("invalidateInFlight");
      },
      refreshSummary: record("refreshSummary"),
      refreshSuppressionPolicy: record("refreshSuppressionPolicy"),
      reloadActiveInvestigation: record("reloadActiveInvestigation"),
      loadFacets: record("loadFacets"),
      loadEvents: record("loadEvents"),
    },
  };
}

describe("refreshAfterTimeRevision (#819)", () => {
  it("runs the published refresh order exactly", async () => {
    const { steps, calls } = recordingSteps();
    await refreshAfterTimeRevision(steps);
    expect(calls).toEqual([...TIME_REVISION_REFRESH_ORDER]);
  });

  it("invalidates in-flight requests before any reload begins", async () => {
    const { steps, calls } = recordingSteps();
    await refreshAfterTimeRevision(steps);
    expect(calls[0]).toBe("invalidateInFlight");
  });

  it("never lets a query read exclusions before suppression is reloaded", async () => {
    const { steps, calls } = recordingSteps();
    await refreshAfterTimeRevision(steps);
    const suppression = calls.indexOf("refreshSuppressionPolicy");
    // Both exclusion-reading steps must come strictly after the reload.
    expect(calls.indexOf("loadFacets")).toBeGreaterThan(suppression);
    expect(calls.indexOf("loadEvents")).toBeGreaterThan(suppression);
    // The investigation lens comparison also precedes any repaint.
    const investigation = calls.indexOf("reloadActiveInvestigation");
    expect(investigation).toBeGreaterThan(suppression);
    expect(calls.indexOf("loadFacets")).toBeGreaterThan(investigation);
  });

  it("awaits each step, so a slow reload cannot be overtaken by a repaint", async () => {
    const calls: string[] = [];
    let releaseSuppression!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSuppression = resolve;
    });
    const steps: TimeRevisionRefreshSteps = {
      invalidateInFlight: () => calls.push("invalidateInFlight"),
      refreshSummary: async () => {
        calls.push("refreshSummary");
      },
      refreshSuppressionPolicy: async () => {
        calls.push("refreshSuppressionPolicy:start");
        await gate;
        calls.push("refreshSuppressionPolicy:end");
      },
      reloadActiveInvestigation: async () => {
        calls.push("reloadActiveInvestigation");
      },
      loadFacets: async () => {
        calls.push("loadFacets");
      },
      loadEvents: async () => {
        calls.push("loadEvents");
      },
    };

    const running = refreshAfterTimeRevision(steps);
    await Promise.resolve();
    await Promise.resolve();
    // While suppression is still in flight nothing downstream may have run.
    expect(calls).not.toContain("loadFacets");
    expect(calls).not.toContain("loadEvents");
    expect(calls).not.toContain("reloadActiveInvestigation");

    releaseSuppression();
    await running;
    expect(calls).toEqual([
      "invalidateInFlight",
      "refreshSummary",
      "refreshSuppressionPolicy:start",
      "refreshSuppressionPolicy:end",
      "reloadActiveInvestigation",
      "loadFacets",
      "loadEvents",
    ]);
  });

  it("propagates a failing reload instead of silently repainting stale rows", async () => {
    const calls: string[] = [];
    const steps: TimeRevisionRefreshSteps = {
      invalidateInFlight: () => calls.push("invalidateInFlight"),
      refreshSummary: vi.fn(async () => {
        calls.push("refreshSummary");
      }),
      refreshSuppressionPolicy: vi.fn(async () => {
        throw new Error("suppression reload failed");
      }),
      reloadActiveInvestigation: vi.fn(async () => {
        calls.push("reloadActiveInvestigation");
      }),
      loadFacets: vi.fn(async () => {
        calls.push("loadFacets");
      }),
      loadEvents: vi.fn(async () => {
        calls.push("loadEvents");
      }),
    };

    await expect(refreshAfterTimeRevision(steps)).rejects.toThrow(
      "suppression reload failed",
    );
    // Fail closed: no repaint may run on unresolved exclusions.
    expect(steps.loadFacets).not.toHaveBeenCalled();
    expect(steps.loadEvents).not.toHaveBeenCalled();
    expect(steps.reloadActiveInvestigation).not.toHaveBeenCalled();
  });
});
