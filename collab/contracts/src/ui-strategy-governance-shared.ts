import { APP_ROLES, type AppRole } from "./auth.js";
import { checkObject, f, type ObjectShape } from "./parse.js";

export const UI_STRATEGY_POLICY_SCHEMA_ID = "cd-collab.ui_strategy_policy.v1" as const;
export const UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID = "cd-collab.ui_strategy_policy_update.v1" as const;
export const UI_STRATEGY_EFFECTIVE_SCHEMA_ID = "cd-collab.ui_strategy_effective.v1" as const;
export const UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID = "cd-collab.ui_strategy_preference_update.v1" as const;
export const UI_STRATEGY_ERROR_SCHEMA_ID = "cd-collab.ui_strategy_error.v1" as const;

/** Closed vocabulary shared by server policy and this build's UI registry. */
export const UI_STRATEGY_IDS = ["war-room", "investigation-first", "keystone", "beacon"] as const;
export type UiStrategyId = (typeof UI_STRATEGY_IDS)[number];

export const UI_STRATEGY_SELECTION_MODES = ["free", "approved_subset"] as const;
export type UiStrategySelectionMode = (typeof UI_STRATEGY_SELECTION_MODES)[number];
export const UI_STRATEGY_EFFECTIVE_SOURCES = [
  "user", "role_default", "instance_default", "safe_reference",
] as const;
export type UiStrategyEffectiveSource = (typeof UI_STRATEGY_EFFECTIVE_SOURCES)[number];

export interface UiStrategyInstanceRuleV1 {
  enabledIds: UiStrategyId[];
  visibleIds: UiStrategyId[];
  defaultId: UiStrategyId;
  selectionMode: UiStrategySelectionMode;
  /** Used in approved_subset mode; an empty set creates a fixed default. */
  approvedIds: UiStrategyId[];
}

export interface UiStrategyRoleRuleV1 {
  role: AppRole;
  approvedIds: UiStrategyId[];
  defaultId: UiStrategyId | null;
}

export interface UiStrategyGovernancePolicyInputV1 {
  schemaId: typeof UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID;
  expectedRevision: number;
  instance: UiStrategyInstanceRuleV1;
  /** Group-derived roles only. Raw directory groups never enter self responses. */
  roleRules: UiStrategyRoleRuleV1[];
}

export interface UiStrategyGovernancePolicyV1 {
  schemaId: typeof UI_STRATEGY_POLICY_SCHEMA_ID;
  revision: number;
  fingerprint: string;
  updatedAt: string;
  updatedBy: string;
  instance: UiStrategyInstanceRuleV1;
  roleRules: UiStrategyRoleRuleV1[];
}

export interface UiStrategyEffectiveV1 {
  schemaId: typeof UI_STRATEGY_EFFECTIVE_SCHEMA_ID;
  policyRevision: number;
  preferenceRevision: number;
  preferredId: UiStrategyId | null;
  effectiveId: UiStrategyId;
  defaultId: UiStrategyId;
  enabledIds: UiStrategyId[];
  selectableIds: UiStrategyId[];
  canSelect: boolean;
  source: UiStrategyEffectiveSource;
}

export interface UiStrategyPreferenceUpdateV1 {
  schemaId: typeof UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID;
  expectedPolicyRevision: number;
  expectedPreferenceRevision: number;
  strategyId: UiStrategyId;
}

export const UI_STRATEGY_ERROR_CODES = [
  "invalid_request", "forbidden", "disallowed_strategy", "stale_policy",
  "stale_preference", "unavailable",
] as const;
export type UiStrategyErrorCode = (typeof UI_STRATEGY_ERROR_CODES)[number];
export interface UiStrategyErrorV1 {
  schemaId: typeof UI_STRATEGY_ERROR_SCHEMA_ID;
  error: UiStrategyErrorCode;
}

