import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  defaultLanes,
  resizeLaneList,
  toggleLaneSource,
  loadLanes,
  saveLanes,
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

  it("resizeLaneList preserves existing definitions", () => {
    const base = [
      { id: "lane-0", label: "api", sources: ["api/app.jsonl"] },
      { id: "lane-1", label: "worker", sources: ["worker/worker.log"] },
    ];
    const grown = resizeLaneList(base, 3);
    expect(grown[0]).toEqual(base[0]);
    expect(grown[1]).toEqual(base[1]);
    expect(grown[2]!.sources).toEqual([]);
    const shrunk = resizeLaneList(grown, 1);
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]!.sources).toEqual(["api/app.jsonl"]);
  });

  it("toggleLaneSource allows multi-source and all-sources empty set", () => {
    let lane = { id: "lane-0", label: "All sources", sources: [] as string[] };
    lane = toggleLaneSource(lane, "a.log");
    expect(lane.sources).toEqual(["a.log"]);
    lane = toggleLaneSource(lane, "b.log");
    expect(lane.sources).toEqual(["a.log", "b.log"]);
    lane = toggleLaneSource(lane, "a.log");
    expect(lane.sources).toEqual(["b.log"]);
    lane = toggleLaneSource(lane, "b.log");
    expect(lane.sources).toEqual([]);
  });

  it("persists lanes per corpus", () => {
    const lanes = defaultLanes(2);
    lanes[1] = { id: "lane-1", label: "edge", sources: ["edge/access.jsonl"] };
    saveLanes("corpus-a", lanes);
    expect(loadLanes("corpus-a")).toEqual(lanes);
    expect(loadLanes("corpus-b")).toBeNull();
  });
});
