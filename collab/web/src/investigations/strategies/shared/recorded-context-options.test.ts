import { describe, expect, it } from "vitest";
import {
  recordedContextCatalogFromView,
  recordedContextOptions,
  type RecordedContextRecord,
} from "./recorded-context-options.js";

const records: readonly RecordedContextRecord[] = [
  { investigationContext: { productName: "Storefront", version: "2.0", build: "B-20" } },
  { investigationContext: { productName: "Billing", version: "1.0", build: "B-10" } },
  { investigationContext: { productName: "Storefront", version: "2.0", build: "B-20" } },
  { investigationContext: { productName: " storefront ", version: " beta ", build: " B-x " } },
  { investigationContext: { productName: "   ", version: "", build: "" } },
];

describe("recorded context options", () => {
  it("preserves first-seen exact literals without sorting, trimming, or case folding", () => {
    expect(recordedContextOptions(records, "productName")).toEqual([
      "Storefront",
      "Billing",
      " storefront ",
    ]);
  });

  it("narrows version and build suggestions only for exact recorded parent matches", () => {
    expect(recordedContextOptions(records, "version", { productName: "Storefront" })).toEqual(["2.0"]);
    expect(recordedContextOptions(records, "build", { productName: "Storefront", version: "2.0" })).toEqual(["B-20"]);
    expect(recordedContextOptions(records, "version", { productName: "storefront" })).toEqual(["2.0", "1.0", " beta "]);
    expect(recordedContextOptions(records, "version", { productName: "" })).toEqual(["2.0", "1.0", " beta "]);
    expect(recordedContextOptions(records, "build", { productName: "Storefront", version: "" })).toEqual(["B-20", "B-10", " B-x "]);
  });

  it("reports stale authorized values separately from unavailable or empty state", () => {
    expect(recordedContextCatalogFromView({ availability: "available", value: records, refresh: "failed" }, true)).toEqual({ status: "stale", records });
    expect(recordedContextCatalogFromView({ availability: "unavailable" }, true)).toEqual({ status: "unavailable", records: [] });
    expect(recordedContextCatalogFromView({ availability: "available", value: [], refresh: "settled" }, true)).toEqual({ status: "empty", records: [] });
  });

  it("reports a no-read catalog as not requested without exposing retained records", () => {
    expect(recordedContextCatalogFromView({
      availability: "available",
      value: records,
      refresh: "failed",
    }, false)).toEqual({ status: "not-requested", records: [] });
    expect(recordedContextCatalogFromView({ availability: "idle" }, false)).toEqual({
      status: "not-requested",
      records: [],
    });
  });
});