const instanceShape: ObjectShape = {
  enabledIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))),
  visibleIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))),
  defaultId: f.req(f.en(...UI_STRATEGY_IDS)),
  selectionMode: f.req(f.en(...UI_STRATEGY_SELECTION_MODES)),
  approvedIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))),
};
const roleRuleShape: ObjectShape = {
  role: f.req(f.en(...APP_ROLES)),
  approvedIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))),
  defaultId: f.nul(f.en(...UI_STRATEGY_IDS)),
};
const policyInputShape: ObjectShape = {
  schemaId: f.req(f.en(UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  instance: f.req(f.obj(instanceShape)),
  roleRules: f.req(f.arr(f.obj(roleRuleShape))),
};
const policyShape: ObjectShape = {
  schemaId: f.req(f.en(UI_STRATEGY_POLICY_SCHEMA_ID)), revision: f.req(f.u64),
  fingerprint: f.req(f.nstr), updatedAt: f.req(f.nstr), updatedBy: f.req(f.nstr),
  instance: f.req(f.obj(instanceShape)), roleRules: f.req(f.arr(f.obj(roleRuleShape))),
};
const effectiveShape: ObjectShape = {
  schemaId: f.req(f.en(UI_STRATEGY_EFFECTIVE_SCHEMA_ID)), policyRevision: f.req(f.u64),
  preferenceRevision: f.req(f.u64), preferredId: f.nul(f.en(...UI_STRATEGY_IDS)),
  effectiveId: f.req(f.en(...UI_STRATEGY_IDS)), defaultId: f.req(f.en(...UI_STRATEGY_IDS)),
  enabledIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))),
  selectableIds: f.req(f.arr(f.en(...UI_STRATEGY_IDS))), canSelect: f.req(f.bool),
  source: f.req(f.en(...UI_STRATEGY_EFFECTIVE_SOURCES)),
};
const preferenceShape: ObjectShape = {
  schemaId: f.req(f.en(UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID)),
  expectedPolicyRevision: f.req(f.u64), expectedPreferenceRevision: f.req(f.u64),
  strategyId: f.req(f.en(...UI_STRATEGY_IDS)),
};
const errorShape: ObjectShape = {
  schemaId: f.req(f.en(UI_STRATEGY_ERROR_SCHEMA_ID)),
  error: f.req(f.en(...UI_STRATEGY_ERROR_CODES)),
};

function canonicalIds(path: string, ids: readonly UiStrategyId[], allowEmpty = false): UiStrategyId[] {
  if (!allowEmpty && ids.length === 0) throw new Error(`${path} must not be empty`);
  if (new Set(ids).size !== ids.length) throw new Error(`${path} must be unique`);
  return UI_STRATEGY_IDS.filter((id) => ids.includes(id));
}

function parseInstance(raw: unknown): UiStrategyInstanceRuleV1 {
  checkObject("$.instance", instanceShape, raw);
  const value = raw as UiStrategyInstanceRuleV1;
  const enabledIds = canonicalIds("$.instance.enabledIds", value.enabledIds);
  const visibleIds = canonicalIds("$.instance.visibleIds", value.visibleIds, true);
  const approvedIds = canonicalIds("$.instance.approvedIds", value.approvedIds, true);
  if (!enabledIds.includes("war-room")) throw new Error("$.instance.enabledIds must retain the War Room reference strategy");
  if (!enabledIds.includes(value.defaultId)) throw new Error("$.instance.defaultId must be enabled");
  if (visibleIds.some((id) => !enabledIds.includes(id))) throw new Error("$.instance.visibleIds must be enabled");
  if (approvedIds.some((id) => !visibleIds.includes(id))) throw new Error("$.instance.approvedIds must be visible and enabled");
  if (value.selectionMode === "free" && (
    approvedIds.length !== visibleIds.length || approvedIds.some((id) => !visibleIds.includes(id))
  )) throw new Error("$.instance.approvedIds must equal visibleIds when selection is free");
  return { enabledIds, visibleIds, defaultId: value.defaultId, selectionMode: value.selectionMode, approvedIds };
}

