import { describe, expect, it } from "vitest";
import {
  VIRTUALIZE_THRESHOLD,
  computeWindowPlan,
  forceKeepIndices,
} from "./messageWindow";

describe("computeWindowPlan (#148)", () => {
  it("mounts everything below the virtualize threshold", () => {
    const count = VIRTUALIZE_THRESHOLD;
    const r = computeWindowPlan({
      count,
      scrollTop: 0,
      clientHeight: 400,
      heights: new Map(),
      estimatePx: 100,
    });
    expect(r.virtualized).toBe(false);
    expect(r.indices).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(r.totalHeight).toBe(count * 100);
  });

  it("windows long lists with overscan", () => {
    const count = 300;
    const estimate = 100;
    const r = computeWindowPlan({
      count,
      scrollTop: 100 * estimate,
      clientHeight: 500,
      heights: new Map(),
      estimatePx: estimate,
      overscan: 2,
    });
    expect(r.virtualized).toBe(true);
    expect(r.indices.length).toBeLessThan(30);
    expect(r.indices).toContain(100);
    expect(r.totalHeight).toBe(count * estimate);
  });

  it("keeps streaming force index without mounting the entire gap", () => {
    const count = 200;
    const r = computeWindowPlan({
      count,
      scrollTop: 0,
      clientHeight: 400,
      heights: new Map(),
      estimatePx: 100,
      overscan: 1,
      forceIndices: [199],
    });
    expect(r.indices).toContain(0);
    expect(r.indices).toContain(199);
    // Must not mount every row just to include the tail
    expect(r.indices.length).toBeLessThan(30);
    expect(r.indices).not.toContain(100);
  });

  it("uses measured heights for total", () => {
    const heights = new Map<number, number>([
      [0, 200],
      [1, 50],
      [2, 50],
    ]);
    const count = VIRTUALIZE_THRESHOLD + 5;
    const r = computeWindowPlan({
      count,
      scrollTop: 0,
      clientHeight: 300,
      heights,
      estimatePx: 80,
      overscan: 0,
    });
    expect(r.totalHeight).toBe(200 + 50 + 50 + (count - 3) * 80);
  });
});

describe("forceKeepIndices (#148)", () => {
  it("keeps streaming rows and the last row", () => {
    expect(
      forceKeepIndices([
        { streaming: false },
        { streaming: true },
        { streaming: false },
      ]),
    ).toEqual([1, 2]);
  });

  it("returns empty for empty transcript", () => {
    expect(forceKeepIndices([])).toEqual([]);
  });
});
