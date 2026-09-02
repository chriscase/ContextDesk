import { describe, expect, it } from "vitest";
import {
  MODEL_POLICY,
  EVIDENCE_STORAGE_ADMIN,
  UI_STRATEGY_POLICY,
  areaPathFor,
  parsePathname,
  titleFor,
} from "./app-location.js";

describe("administration policy addresses", () => {
  it("round-trips model and UI-strategy policy tabs through distinct canonical paths", () => {
    expect(areaPathFor(MODEL_POLICY)).toBe("/admin/model-policy");
    expect(parsePathname("/admin/model-policy")).toEqual(MODEL_POLICY);
    expect(areaPathFor(UI_STRATEGY_POLICY)).toBe("/admin/ui-strategies");
    expect(parsePathname("/admin/ui-strategies")).toEqual(UI_STRATEGY_POLICY);
  });

  it("gives the strategy policy an honest browser title", () => {
    expect(titleFor(UI_STRATEGY_POLICY)).toBe(
      "Investigation experiences · Administration · ContextDesk War Room",
    );
  });

  it("round-trips the evidence-storage diagnostics tab", () => {
    expect(areaPathFor(EVIDENCE_STORAGE_ADMIN)).toBe("/admin/storage");
    expect(parsePathname("/admin/storage")).toEqual(EVIDENCE_STORAGE_ADMIN);
    expect(titleFor(EVIDENCE_STORAGE_ADMIN)).toBe(
      "Evidence storage · Administration · ContextDesk War Room",
    );
  });
});
