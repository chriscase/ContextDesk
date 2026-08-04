import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  applyEvidenceLanesToExplorer,
  composeLaneSources,
  defaultLanes,
  EVIDENCE_LANE_APPLY_EVENT,
  loadEvidenceHighlights,
  loadLanes,
  loadVisibleLaneCount,
  restoreSpecificLaneSources,
  resizeLaneList,
  saveLanes,
  selectAllLaneSources,
  toggleLaneSource,
  type LaneConfig,
} from "./laneCompose";

const store = new Map<string, string>();

describe("laneCompose", () => {
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

  it("defaultLanes starts with All sources and empty membership", () => {
    const lanes = defaultLanes(3);
    expect(lanes).toHaveLength(3);
    expect(lanes[0]!.sources).toEqual([]);
    expect(lanes[0]!.label).toBe("All sources");
    expect(lanes[1]!.sources).toEqual([]);
  });

  it("resizeLaneList preserves hidden definitions when visible lanes shrink", () => {
    const base = [
      { id: "lane-0", label: "api", sources: ["api/app.jsonl"] },
      { id: "lane-1", label: "worker", sources: ["worker/worker.log"] },
    ];
    const grown = resizeLaneList(base, 3);
    expect(grown[0]).toEqual(base[0]);
    expect(grown[1]).toEqual(base[1]);
    expect(grown[2]!.sources).toEqual([]);
    const shrunk = resizeLaneList(grown, 1);
    expect(shrunk).toHaveLength(3);
    expect(shrunk[0]!.sources).toEqual(["api/app.jsonl"]);
    expect(shrunk[1]!.sources).toEqual(["worker/worker.log"]);
    expect(shrunk[2]!.sources).toEqual([]);
  });

  it("toggleLaneSource allows multi-source and all-sources empty set", () => {
    let lane: LaneConfig = {
      id: "lane-0",
      label: "All sources",
      sources: [],
    };
    lane = toggleLaneSource(lane, "a.log");
    expect(lane.sources).toEqual(["a.log"]);
    lane = toggleLaneSource(lane, "b.log");
    expect(lane.sources).toEqual(["a.log", "b.log"]);
    lane = toggleLaneSource(lane, "a.log");
    expect(lane.sources).toEqual(["b.log"]);
    lane = toggleLaneSource(lane, "b.log");
    expect(lane.sources).toEqual([]);
    expect(lane.rememberedSources).toEqual(["b.log"]);
  });

  it("round-trips through All sources without losing a specific composition", () => {
    const specific = {
      id: "lane-0",
      label: "2 sources",
      sources: ["region-a/app.log", "region-b/app.log"],
    };
    const all = selectAllLaneSources(specific);
    expect(all.sources).toEqual([]);
    expect(all.label).toBe("All sources");
    expect(all.rememberedSources).toEqual(specific.sources);

    const restored = restoreSpecificLaneSources(all);
    expect(restored.sources).toEqual(specific.sources);
    expect(restored.label).toBe("2 sources");
  });

  it("persists remembered specific membership while All sources is active", () => {
    const lane = selectAllLaneSources({
      id: "lane-0",
      label: "api",
      sources: ["api/app.log"],
    });
    saveLanes("corpus-a", [lane]);
    expect(loadLanes("corpus-a")).toEqual([lane]);
  });

  it("intersects composed lane sources with global source filters", () => {
    expect(composeLaneSources([], [])).toBeUndefined();
    expect(composeLaneSources(["api.log"], [])).toEqual(["api.log"]);
    expect(composeLaneSources([], ["worker.log"])).toEqual(["worker.log"]);
    expect(composeLaneSources(["api.log", "worker.log"], ["worker.log"]))
      .toEqual(["worker.log"]);
    expect(composeLaneSources(["api.log"], ["worker.log"])).toEqual([]);
  });

  it("persists lanes per corpus", () => {
    const lanes = defaultLanes(2);
    lanes[1] = { id: "lane-1", label: "edge", sources: ["edge/access.jsonl"] };
    saveLanes("corpus-a", lanes);
    expect(loadLanes("corpus-a")).toEqual(lanes);
    expect(loadLanes("corpus-b")).toBeNull();
  });

  it("applyEvidenceLanesToExplorer persists visible count, highlights, and dispatches", () => {
    const heard: unknown[] = [];
    const handler = (e: Event) => {
      heard.push((e as CustomEvent).detail);
    };
    window.addEventListener(EVIDENCE_LANE_APPLY_EVENT, handler);
    try {
      const applied = applyEvidenceLanesToExplorer({
        corpusId: "corpus-xyz-demo",
        lanes: [
          { id: "lane-0", label: "xyz-api", sources: ["xyz/api.log"] },
          { id: "lane-1", label: "xyz-worker", sources: ["xyz/worker.log"] },
        ],
        visibleLaneCount: 2,
        linkMode: "align_time",
        highlightSeqs: [101, 202],
      });
      expect(applied.visibleLaneCount).toBe(2);
      expect(loadVisibleLaneCount("corpus-xyz-demo")).toBe(2);
      expect(loadLanes("corpus-xyz-demo")?.map((l) => l.sources)).toEqual([
        ["xyz/api.log"],
        ["xyz/worker.log"],
      ]);
      expect(loadEvidenceHighlights("corpus-xyz-demo")).toEqual([101, 202]);
      expect(heard).toHaveLength(1);
      expect((heard[0] as { visibleLaneCount: number }).visibleLaneCount).toBe(
        2,
      );
    } finally {
      window.removeEventListener(EVIDENCE_LANE_APPLY_EVENT, handler);
    }
  });
});
