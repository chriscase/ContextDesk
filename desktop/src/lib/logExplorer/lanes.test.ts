import { describe, expect, it } from "vitest";
import {
  clampLaneCount,
  computeGaps,
  exactAlignmentAllowed,
  linkAllowed,
  scrubLinked,
} from "./lanes";

describe("lanes link/gap", () => {
  it("refuses order_only link", () => {
    expect(linkAllowed("order_only")).toBeTruthy();
    const r = scrubLinked(
      100,
      [
        { id: "a", events: [{ seq: 1, ts: 100 }] },
        { id: "b", events: [{ seq: 2, ts: 200 }] },
      ],
      "order_only",
    );
    expect(r.linked).toBe(false);
  });

  it("scrubs peers on wall quality", () => {
    const r = scrubLinked(
      1100,
      [
        {
          id: "api",
          events: [
            { seq: 1, ts: 1000 },
            { seq: 2, ts: 1100 },
            { seq: 3, ts: 1200 },
          ],
        },
        {
          id: "worker",
          events: [
            { seq: 10, ts: 1050 },
            { seq: 11, ts: 1150 },
          ],
        },
      ],
      "wall",
    );
    expect(r.linked).toBe(true);
    expect(r.peerPositions.find((p) => p.laneId === "api")?.seq).toBe(2);
    expect(r.peerPositions.find((p) => p.laneId === "worker")?.seq).toBe(11);
  });

  it("allows approximate mixed-time follow but refuses exact mixed-time gaps", () => {
    const lanes = [
      { id: "a", events: [{ seq: 1, ts: 100 }] },
      { id: "b", events: [{ seq: 2, ts: 200 }] },
    ];
    expect(linkAllowed("mixed")).toBeNull();
    expect(scrubLinked(100, lanes, "mixed").linked).toBe(true);
    expect(exactAlignmentAllowed("mixed")).toMatch(/reliable shared wall clock/);
    expect(computeGaps(lanes, 100, 201, 10, "mixed")).toEqual({
      error:
        "exact alignment requires a reliable shared wall clock; corpus has mixed time quality",
    });
  });

  it("finds gaps where one lane empty", () => {
    const gaps = computeGaps(
      [
        {
          id: "a",
          events: [
            { seq: 1, ts: 0 },
            { seq: 2, ts: 10 },
            { seq: 3, ts: 50 },
          ],
        },
        {
          id: "b",
          events: [
            { seq: 10, ts: 0 },
            { seq: 11, ts: 50 },
          ],
        },
      ],
      0,
      60,
      10,
      "wall",
    );
    expect(Array.isArray(gaps)).toBe(true);
    const list = gaps as { emptyLaneIds: string[]; filledLaneIds: string[] }[];
    expect(
      list.some(
        (g) => g.emptyLaneIds.includes("b") && g.filledLaneIds.includes("a"),
      ),
    ).toBe(true);
  });

  it("clamps lane count 1–4", () => {
    expect(clampLaneCount(0)).toBe(1);
    expect(clampLaneCount(3)).toBe(3);
    expect(clampLaneCount(99)).toBe(4);
  });
});
