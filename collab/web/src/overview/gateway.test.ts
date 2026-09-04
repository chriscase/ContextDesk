import { describe, expect, it } from "vitest";
import { activityQuery } from "./gateway.js";

describe("Activity Center query", () => {
  it("serializes only explicit server-owned filters and keeps cursors opaque", () => {
    expect(activityQuery({
      filter: {
        activityKind: "handoff_recorded",
        stage: "situation",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-03T23:59:59.999Z",
      },
      cursor: "opaque_cursor-2",
      limit: 40,
    })).toBe(
      "/api/investigation-activity?limit=40&activityKind=handoff_recorded&stage=situation&from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-03T23%3A59%3A59.999Z&cursor=opaque_cursor-2",
    );
    expect(activityQuery({ filter: {} })).toBe("/api/investigation-activity?limit=30");
    expect(activityQuery({ filter: {} })).not.toContain("assignedToMe");
  });
});
