/** Attributed contributions: message, note, hypothesis, action, upload. */
export const MODULE_ID = "contributions" as const;

export {
  CONTRIBUTION_KINDS,
  assertSupportedLinks,
  defaultPrivacy,
  hashContributionContent,
  isContributionKind,
} from "./model.js";
export type { ContributionKind } from "./model.js";
