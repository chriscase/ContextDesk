import { describe, expect, it } from "vitest";
import * as publicRuntime from "./public.js";

describe("investigation runtime public surface", () => {
  it("does not expose transport or protected-fetch internals at runtime", () => {
    expect(Object.keys(publicRuntime).sort()).toEqual([
      "InvestigationRuntimeProvider",
      "MAX_EVIDENCE_UPLOAD_BYTES",
      "selectEvidenceInventory",
      "selectResourceView",
      "useInvestigationRuntime",
    ]);
  });
});
