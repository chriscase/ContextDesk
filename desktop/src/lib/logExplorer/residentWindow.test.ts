import { describe, expect, it } from "vitest";
import type { ExplorerEventDto } from "../host";
import {
  appendNewer,
  mergeAscending,
  prependOlder,
  seedFromPage,
} from "./residentWindow";

function ev(seq: number, ts = 1_700_000_000 + seq): ExplorerEventDto {
  return {
    seq,
    ts,
    timeQuality: "wall",
    level: "info",
    service: null,
    host: null,
    templateId: 1,
    traceId: null,
    message: `m${seq}`,
    source: "a.log",
  };
}

describe("residentWindow", () => {
  it("merges without duplicates and keeps ascending order", () => {
    const merged = mergeAscending([ev(2), ev(4)], [ev(3), ev(2), ev(5)]);
    expect(merged.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
  });

  it("appends newer pages and evicts from the head when over budget", () => {
    const seed = seedFromPage({
      events: [ev(1), ev(2), ev(3)],
      nextCursor: 3,
      nextTs: ev(3).ts,
      prevCursor: 1,
      prevTs: ev(1).ts,
      totalMatched: 100,
    });
    const { window, droppedFromHead } = appendNewer(
      seed,
      {
        events: [ev(4), ev(5)],
        nextCursor: 5,
        nextTs: ev(5).ts,
        totalMatched: 100,
      },
      4,
    );
    expect(droppedFromHead).toBe(1);
    expect(window.events.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    expect(window.afterSeq).toBe(5);
  });

  it("prepends older pages and reports prepended count for scroll anchor", () => {
    const seed = seedFromPage({
      events: [ev(10), ev(11)],
      nextCursor: 11,
      nextTs: ev(11).ts,
      prevCursor: 10,
      prevTs: ev(10).ts,
      totalMatched: 50,
    });
    const { window, prepended, droppedFromTail } = prependOlder(
      seed,
      {
        events: [ev(8), ev(9)],
        prevCursor: 8,
        prevTs: ev(8).ts,
        totalMatched: 50,
      },
      100,
    );
    expect(prepended).toBe(2);
    expect(droppedFromTail).toBe(0);
    expect(window.events.map((e) => e.seq)).toEqual([8, 9, 10, 11]);
    expect(window.beforeSeq).toBe(8);
  });

  it("stays bounded and gap-free while alternating both paging directions", () => {
    let window = seedFromPage({
      events: Array.from({ length: 100 }, (_, index) => ev(901 + index)),
      nextCursor: 1000,
      nextTs: ev(1000).ts,
      prevCursor: 901,
      prevTs: ev(901).ts,
      totalMatched: 2_000,
    });

    for (let start = 1001; start <= 1800; start += 100) {
      ({ window } = appendNewer(
        window,
        {
          events: Array.from({ length: 100 }, (_, index) =>
            ev(start + index),
          ),
          nextCursor: start + 99,
          nextTs: ev(start + 99).ts,
          totalMatched: 2_000,
        },
        800,
      ));
      expect(window.events.length).toBeLessThanOrEqual(800);
    }
    expect(window.events[0]?.seq).toBe(1001);
    expect(window.events.at(-1)?.seq).toBe(1800);

    for (let end = 1000; end >= 300; end -= 100) {
      const result = prependOlder(
        window,
        {
          events: Array.from({ length: 100 }, (_, index) =>
            ev(end - 99 + index),
          ),
          prevCursor: end - 99,
          prevTs: ev(end - 99).ts,
          totalMatched: 2_000,
        },
        800,
      );
      window = result.window;
      expect(window.events.length).toBeLessThanOrEqual(800);
    }
    expect(window.events[0]?.seq).toBe(201);
    expect(window.events.at(-1)?.seq).toBe(1000);
    expect(window.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 800 }, (_, index) => 201 + index),
    );
  });

  it("orders equal timestamps by stable sequence without duplicates", () => {
    const timestamp = 1_700_000_000;
    const merged = mergeAscending(
      [ev(4, timestamp), ev(2, timestamp)],
      [ev(3, timestamp), ev(4, timestamp), ev(1, timestamp)],
    );
    expect(merged.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });
});
