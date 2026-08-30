import { describe, expect, it } from "vitest";
import type { RuntimeFailure } from "./errors.js";
import { selectEvidenceInventory, selectResourceView } from "./selectors.js";
import type { ResourceState } from "./types.js";

const unavailable: RuntimeFailure = { kind: "unavailable", status: 503 };
const network: RuntimeFailure = { kind: "network" };

describe("resource selectors", () => {
  it("keeps idle and initial loading distinct", () => {
    expect(selectResourceView<string[]>({ status: "idle" })).toEqual({
      availability: "idle",
    });
    expect(selectResourceView<string[]>({ status: "loading" })).toEqual({
      availability: "loading",
    });
  });

  it("treats a ready empty collection as available rather than failed", () => {
    const selected = selectResourceView<readonly string[]>({
      status: "ready",
      value: [],
    });
    expect(selected).toEqual({
      availability: "available",
      value: [],
      refresh: "settled",
    });
    expect(selected.availability).toBe("available");
  });

  it("keeps a first-load failure unavailable", () => {
    expect(selectResourceView<string[]>({
      status: "failed",
      error: unavailable,
    })).toEqual({ availability: "unavailable", error: unavailable });
  });

  it("preserves the exact previous value during loading and refresh failure", () => {
    const previous = ["case-a"] as const;
    expect(selectResourceView<readonly string[]>({
      status: "loading",
      previous,
    })).toEqual({
      availability: "available",
      value: previous,
      refresh: "loading",
    });
    expect(selectResourceView<readonly string[]>({
      status: "failed",
      error: network,
      previous,
    })).toEqual({
      availability: "available",
      value: previous,
      refresh: "failed",
      refreshError: network,
    });
  });
});

type Evidence = {
  id: string;
  summaryContributionId?: string | null;
};

type Annotation = {
  id: string;
  body: string;
};

const evidence: readonly Evidence[] = [
  { id: "evidence-a", summaryContributionId: "summary-a" },
  { id: "evidence-b", summaryContributionId: null },
];
const annotations: readonly Annotation[] = [
  { id: "summary-a", body: "Operator summary" },
  { id: "unrelated", body: "Not evidence A" },
];

describe("evidence inventory selector", () => {
  it("joins a matching summary and leaves unannotated evidence explicit", () => {
    const selected = selectEvidenceInventory<Evidence, Annotation>(
      { status: "ready", value: evidence },
      { status: "ready", value: annotations },
    );
    expect(selected.inventory).toEqual({
      availability: "available",
      refresh: "settled",
      value: [
        { evidence: evidence[0], annotation: annotations[0] },
        { evidence: evidence[1], annotation: null },
      ],
    });
    expect(selected.annotations).toEqual({
      availability: "available",
      refresh: "settled",
      value: annotations,
    });
  });

  it("does not hide inventory when annotations fail on their first load", () => {
    const selected = selectEvidenceInventory<Evidence, Annotation>(
      { status: "ready", value: evidence },
      { status: "failed", error: unavailable },
    );
    expect(selected.inventory).toEqual({
      availability: "available",
      refresh: "settled",
      value: evidence.map((item) => ({ evidence: item, annotation: null })),
    });
    expect(selected.annotations).toEqual({
      availability: "unavailable",
      error: unavailable,
    });
  });

  it("uses previous annotations while surfacing their refresh failure", () => {
    const selected = selectEvidenceInventory<Evidence, Annotation>(
      { status: "ready", value: evidence },
      { status: "failed", error: network, previous: annotations },
    );
    expect(selected.inventory.availability).toBe("available");
    if (selected.inventory.availability === "available") {
      expect(selected.inventory.value[0]?.annotation).toBe(annotations[0]);
    }
    expect(selected.annotations).toEqual({
      availability: "available",
      value: annotations,
      refresh: "failed",
      refreshError: network,
    });
  });

  it("preserves previous evidence and its refresh error", () => {
    const selected = selectEvidenceInventory<Evidence, Annotation>(
      { status: "failed", error: unavailable, previous: evidence },
      { status: "ready", value: annotations },
    );
    expect(selected.inventory).toEqual({
      availability: "available",
      refresh: "failed",
      refreshError: unavailable,
      value: [
        { evidence: evidence[0], annotation: annotations[0] },
        { evidence: evidence[1], annotation: null },
      ],
    });
  });

  it("keeps evidence failure distinct from a ready empty inventory", () => {
    const failed = selectEvidenceInventory<Evidence, Annotation>(
      { status: "failed", error: unavailable },
      { status: "ready", value: [] },
    );
    expect(failed.inventory).toEqual({
      availability: "unavailable",
      error: unavailable,
    });

    const empty = selectEvidenceInventory<Evidence, Annotation>(
      { status: "ready", value: [] },
      { status: "failed", error: network },
    );
    expect(empty.inventory).toEqual({
      availability: "available",
      value: [],
      refresh: "settled",
    });
    expect(empty.annotations.availability).toBe("unavailable");
  });

  it("does not publish an inventory before evidence has a value", () => {
    const state: ResourceState<readonly Evidence[]> = { status: "loading" };
    const selected = selectEvidenceInventory<Evidence, Annotation>(
      state,
      { status: "ready", value: annotations },
    );
    expect(selected.inventory).toEqual({ availability: "loading" });
  });
});
