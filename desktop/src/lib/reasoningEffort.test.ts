import { describe, expect, it } from "vitest";
import {
  effortPolicyHint,
  levelFromDto,
  levelToSavePayload,
  REASONING_EFFORT_OPTIONS,
} from "./reasoningEffort";

describe("reasoningEffort helpers", () => {
  it("maps omit and levels without inventing readiness language", () => {
    expect(levelFromDto("omit", null)).toBe("omit");
    expect(levelFromDto("explicit", "high")).toBe("high");
    expect(() => levelFromDto("explicit", "future-level")).toThrow(
      /unsupported/i,
    );
    expect(() => levelFromDto("explicit", null)).toThrow(/malformed/i);
    expect(() => levelFromDto("unknown", null)).toThrow(/malformed/i);
    expect(levelToSavePayload("omit")).toBeNull();
    expect(levelToSavePayload("medium")).toBe("medium");
    expect(effortPolicyHint("omit")).toMatch(/not a readiness badge/i);
    expect(effortPolicyHint("high")).toMatch(/cost and latency/i);
    expect(effortPolicyHint("high")).toMatch(/model and gateway support/i);
    expect(REASONING_EFFORT_OPTIONS.map((o) => o.value)).toEqual([
      "omit",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