function parseRoleRules(raw: unknown, instance: UiStrategyInstanceRuleV1): UiStrategyRoleRuleV1[] {
  if (!Array.isArray(raw)) throw new Error("$.roleRules must be an array");
  const seen = new Set<AppRole>();
  const rules = raw.map((candidate, index) => {
    checkObject(`$.roleRules[${index}]`, roleRuleShape, candidate);
    const value = candidate as UiStrategyRoleRuleV1;
    if (seen.has(value.role)) throw new Error(`$.roleRules[${index}].role is duplicated`);
    seen.add(value.role);
    const approvedIds = canonicalIds(`$.roleRules[${index}].approvedIds`, value.approvedIds, true);
    if (approvedIds.some((id) => !instance.visibleIds.includes(id))) throw new Error(`$.roleRules[${index}].approvedIds must be instance-visible`);
    if (value.defaultId !== null && !instance.enabledIds.includes(value.defaultId)) throw new Error(`$.roleRules[${index}].defaultId must be instance-enabled`);
    return { role: value.role, approvedIds, defaultId: value.defaultId };
  });
  return APP_ROLES.flatMap((role) => {
    const rule = rules.find((candidate) => candidate.role === role);
    return rule ? [rule] : [];
  });
}

function parsePolicyBody(raw: unknown): Pick<UiStrategyGovernancePolicyV1, "instance" | "roleRules"> {
  const value = raw as { instance: unknown; roleRules: unknown };
  const instance = parseInstance(value.instance);
  return { instance, roleRules: parseRoleRules(value.roleRules, instance) };
}

export function parseUiStrategyPolicyInput(raw: unknown): UiStrategyGovernancePolicyInputV1 {
  checkObject("$", policyInputShape, raw);
  const value = raw as UiStrategyGovernancePolicyInputV1;
  return { schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID, expectedRevision: value.expectedRevision, ...parsePolicyBody(raw) };
}

/** Browser-safe structural parse. Server code additionally verifies the fingerprint. */
export function parseUiStrategyPolicy(raw: unknown): UiStrategyGovernancePolicyV1 {
  checkObject("$", policyShape, raw);
  const value = raw as UiStrategyGovernancePolicyV1;
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.fingerprint)) throw new Error("strategy policy fingerprint is invalid");
  return { schemaId: UI_STRATEGY_POLICY_SCHEMA_ID, revision: value.revision, fingerprint: value.fingerprint,
    updatedAt: value.updatedAt, updatedBy: value.updatedBy, ...parsePolicyBody(raw) };
}

export function parseUiStrategyEffective(raw: unknown): UiStrategyEffectiveV1 {
  checkObject("$", effectiveShape, raw);
  const value = raw as UiStrategyEffectiveV1;
  const enabledIds = canonicalIds("$.enabledIds", value.enabledIds);
  const selectableIds = canonicalIds("$.selectableIds", value.selectableIds, true);
  if (!enabledIds.includes(value.defaultId) || !enabledIds.includes(value.effectiveId)) throw new Error("effective/default strategy must be enabled");
  if (selectableIds.some((id) => !enabledIds.includes(id))) throw new Error("selectable strategies must be enabled");
  if (value.canSelect !== (selectableIds.length > 0)) throw new Error("canSelect must reflect whether selectable strategies exist");
  if ((value.preferredId === null) !== (value.preferenceRevision === 0)) {
    throw new Error("preferredId and preferenceRevision must describe the same durable preference");
  }
  if (value.source === "user") {
    if (value.preferredId !== value.effectiveId) throw new Error("a user-selected effective strategy must match the preference");
    if (!selectableIds.includes(value.effectiveId)) throw new Error("a user-selected effective strategy must be selectable");
  } else if (value.source !== "safe_reference" && value.effectiveId !== value.defaultId) {
    throw new Error("a policy-selected effective strategy must match the resolved default");
  }
  if (value.source === "safe_reference" && value.effectiveId !== "war-room") {
    throw new Error("the safe reference strategy must be War Room");
  }
  return { ...value, enabledIds, selectableIds };
}

export function parseUiStrategyPreferenceUpdate(raw: unknown): UiStrategyPreferenceUpdateV1 {
  checkObject("$", preferenceShape, raw);
  return { ...(raw as UiStrategyPreferenceUpdateV1) };
}
export function parseUiStrategyError(raw: unknown): UiStrategyErrorV1 {
  checkObject("$", errorShape, raw);
  return { ...(raw as UiStrategyErrorV1) };
}
