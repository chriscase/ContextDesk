import {
  APP_ROLES,
  UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
  createUiStrategyPolicy,
  defaultUiStrategyPolicyInput,
  parseUiStrategyPolicyInput,
  type AppRole,
  type UiStrategyEffectiveV1,
  type UiStrategyGovernancePolicyInputV1,
  type UiStrategyGovernancePolicyV1,
  type UiStrategyPreferenceUpdateV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { StrategyGovernanceStore, UiStrategyPreferenceRecord } from "./store.js";

export class StrategyPolicyStaleError extends Error {}
export class StrategyPreferenceStaleError extends Error {}
export class StrategyPolicyDisallowedError extends Error {}

const ROLE_RANK: Record<AppRole, number> = { viewer: 1, contributor: 2, "case-lead": 3, admin: 4 };

function highestRole(roles: readonly AppRole[]): AppRole | null {
  return [...roles].sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ?? null;
}

function defaultPolicy(): UiStrategyGovernancePolicyV1 {
  return createUiStrategyPolicy(
    defaultUiStrategyPolicyInput(),
    0,
    "system-default",
    "1970-01-01T00:00:00.000Z",
  );
}

export class StrategyGovernanceService {
  constructor(private readonly deps: { store: StrategyGovernanceStore; audit: AuditStore }) {}

  async loadPolicy(): Promise<UiStrategyGovernancePolicyV1> {
    return await this.deps.store.loadPolicy() ?? defaultPolicy();
  }

  private resolve(
    policy: UiStrategyGovernancePolicyV1,
    preference: UiStrategyPreferenceRecord | null,
    roles: readonly AppRole[],
  ): UiStrategyEffectiveV1 {
    const role = highestRole(roles);
    const roleRule = policy.instance.selectionMode === "approved_subset" && role
      ? policy.roleRules.find((candidate) => candidate.role === role)
      : undefined;
    const selectableIds = policy.instance.selectionMode === "free"
      ? policy.instance.visibleIds
      : roleRule?.approvedIds ?? policy.instance.approvedIds;
    const roleDefault = roleRule?.defaultId;
    const defaultId = roleDefault && policy.instance.enabledIds.includes(roleDefault)
      ? roleDefault
      : policy.instance.defaultId;
    if (preference && selectableIds.includes(preference.strategyId)) {
      return {
        schemaId: UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
        policyRevision: policy.revision,
        preferenceRevision: preference.revision,
        preferredId: preference.strategyId,
        effectiveId: preference.strategyId,
        defaultId,
        enabledIds: policy.instance.enabledIds,
        selectableIds,
        canSelect: selectableIds.length > 0,
        source: "user",
      };
    }
    const effectiveId = policy.instance.enabledIds.includes(defaultId) ? defaultId : "war-room";
    return {
      schemaId: UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
      policyRevision: policy.revision,
      preferenceRevision: preference?.revision ?? 0,
      preferredId: preference?.strategyId ?? null,
      effectiveId,
      defaultId,
      enabledIds: policy.instance.enabledIds,
      selectableIds,
      canSelect: selectableIds.length > 0,
      source: roleDefault ? "role_default" : effectiveId === "war-room" && defaultId !== "war-room"
        ? "safe_reference" : "instance_default",
    };
  }

  async effective(userId: string, roles: readonly AppRole[]): Promise<UiStrategyEffectiveV1> {
    return this.deps.store.withAtomic(async () => {
      await this.deps.store.lockPolicy();
      const policy = await this.loadPolicy();
      const preference = await this.deps.store.loadPreference(userId);
      return this.resolve(policy, preference, roles);
    });
  }

  async updatePolicy(
    input: UiStrategyGovernancePolicyInputV1,
    actorId: string,
    origin: string,
  ): Promise<UiStrategyGovernancePolicyV1> {
    const parsed = parseUiStrategyPolicyInput(input);
    return this.deps.store.withAtomic(async () => {
      await this.deps.store.lockPolicy();
      const current = await this.loadPolicy();
      if (current.revision !== parsed.expectedRevision) throw new StrategyPolicyStaleError();
      const next = createUiStrategyPolicy(parsed, current.revision + 1, actorId, new Date().toISOString());
      if (!await this.deps.store.savePolicy(next, current.revision)) throw new StrategyPolicyStaleError();
      await this.deps.audit.append({
        identity: actorId, action: "ui_strategy_policy_update",
        target: `revision:${next.revision}`, origin, outcome: "success",
      });
      return next;
    }, this.deps.audit);
  }

  async updatePreference(
    input: UiStrategyPreferenceUpdateV1,
    userId: string,
    roles: readonly AppRole[],
    origin: string,
  ): Promise<UiStrategyEffectiveV1> {
    return this.deps.store.withAtomic(async () => {
      await this.deps.store.lockPolicy();
      const policy = await this.loadPolicy();
      if (policy.revision !== input.expectedPolicyRevision) throw new StrategyPolicyStaleError();
      const current = await this.deps.store.loadPreference(userId);
      if ((current?.revision ?? 0) !== input.expectedPreferenceRevision) throw new StrategyPreferenceStaleError();
      const before = this.resolve(policy, current, roles);
      if (!before.selectableIds.includes(input.strategyId)) throw new StrategyPolicyDisallowedError();
      const next: UiStrategyPreferenceRecord = {
        userId,
        strategyId: input.strategyId,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      if (!await this.deps.store.savePreference(next, current?.revision ?? 0)) {
        throw new StrategyPreferenceStaleError();
      }
      await this.deps.audit.append({
        identity: userId, action: "ui_strategy_preference_update",
        target: `strategy:${input.strategyId}`, origin, outcome: "success",
      });
      return this.resolve(policy, next, roles);
    }, this.deps.audit);
  }
}

export const STRATEGY_ROLE_PRECEDENCE = Object.freeze([...APP_ROLES].sort(
  (left, right) => ROLE_RANK[right] - ROLE_RANK[left],
));
