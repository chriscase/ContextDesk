import { describe, expect, it } from "vitest";
import {
  AREA_IDS,
  DEFAULT_OPERATIONS_QUEUE_QUERY,
  isWorkLocation,
  parsePathname,
  pathFor,
  sameLocation,
  titleFor,
  type WorkLocation,
} from "./app-location.js";

const OPERATIONS: WorkLocation = {
  area: "operations",
  caseId: null,
  stage: "situation",
};

describe("the Operations Queue address", () => {
  it("is a first-class shell area with its own title", () => {
    expect(AREA_IDS.indexOf("operations")).toBe(AREA_IDS.indexOf("investigations") + 1);
    expect(pathFor(OPERATIONS)).toBe("/operations");
    expect(parsePathname("/operations")).toEqual(OPERATIONS);
    expect(titleFor(OPERATIONS)).toBe("Operations · ContextDesk War Room");
  });

  it("round-trips only the canonical shareable queue fields", () => {
    const parsed = parsePathname(
      "/operations",
      "?status=resolved&q=%20checkout%20&includeArchived=true&coordinationScope=mine",
    );
    expect(parsed).toEqual({
      ...OPERATIONS,
      operationsQueueQuery: {
        q: "checkout",
        status: ["resolved"],
        includeArchived: true,
        coordinationScope: "mine",
      },
    });
    expect(pathFor(parsed)).toBe(
      "/operations?q=checkout&status=resolved&includeArchived=true&coordinationScope=mine",
    );
    const canonical = new URL(pathFor(parsed), "https://contextdesk.invalid");
    expect(parsePathname(canonical.pathname, canonical.search)).toEqual(parsed);
  });

  it("omits the all-visible defaults", () => {
    const withDefaults: WorkLocation = {
      ...OPERATIONS,
      operationsQueueQuery: DEFAULT_OPERATIONS_QUEUE_QUERY,
    };
    expect(pathFor(withDefaults)).toBe("/operations");
    expect(sameLocation(withDefaults, OPERATIONS)).toBe(true);
  });

  it("strips invalid, unknown, and runtime-owned fields during canonicalization", () => {
    const parsed = parsePathname(
      "/operations",
      "?q=checkout&status=not-a-status&includeArchived=sometimes&coordinationScope=ranked"
        + "&cursor=opaque-cursor&limit=1&schemaId=wrong&actorId=mallory&entityId=entity-1"
        + "&impactIdentity=secret&contributorId=identity-x&recordedFrom=2026-01-01&unexpected=yes",
    );
    expect(isWorkLocation(parsed)).toBe(true);
    expect(parsed).toEqual({
      ...OPERATIONS,
      operationsQueueQuery: {
        q: "checkout",
        status: [],
        includeArchived: false,
        coordinationScope: "all_visible",
      },
    });
    expect(pathFor(parsed)).toBe("/operations?q=checkout");
    for (const forbidden of [
      "cursor",
      "limit",
      "schemaId",
      "actorId",
      "entityId",
      "impactIdentity",
      "contributorId",
      "recordedFrom",
      "unexpected",
    ]) {
      expect(pathFor(parsed)).not.toContain(forbidden);
    }
  });

  it("canonicalizes status order without admitting duplicate filters", () => {
    const parsed = parsePathname(
      "/operations",
      "?status=archived&status=open&status=monitoring",
    );
    expect(pathFor(parsed)).toBe(
      "/operations?status=open&status=monitoring&status=archived",
    );
    expect(pathFor(parsePathname("/operations", "?status=open&status=open"))).toBe(
      "/operations",
    );
  });
});
