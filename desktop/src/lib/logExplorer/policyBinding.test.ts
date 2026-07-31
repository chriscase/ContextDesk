import { describe, expect, it } from "vitest";
import type { SuppressionRuleResolutionDto } from "../host";
import {
  formatPolicyBindingStatus,
  formatSuppressionResolution,
  MADE_UNDER_DIFFERENT_NOISE_POLICY,
  policyBindingBlocksApply,
  policyBindingIsRetryableVerification,
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
    ).toMatch(/Stale — template changed/);
  });

  it("uses the design-contract resolution labels (#819)", () => {
    const label = (kind: SuppressionRuleResolutionDto["kind"]): string =>
      formatSuppressionResolution(
        { kind, matchesNothing: kind !== "matches_current", explanation: "" },
        "enabled",
      );
    expect(label("stale_target_missing")).toBe("Stale — matches nothing");
    expect(label("stale_fingerprint_changed")).toBe("Stale — template changed");
    expect(label("invalid_predicate")).toBe("Invalid — cannot be applied");
    expect(label("conflicting_predicate")).toBe("Conflicts with another rule");
  });

  it("treats current_lens_unknown as retryable verification, not a finding property", () => {
    expect(policyBindingIsRetryableVerification("current_lens_unknown")).toBe(
      true,
    );
    // Apply still blocked, but the remedy is retry — never recompute.
    expect(policyBindingBlocksApply("current_lens_unknown")).toBe(true);
    expect(formatPolicyBindingStatus("current_lens_unknown")).toBe(
      "Noise policy not verified — retry",
    );
    for (const status of [
      "current",
      "made_under_different_policy",
      "made_under_different_lens",
      "unbound_legacy",
    ] as const) {
      expect(policyBindingIsRetryableVerification(status)).toBe(false);
    }
  });

  it("every non-current resolution excludes zero events", () => {
    for (const kind of [
      "stale_target_missing",
      "stale_fingerprint_changed",
      "invalid_predicate",
      "conflicting_predicate",
      "inactive",
    ] as const) {
      expect(
        ruleContributesToExclusion("enabled", {
          kind,
          matchesNothing: true,
          explanation: "",
        }),
      ).toBe(false);
    }
    // A forged matchesNothing=false on a non-matching kind still excludes zero.
    expect(
      ruleContributesToExclusion("enabled", {
        kind: "stale_target_missing",
        matchesNothing: false,
        explanation: "forged",
      }),
    ).toBe(false);
  });
});
