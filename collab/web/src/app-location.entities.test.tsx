/**
 * The Entities area as an address.
 *
 * Entities is a sibling of Attribution, not a tab inside it, so it needs its
 * own path, title, and round trip. Pinning that here keeps the two areas from
 * quietly collapsing into one the next time the shell is refactored.
 */
import { describe, expect, it } from "vitest";
import { AREA_IDS, areaPathFor, isWorkLocation, parsePathname, pathFor, titleFor } from "./app-location.js";

const ENTITIES = { area: "entities" as const, caseId: null, stage: "situation" as const };

describe("the Entities address", () => {
  it("is a first-class area beside Attribution", () => {
    expect(AREA_IDS).toContain("entities");
    expect(AREA_IDS).toContain("sources");
    expect(AREA_IDS.indexOf("entities")).not.toBe(AREA_IDS.indexOf("sources"));
  });

  it("round-trips through its own path", () => {
    expect(pathFor(ENTITIES)).toBe("/entities");
    expect(areaPathFor(ENTITIES)).toBe("/entities");
    const parsed = parsePathname("/entities");
    expect(isWorkLocation(parsed)).toBe(true);
    expect(parsed).toEqual(ENTITIES);
  });

  it("keeps a trailing slash and a repeated segment out of the area", () => {
    expect(parsePathname("/entities/")).toEqual(ENTITIES);
    expect(parsePathname("/entities/extra")).toMatchObject({ kind: "unknown" });
    expect(parsePathname("//entities")).toMatchObject({ kind: "unknown" });
  });

  it("titles itself distinctly from Attribution", () => {
    expect(titleFor(ENTITIES)).toBe("Entities · ContextDesk War Room");
    expect(titleFor({ area: "sources", caseId: null, stage: "situation" })).toBe(
      "Attribution · ContextDesk War Room",
    );
  });
});
