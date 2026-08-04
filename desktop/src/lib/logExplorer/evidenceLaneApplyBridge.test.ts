/**
 * Cross-window Evidence · N placement: Tauri emit + subscribe + pure adopt.
 * Synthetic XYZ only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEvidenceLanesToExplorer,
  broadcastEvidenceLanesApply,
  evidencePlacementToExplorerState,
  EVIDENCE_LANE_APPLY_EVENT,
  loadEvidencePlacementFromStorage,
  subscribeEvidenceLanesApply,
} from "./evidenceLaneApplyBridge";
import {
  loadLanes,
  loadVisibleLaneCount,
  evidenceLayoutFingerprint,
  persistEvidenceLanesPlacement,
} from "./laneCompose";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

const xyzDetail = {
  corpusId: "corpus-xyz-demo",
  lanes: [
    { id: "lane-0", label: "xyz-api", sources: ["xyz/api.log"] },
    { id: "lane-1", label: "xyz-worker", sources: ["xyz/worker.log"] },
  ],
  visibleLaneCount: 2,
  linkMode: "align_time" as const,
  highlightSeqs: [101, 202],
  revision: 1,
};

describe("evidencePlacementToExplorerState (LogExplorer adopt pure path)", () => {
  it("maps apply detail into lanes + preferredLaneCount + highlights", () => {
    const state = evidencePlacementToExplorerState(xyzDetail);
    expect(state.preferredLaneCount).toBe(2);
    expect(state.laneCount).toBe(2);
    expect(state.lanes.map((l) => l.sources)).toEqual([
      ["xyz/api.log"],
      ["xyz/worker.log"],
    ]);
    expect(state.linkMode).toBe("align_time");
    expect(state.highlightSeqs).toEqual([101, 202]);
  });
});

describe("applyEvidenceLanesToExplorer cross-window", () => {
  it("persists and emits Tauri bus event (not CustomEvent-only)", async () => {
    const emit = vi.fn(async () => undefined);
    const applied = applyEvidenceLanesToExplorer(
      xyzDetail,
      evidenceLayoutFingerprint("corpus-xyz-demo"),
      emit,
    );
    expect(applied.visibleLaneCount).toBe(2);
    expect(loadVisibleLaneCount("corpus-xyz-demo")).toBe(2);
    expect(loadLanes("corpus-xyz-demo")?.length).toBe(2);

    // Allow voided broadcast to settle
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit).toHaveBeenCalledWith(
      EVIDENCE_LANE_APPLY_EVENT,
      expect.objectContaining({
        corpusId: "corpus-xyz-demo",
        visibleLaneCount: 2,
        highlightSeqs: [101, 202],
      }),
    );
  });

  it("subscribe receives CustomEvent and injected Tauri listen", async () => {
    const received: unknown[] = [];
    let tauriHandler:
      | ((event: { payload: typeof xyzDetail & { eventId?: string; visibleLaneCount?: number } }) => void)
      | null = null;
    const listen: import("./evidenceLaneApplyBridge").EvidenceLaneListen = async (
      _name,
      handler,
    ) => {
      tauriHandler = handler as typeof tauriHandler;
      return () => {
        tauriHandler = null;
      };
    };
    const stop = subscribeEvidenceLanesApply((d) => received.push(d), listen);
    await new Promise((r) => setTimeout(r, 0));

    // Same-window CustomEvent
    window.dispatchEvent(
      new CustomEvent(EVIDENCE_LANE_APPLY_EVENT, {
        detail: { ...xyzDetail, eventId: "e1", revision: 1 },
      }),
    );
    expect(received).toHaveLength(1);

    // Cross-window Tauri payload (different eventId)
    tauriHandler!({
      payload: { ...xyzDetail, eventId: "e2", visibleLaneCount: 3, revision: 2 },
    });
    expect(received).toHaveLength(2);
    expect((received[1] as { visibleLaneCount: number }).visibleLaneCount).toBe(
      3,
    );

    // Dedupe same eventId (CustomEvent then Tauri)
    window.dispatchEvent(
      new CustomEvent(EVIDENCE_LANE_APPLY_EVENT, {
        detail: { ...xyzDetail, eventId: "e3", revision: 3 },
      }),
    );
    tauriHandler!({
      payload: { ...xyzDetail, eventId: "e3", revision: 3 },
    });
    expect(received).toHaveLength(3);

    stop();
  });

  it("rejects a delayed older corpus revision and oversized inbound sources", async () => {
    const received: unknown[] = [];
    let tauriHandler:
      | ((event: { payload: typeof xyzDetail & { eventId?: string } }) => void)
      | null = null;
    const stop = subscribeEvidenceLanesApply(
      (detail) => received.push(detail),
      async (_name, handler) => {
        tauriHandler = handler as typeof tauriHandler;
        return () => {
          tauriHandler = null;
        };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    tauriHandler!({
      payload: { ...xyzDetail, revision: 9, eventId: "newer" },
    });
    tauriHandler!({
      payload: { ...xyzDetail, revision: 8, eventId: "delayed-older" },
    });
    expect(received).toHaveLength(1);

    tauriHandler!({
      payload: {
        ...xyzDetail,
        revision: 10,
        eventId: "oversized",
        lanes: [
          {
            id: "lane-0",
            label: "oversized",
            sources: ["x".repeat(1_025)],
          },
        ],
      },
    });
    expect(received).toHaveLength(1);
    stop();
  });

  it("rolls every preference back and reports a partial storage failure", () => {
    const prior = {
      lanes: JSON.stringify([
        { id: "lane-0", label: "Prior", sources: ["prior.log"] },
      ]),
      count: "1",
      mode: "independent",
    };
    store.set("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo", prior.lanes);
    store.set(
      "contextdesk.logExplorer.visibleLaneCount.v1:corpus-xyz-demo",
      prior.count,
    );
    store.set(
      "contextdesk.logExplorer.linkMode.v1:corpus-xyz-demo",
      prior.mode,
    );
    let failed = false;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (!failed && key.includes("evidenceHighlights")) {
          failed = true;
          throw new Error("quota");
        }
        store.set(key, value);
      },
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    const fingerprint = evidenceLayoutFingerprint("corpus-xyz-demo");
    expect(() =>
      applyEvidenceLanesToExplorer(xyzDetail, fingerprint),
    ).toThrow(/could not save/i);
    expect(store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo")).toBe(
      prior.lanes,
    );
    expect(
      store.get("contextdesk.logExplorer.visibleLaneCount.v1:corpus-xyz-demo"),
    ).toBe(prior.count);
    expect(
      store.get("contextdesk.logExplorer.linkMode.v1:corpus-xyz-demo"),
    ).toBe(prior.mode);
    expect(
      store.get("contextdesk.logExplorer.evidencePlacement.v2:corpus-xyz-demo"),
    ).toBeUndefined();
  });

  it("broadcastEvidenceLanesApply uses injected emit for multi-window", async () => {
    const emit = vi.fn(async () => undefined);
    await broadcastEvidenceLanesApply(xyzDetail, emit);
    expect(emit).toHaveBeenCalledWith(
      EVIDENCE_LANE_APPLY_EVENT,
      expect.objectContaining({ corpusId: "corpus-xyz-demo" }),
    );
  });
});

describe("focus / storage re-read path", () => {
  it("loadEvidencePlacementFromStorage rebuilds placement after main-window persist", () => {
    persistEvidenceLanesPlacement(
      xyzDetail,
      evidenceLayoutFingerprint("corpus-xyz-demo"),
    );
    const stored = loadEvidencePlacementFromStorage("corpus-xyz-demo");
    expect(stored).not.toBeNull();
    const state = evidencePlacementToExplorerState(stored!);
    expect(state.preferredLaneCount).toBe(2);
    expect(state.lanes[0]!.sources).toEqual(["xyz/api.log"]);
  });

  it("ignores other corpora (session isolation)", () => {
    persistEvidenceLanesPlacement(
      xyzDetail,
      evidenceLayoutFingerprint("corpus-xyz-demo"),
    );
    expect(loadEvidencePlacementFromStorage("other-corpus")).toBeNull();
  });
});
