import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT } from "../protected-api.js";
import { activityQuery, overviewGateway } from "./gateway.js";

afterEach(() => vi.restoreAllMocks());

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
    expect(activityQuery({ filter: { assignedToMe: false } })).toContain("assignedToMe=false");
  });

  it.each([401, 403] as const)("preserves protected shell auth loss for %i", async (status) => {
    const response = new Response("not parsed", { status });
    const json = vi.spyOn(response, "json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const listener = vi.fn();
    window.addEventListener(AUTH_LOST_EVENT, listener);
    try {
      await expect(overviewGateway.listActivity({ filter: {} }, new AbortController().signal)).resolves.toEqual({
        ok: false,
        error: { kind: "http", status },
      });
      expect(json).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AUTH_LOST_EVENT, listener);
    }
  });
});
