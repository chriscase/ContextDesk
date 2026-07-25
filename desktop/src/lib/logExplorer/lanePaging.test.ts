import { describe, expect, it, vi } from "vitest";
import {
  cursorFromPage,
  filtersToLaneQuery,
  laneHasMore,
  type LaneCursor,
} from "./lanePaging";
import { emptyFilters, type LaneConfig } from "./types";

describe("lanePaging (#505)", () => {
  const lane: LaneConfig = {
    id: "lane-1",
    label: "api",
    sources: ["api.log"],
  };

  it("builds composite keyset query per lane", () => {
    const f = emptyFilters();
    f.levels = ["error"];
    const cur: LaneCursor = { afterSeq: 10, afterTs: 1_700_000_000 };
    const q = filtersToLaneQuery(f, lane, cur, 50);
    expect(q.sources).toEqual(["api.log"]);
    expect(q.levels).toEqual(["error"]);
    expect(q.afterSeq).toBe(10);
    expect(q.afterTs).toBe(1_700_000_000);
    expect(q.sortByTime).toBe(true);
    expect(q.limit).toBe(50);
  });

  it("laneHasMore is false at end of pages", () => {
    expect(laneHasMore(undefined)).toBe(false);
    expect(laneHasMore({ afterSeq: null, afterTs: null })).toBe(false);
    expect(laneHasMore({ afterSeq: 5, afterTs: 100 })).toBe(true);
  });

  it("page-to-end simulation uses composite cursors (no silent stop)", async () => {
    // Simulate host pages for one lane until nextCursor null — must use afterTs.
    const pages = [
      {
        events: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 })),
        nextCursor: 100,
        nextTs: 1_700_000_100,
        totalMatched: 250,
      },
      {
        events: Array.from({ length: 100 }, (_, i) => ({ seq: i + 101 })),
        nextCursor: 200,
        nextTs: 1_700_000_200,
        totalMatched: 250,
      },
      {
        events: Array.from({ length: 50 }, (_, i) => ({ seq: i + 201 })),
        nextCursor: null,
        nextTs: null,
        totalMatched: 250,
      },
    ];
    let pageIdx = 0;
    const queryHost = vi.fn(async (q: { afterSeq?: number | null; afterTs?: number | null }) => {
      // Assert time-sort pages always send afterTs with afterSeq after first page
      if (pageIdx > 0) {
        expect(q.afterSeq).not.toBeNull();
        expect(q.afterTs).not.toBeNull();
      }
      const p = pages[pageIdx]!;
      pageIdx += 1;
      return p;
    });

    const seen = new Set<number>();
    let cursor: LaneCursor | undefined;
    let totalMatched = 0;
    // first page
    let q = filtersToLaneQuery(emptyFilters(), lane, undefined, 100);
    let page = await queryHost(q);
    totalMatched = page.totalMatched;
    for (const e of page.events) seen.add(e.seq);
    cursor = cursorFromPage(page);
    while (laneHasMore(cursor)) {
      q = filtersToLaneQuery(emptyFilters(), lane, cursor, 100);
      page = await queryHost(q);
      for (const e of page.events) seen.add(e.seq);
      cursor = cursorFromPage(page);
    }
    expect(seen.size).toBe(totalMatched);
    expect(queryHost).toHaveBeenCalledTimes(3);
  });
});
