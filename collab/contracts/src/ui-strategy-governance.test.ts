import { describe, expect, it } from "vitest";
import {
  UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  createUiStrategyPolicy,
  defaultUiStrategyPolicyInput,
  parseUiStrategyEffective,
  parseUiStrategyGovernancePolicy,
  parseUiStrategyPolicyInput,
} from "./ui-strategy-governance.js";

describe("UI strategy governance contracts", () => {
  it("creates a deterministic, self-verifying default policy with Beacon hidden", () => {
    const input = defaultUiStrategyPolicyInput();
    const policy = createUiStrategyPolicy(input, 1, "system-default", "1970-01-01T00:00:00.000Z");
    expect(parseUiStrategyGovernancePolicy(policy)).toEqual(policy);
    expect(policy.instance.enabledIds).not.toContain("beacon");
    expect(policy.instance.enabledIds).toContain("war-room");
    expect(() => parseUiStrategyGovernancePolicy({ ...policy, fingerprint: `sha256:${"0".repeat(64)}` }))
      .toThrow(/fingerprint/);
  });

  it("rejects scope rules that remove the reference strategy or escape enabled IDs", () => {
    const base = defaultUiStrategyPolicyInput();
    expect(() => parseUiStrategyPolicyInput({
      ...base,
      schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
      instance: { ...base.instance, enabledIds: ["keystone"], visibleIds: ["keystone"], approvedIds: ["keystone"], defaultId: "keystone" },
    })).toThrow(/War Room/);
    expect(() => parseUiStrategyPolicyInput({
      ...base,
      instance: { ...base.instance, visibleIds: [...base.instance.visibleIds, "beacon"], approvedIds: [...base.instance.approvedIds, "beacon"] },
    })).toThrow(/visibleIds must be enabled/);
  });

  it("normalizes role rules and validates effective policy responses", () => {
    const base = defaultUiStrategyPolicyInput();
    const parsed = parseUiStrategyPolicyInput({
      ...base,
      instance: { ...base.instance, selectionMode: "approved_subset" },
      roleRules: [{ role: "viewer", approvedIds: ["war-room"], defaultId: "war-room" }],
    });
    expect(parsed.roleRules[0]?.role).toBe("viewer");
    expect(() => parseUiStrategyPolicyInput({
      ...base,
      roleRules: [
        { role: "viewer", approvedIds: ["war-room"], defaultId: "war-room" },
        { role: "viewer", approvedIds: ["war-room"], defaultId: "war-room" },
      ],
    })).toThrow(/role is duplicated/);

    expect(parseUiStrategyEffective({
      schemaId: UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
      policyRevision: 2,
      preferenceRevision: 3,
      preferredId: "keystone",
      effectiveId: "keystone",
      defaultId: "war-room",
      enabledIds: ["war-room", "keystone"],
      selectableIds: ["war-room", "keystone"],
      canSelect: true,
      source: "user",
    }).effectiveId).toBe("keystone");
  });

  it("rejects incoherent effective preference and source metadata", () => {
    const valid = {
      schemaId: UI_STRATEGY_EFFECTIVE_SCHEMA_ID,
      policyRevision: 2,
      preferenceRevision: 3,
      preferredId: "keystone" as const,
      effectiveId: "keystone" as const,
      defaultId: "war-room" as const,
      enabledIds: ["war-room", "keystone"] as const,
      selectableIds: ["war-room", "keystone"] as const,
      canSelect: true,
      source: "user" as const,
    };

    expect(() => parseUiStrategyEffective({ ...valid, preferenceRevision: 0 }))
      .toThrow(/preferredId and preferenceRevision/);
    expect(() => parseUiStrategyEffective({ ...valid, preferredId: null }))
      .toThrow(/preferredId and preferenceRevision/);
    expect(() => parseUiStrategyEffective({ ...valid, selectableIds: ["war-room"] }))
      .toThrow(/user-selected effective strategy must be selectable/);
    expect(() => parseUiStrategyEffective({
      ...valid,
      source: "instance_default",
      preferredId: null,
      preferenceRevision: 0,
    })).toThrow(/policy-selected effective strategy must match/);
    expect(() => parseUiStrategyEffective({
      ...valid,
      source: "safe_reference",
      preferredId: null,
      preferenceRevision: 0,
    })).toThrow(/safe reference strategy must be War Room/);

    expect(parseUiStrategyEffective({
      ...valid,
      source: "instance_default",
      preferredId: "keystone",
      preferenceRevision: 3,
      effectiveId: "war-room",
    }).preferredId).toBe("keystone");
  });
});
