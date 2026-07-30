/**
 * Pure display helpers for #819 policy-bound findings and fail-closed rules.
 * Labels and Apply/recompute decisions stay on host-authored statuses only.
 */

import type {
  InvestigationPolicyBindingStatus,
  SuppressionRuleResolutionDto,
  SuppressionRuleState,
} from "../host";

/** Exact product label required by #819 for policy mismatch. */
export const MADE_UNDER_DIFFERENT_NOISE_POLICY =
  "Made under a different noise policy";

export function formatPolicyBindingStatus(
  status: InvestigationPolicyBindingStatus | null | undefined,
): string {
  switch (status) {
    case "current":
      return "Current noise policy";
    case "made_under_different_policy":
      return MADE_UNDER_DIFFERENT_NOISE_POLICY;
    case "made_under_different_lens":
      return "Made under a different noise lens";
    case "current_lens_unknown":
      return "Noise lens not supplied for comparison";
    case "unbound_legacy":
      return "Legacy finding · no noise-policy binding";
    default:
      return "Noise policy relationship unknown";
  }
}

/** Apply is blocked when the saved view is not under the current policy+lens. */
export function policyBindingBlocksApply(
  status: InvestigationPolicyBindingStatus | null | undefined,
): boolean {
  return status !== "current";
}

export function formatSuppressionResolution(
  resolution: SuppressionRuleResolutionDto | null | undefined,
  state: SuppressionRuleState,
): string {
  if (state === "disabled") return "Disabled · excludes nothing";
  if (state === "removed") return "Removed · excludes nothing";
  if (!resolution) return "Unresolved · reload policy before applying";
  switch (resolution.kind) {
    case "matches_current":
      return "Matches current · can exclude events";
    case "stale_target_missing":
      return "Stale — matches nothing (target missing)";
    case "stale_fingerprint_changed":
      return "Stale — matches nothing (fingerprint changed)";
    case "invalid_predicate":
      return "Invalid predicate · excludes nothing";
    case "conflicting_predicate":
      return "Conflicting predicate · excludes nothing";
    case "inactive":
      return "Inactive · excludes nothing";
    default:
      return resolution.explanation || "Excludes nothing";
  }
}

/** Only enabled + matches_current can hide events (mirrors trusted-core lens). */
export function ruleContributesToExclusion(
  state: SuppressionRuleState,
  resolution: SuppressionRuleResolutionDto | null | undefined,
): boolean {
  return (
    state === "enabled" &&
    resolution?.kind === "matches_current" &&
    resolution.matchesNothing === false
  );
}
