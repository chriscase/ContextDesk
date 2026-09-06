import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERVIEW_ACTIVITY_QUERY,
  isWorkLocation,
  parsePathname,
  pathFor,
  sameLocation,
  type WorkLocation,
} from "./app-location.js";

const OVERVIEW: WorkLocation = { area: "overview", caseId: null, stage: "situation" };

describe("the Overview Activity Center address", () => {
  it("round-trips canonical activity filters without transport state", () => {
    const parsed = parsePathname(
      "/",
      "?activityKind=handoff_recorded&stage=situation&from=2026-09-01T00:00:00.000Z&to=2026-09-03T23:59:59.999Z",
    );
    expect(parsed).toEqual({
      ...OVERVIEW,
      overviewActivityQuery: {
        activityKind: "handoff_recorded",
        stage: "situation",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-03T23:59:59.999Z",
      },
    });
    expect(pathFor(parsed)).toBe(
      "/?activityKind=handoff_recorded&stage=situation&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-03T23%3A59%3A59.999Z",
    );
    expect(parsePathname(pathFor(parsed).split("?")[0]!, `?${pathFor(parsed).split("?")[1]}`)).toEqual(parsed);
  });

  it("omits defaults and strips invalid or runtime-owned fields", () => {
    const defaults: WorkLocation = { ...OVERVIEW, overviewActivityQuery: DEFAULT_OVERVIEW_ACTIVITY_QUERY };
    expect(pathFor(defaults)).toBe("/");
    expect(sameLocation(defaults, OVERVIEW)).toBe(true);
    const parsed = parsePathname(
      "/",
      "?activityKind=not-real&stage=bad&from=not-a-date&to=2026-09-03T23:59:59.999Z&cursor=secret&limit=40&schemaId=wrong",
    );
    expect(isWorkLocation(parsed)).toBe(true);
    expect(parsed).toEqual({
      ...OVERVIEW,
      overviewActivityQuery: {
        activityKind: null,
        stage: null,
        from: null,
        to: "2026-09-03T23:59:59.999Z",
      },
    });
    expect(pathFor(parsed)).toBe("/?to=2026-09-03T23%3A59%3A59.999Z");
    expect(pathFor(parsed)).not.toContain("cursor");
    expect(pathFor(parsed)).not.toContain("schemaId");
  });
});
