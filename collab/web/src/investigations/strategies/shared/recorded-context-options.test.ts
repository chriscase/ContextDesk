import { describe, expect, it } from "vitest";
import {
  RECORDED_CONTEXT_LIMIT,
  recordedContextCatalogFromView,
  recordedContextOptions,
  recordedContextTupleKey,
  recordedContextTuples,
  type RecordedContextRecord,
} from "./recorded-context-options.js";

const records: RecordedContextRecord[] = [
  { investigationContext: { productName: "Desk", version: "1.0", build: "a|b", component: "queue", organization: "Synthetic Team" } },
  { investigationContext: { productName: "Other", version: "9.0", build: "z", component: "queue" } },
  { investigationContext: { productName: "Desk", version: "1.0", build: "a|b", environment: "QA" } },
  { investigationContext: { productName: "desk", version: "1.0 ", build: "a", organization: "  Synthetic Team  " } },
  { investigationContext: { productName: "   ", version: "solo", build: "unbound" } },
];

describe("recorded software context selection", () => {
  it("keeps exact first-observed strings and omits whitespace-only values", () => {
    expect(recordedContextOptions(records, "productName").values).toEqual(["Desk", "Other", "desk"]);
    expect(recordedContextOptions(records, "component").values).toEqual(["queue"]);
    expect(recordedContextOptions(records, "organization").values).toEqual(["Synthetic Team", "  Synthetic Team  "]);
  });

  it("never borrows a version or build from a different exact parent", () => {
    expect(recordedContextOptions(records, "version", { productName: "Missing" }).values).toEqual([]);
    expect(recordedContextOptions(records, "build", { productName: "Desk", version: "9.0" }).values).toEqual([]);
    expect(recordedContextOptions(records, "build", { productName: "Desk" }).values).toEqual(["a|b"]);
    expect(recordedContextOptions(records, "build", { version: "1.0" }).values).toEqual(["a|b"]);
    expect(recordedContextOptions(records, "version", { productName: "desk" }).values).toEqual(["1.0 "]);
    expect(recordedContextOptions(records, "build", { productName: "Desk", version: " 1.0" }).values).toEqual([]);
  });

  it("caps only the displayed options and tuples, not the source or legal input", () => {
    const many = Array.from({ length: RECORDED_CONTEXT_LIMIT + 2 }, (_, i) => ({
      investigationContext: { productName: `Fixture ${i}`, version: `v${i}`, build: `b${i}` },
    }));
    const options = recordedContextOptions(many, "productName");
    const tuples = recordedContextTuples(many);
    expect(options.values).toHaveLength(RECORDED_CONTEXT_LIMIT);
    expect(options.truncated).toBe(true);
    expect(options.values).not.toContain(`Fixture ${RECORDED_CONTEXT_LIMIT + 1}`);
    expect(tuples.values).toHaveLength(RECORDED_CONTEXT_LIMIT);
    expect(tuples.truncated).toBe(true);
    expect(many).toHaveLength(RECORDED_CONTEXT_LIMIT + 2);
  });

  it("keeps real combinations with missing fields and collision-free exact keys", () => {
    const tuples = recordedContextTuples(records).values;
    expect(tuples).toHaveLength(4);
    expect(tuples[0]).toMatchObject({ productName: "Desk", version: "1.0", build: "a|b" });
    expect(tuples[3]).toMatchObject({ productName: "", version: "solo", build: "unbound" });
    expect(recordedContextTupleKey("a|b", "c", "d")).not.toBe(recordedContextTupleKey("a", "b|c", "d"));
    expect(recordedContextTupleKey("é", "x", "")).not.toBe(recordedContextTupleKey("é", "x", ""));
  });

  it("withholds old source values on read loss and marks failed refresh stale", () => {
    const view = { availability: "available" as const, value: records, refresh: "failed" as const };
    expect(recordedContextCatalogFromView(view, false)).toEqual({ status: "not-requested", records: [], partial: true });
    expect(recordedContextCatalogFromView(view, true)).toEqual({ status: "stale", records, partial: true });
    expect(recordedContextCatalogFromView({ availability: "available", value: [], refresh: "settled" }, true).status).toBe("empty");
    expect(recordedContextCatalogFromView({ availability: "unavailable" }, true).status).toBe("unavailable");
  });

  it("distinguishes an idle request from loading and a previous snapshot being refreshed", () => {
    expect(recordedContextCatalogFromView({ availability: "idle" }, true))
      .toEqual({ status: "idle", records: [], partial: true });
    expect(recordedContextCatalogFromView({ availability: "loading" }, true))
      .toEqual({ status: "loading", records: [], partial: true });
    expect(recordedContextCatalogFromView({ availability: "available", value: records, refresh: "loading" }, true))
      .toEqual({ status: "refreshing", records, partial: true });
    expect(recordedContextCatalogFromView({ availability: "available", value: records, refresh: "loading" }, false))
      .toEqual({ status: "not-requested", records: [], partial: true });
  });
});
