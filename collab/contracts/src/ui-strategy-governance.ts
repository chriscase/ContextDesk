import { createHash } from "node:crypto";
import {
  UI_STRATEGY_POLICY_SCHEMA_ID,
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  parseUiStrategyPolicy as parseUiStrategyPolicyStructure,
  parseUiStrategyPolicyInput,
  type UiStrategyGovernancePolicyInputV1,
  type UiStrategyGovernancePolicyV1,
  type UiStrategyInstanceRuleV1,
  type UiStrategyRoleRuleV1,
} from "./ui-strategy-governance-shared.js";

export * from "./ui-strategy-governance-shared.js";

function canonicalPolicy(input: {
  instance: UiStrategyInstanceRuleV1;
  roleRules: UiStrategyRoleRuleV1[];
}): string {
  return JSON.stringify({ instance: input.instance, roleRules: input.roleRules });
}

export function uiStrategyPolicyFingerprint(input: {
  instance: UiStrategyInstanceRuleV1;
  roleRules: UiStrategyRoleRuleV1[];
}): string {
  return `sha256:${createHash("sha256").update(canonicalPolicy(input), "utf8").digest("hex")}`;
}

export function parseUiStrategyGovernancePolicy(raw: unknown): UiStrategyGovernancePolicyV1 {
  const parsed = parseUiStrategyPolicyStructure(raw);
  if (uiStrategyPolicyFingerprint(parsed) !== parsed.fingerprint) {
    throw new Error("strategy policy fingerprint does not match its rules");
  }
  return parsed;
}

export function defaultUiStrategyPolicyInput(): UiStrategyGovernancePolicyInputV1 {
  const ids = ["war-room", "investigation-first", "keystone"] as const;
  return parseUiStrategyPolicyInput({
    schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
    expectedRevision: 0,
    instance: {
      enabledIds: ids,
      visibleIds: ids,
      defaultId: "war-room",
      selectionMode: "free",
      approvedIds: ids,
    },
    roleRules: [],
  });
}

export function createUiStrategyPolicy(
  input: UiStrategyGovernancePolicyInputV1,
  revision: number,
  updatedBy: string,
  updatedAt: string,
): UiStrategyGovernancePolicyV1 {
  const parsed = parseUiStrategyPolicyInput(input);
  const body = { instance: parsed.instance, roleRules: parsed.roleRules };
  return {
    schemaId: UI_STRATEGY_POLICY_SCHEMA_ID,
    revision,
    fingerprint: uiStrategyPolicyFingerprint(body),
    updatedAt,
    updatedBy,
    ...body,
  };
}
