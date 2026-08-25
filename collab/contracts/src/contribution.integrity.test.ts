import { describe, expect, it } from "vitest";
import { isContributionIdempotencyKey } from "./contribution.js";

describe("contribution write tokens", () => {
  it("accepts bounded retry keys and rejects unverifiable tokens", () => {
    expect(isContributionIdempotencyKey("msg-syn-0001")).toBe(true);
    expect(isContributionIdempotencyKey("a".repeat(8))).toBe(true);
    expect(isContributionIdempotencyKey("short")).toBe(false);
    expect(isContributionIdempotencyKey("<script>alert(1)</script>")).toBe(false);
    expect(isContributionIdempotencyKey("")).toBe(false);
  });
});
