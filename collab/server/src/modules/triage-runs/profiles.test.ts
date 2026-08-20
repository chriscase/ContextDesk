import { describe, expect, it } from "vitest";
import { parseTriageProfileCatalog } from "./profiles.js";

describe("triage profile catalog", () => {
  it("keeps only bounded non-secret profile metadata and deduplicates ids", () => {
    expect(
      parseTriageProfileCatalog(
        JSON.stringify([
          { id: "profile:employer", label: "Employer gateway", provider: "openai-compatible", apiKey: "secret" },
          { id: "profile:employer", label: "duplicate", provider: "openai-compatible" },
          { id: "", label: "invalid", provider: "openai-compatible" },
        ]),
      ),
    ).toEqual([{ id: "profile:employer", label: "Employer gateway", provider: "openai-compatible" }]);
  });

  it("fails closed for malformed configuration", () => {
    expect(parseTriageProfileCatalog("not-json")).toEqual([]);
    expect(parseTriageProfileCatalog(JSON.stringify({ id: "profile:one" }))).toEqual([]);
  });
});
