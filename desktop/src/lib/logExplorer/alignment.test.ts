import { describe, expect, it } from "vitest";
import { buildAlignedLaneRows } from "./alignment";

type Event = { seq: number; ts: number; height: number };

describe("buildAlignedLaneRows", () => {
  it("shares exact timestamp rows and represents missing evidence as null", () => {
    const rows = buildAlignedLaneRows<Event>(
      [
        {
          id: "api",
          events: [
            { seq: 1, ts: 100, height: 24 },
            { seq: 3, ts: 300, height: 40 },
          ],
        },
        {
          id: "db",
          events: [
            { seq: 2, ts: 100, height: 32 },
            { seq: 4, ts: 200, height: 24 },
          ],
        },
      ],
      (event) => event.height,
      20,
    );

    expect(
      rows.api.map((row) => [row.key, row.event?.seq, row.height]),
    ).toEqual([
      ["100:0", 1, 32],
      ["200:0", undefined, 24],
      ["300:0", 3, 40],
    ]);
    expect(rows.db.map((row) => [row.key, row.event?.seq, row.height])).toEqual(
      [
        ["100:0", 2, 32],
        ["200:0", 4, 24],
        ["300:0", undefined, 40],
      ],
    );
  });

  it("creates stable occurrence rows for duplicates without dropping events", () => {
    const rows = buildAlignedLaneRows<Event>(
      [
        {
          id: "a",
          events: [
            { seq: 1, ts: 100, height: 20 },
            { seq: 2, ts: 100, height: 30 },
          ],
        },
        {
          id: "b",
          events: [{ seq: 3, ts: 100, height: 25 }],
        },
      ],
      (event) => event.height,
      20,
    );

    expect(rows.a.map((row) => row.event?.seq)).toEqual([1, 2]);
    expect(rows.b.map((row) => row.event?.seq ?? null)).toEqual([3, null]);
    expect(rows.a.map((row) => row.height)).toEqual([25, 30]);
    expect(rows.b.map((row) => row.height)).toEqual([25, 30]);
  });

  it("returns empty bounded lane arrays for no resident events", () => {
    expect(
      buildAlignedLaneRows(
        [
          { id: "a", events: [] },
          { id: "b", events: [] },
        ],
        () => 20,
        20,
      ),
    ).toEqual({ a: [], b: [] });
  });
});
