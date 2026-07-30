import { describe, expect, it } from "vitest";
import {
  formatPolicyBindingStatus,
  formatSuppressionResolution,
  MADE_UNDER_DIFFERENT_NOISE_POLICY,
  policyBindingBlocksApply,
  ruleContributesToExclusion,
} from "./policyBinding";

describe("policyBinding helpers (#819)", () => {
  it("uses the exact product label for different noise policy", () => {
    expect(formatPolicyBindingStatus("made_under_different_policy")).toBe(
      MADE_UNDER_DIFFERENT_NOISE_POLICY,
    );
    expect(MADE_UNDER_DIFFERENT_NOISE_POLICY).toBe(
      "Made under a different noise policy",
    );
  });

  it("blocks Apply for every non-current policy status", () => {
    expect(policyBindingBlocksApply("current")).toBe(false);
    expect(policyBindingBlocksApply("made_under_different_policy")).toBe(true);
    expect(policyBindingBlocksApply("made_under_different_lens")).toBe(true);
    expect(policyBindingBlocksApply("unbound_legacy")).toBe(true);
    expect(policyBindingBlocksApply("current_lens_unknown")).toBe(true);
    expect(policyBindingBlocksApply(null)).toBe(true);
  });

  it("only enabled matches_current rules contribute to exclusion", () => {
    expect(
      ruleContributesToExclusion("enabled", {
        kind: "matches_current",
        matchesNothing: false,
        explanation: "ok",
      }),
    ).toBe(true);
    expect(
      ruleContributesToExclusion("enabled", {
        kind: "stale_target_missing",
        matchesNothing: true,
        explanation: "gone",
      }),
    ).toBe(false);
    expect(
      ruleContributesToExclusion("disabled", {
        kind: "matches_current",
        matchesNothing: false,
        explanation: "ok",
      }),
    ).toBe(false);
    expect(
      formatSuppressionResolution(
        {
          kind: "stale_fingerprint_changed",
          matchesNothing: true,
          explanation: "changed",
        },
        "enabled",
      ),
    ).toMatch(/Stale — matches nothing/);
  });
});
