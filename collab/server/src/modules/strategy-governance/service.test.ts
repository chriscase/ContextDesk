import {
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
  type UiStrategyGovernancePolicyInputV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { MemoryAuditStore } from "../audit/index.js";
import {
  StrategyGovernanceService,
  StrategyPolicyDisallowedError,
  StrategyPolicyStaleError,
  StrategyPreferenceStaleError,
} from "./service.js";
import { MemoryStrategyGovernanceStore } from "./store.js";

function enabledBeacon(expectedRevision: number): UiStrategyGovernancePolicyInputV1 {
  return {
    schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
    expectedRevision,
    instance: {
      enabledIds: ["war-room", "investigation-first", "keystone", "beacon"],
      visibleIds: ["war-room", "investigation-first", "keystone", "beacon"],
      defaultId: "beacon",
      selectionMode: "approved_subset",
      approvedIds: ["war-room", "investigation-first"],
    },
    roleRules: [
      { role: "viewer", approvedIds: ["war-room"], defaultId: "war-room" },
      { role: "admin", approvedIds: ["war-room", "beacon"], defaultId: "beacon" },
    ],
  };
}

describe("StrategyGovernanceService", () => {
  it("rejects malformed direct preference callers before a store mutation", async () => {
    const store = new MemoryStrategyGovernanceStore();
    const audit = new MemoryAuditStore();
    const service = new StrategyGovernanceService({ store, audit });
    await expect(service.updatePreference({
      schemaId: "cd-collab.ui_strategy_preference_update.v1",
      expectedPolicyRevision: 0,
      expectedPreferenceRevision: 0,
      strategyId: "unknown-strategy",
    } as never, "local:alice", ["contributor"], "test")).rejects.toThrow();
    expect(await store.loadPreference("local:alice")).toBeNull();
    expect(await audit.list({ action: "ui_strategy_preference_update" })).toEqual([]);
  });

  it("starts fail-closed with Beacon hidden and no durable preference", async () => {
    const service = new StrategyGovernanceService({
      store: new MemoryStrategyGovernanceStore(),
      audit: new MemoryAuditStore(),
    });
    const effective = await service.effective("local:alice", ["contributor"]);
    expect(effective).toMatchObject({
      policyRevision: 0,
      preferenceRevision: 0,
      preferredId: null,
      effectiveId: "war-room",
      source: "instance_default",
    });
    expect(effective.enabledIds).not.toContain("beacon");
  });

  it("uses the highest group-derived role and persists an eligible personal choice", async () => {
    const audit = new MemoryAuditStore();
    const service = new StrategyGovernanceService({
      store: new MemoryStrategyGovernanceStore(),
      audit,
    });
    const policy = await service.updatePolicy(enabledBeacon(0), "local:admin", "127.0.0.1");
    const before = await service.effective("local:alice", ["viewer", "admin"]);
    expect(before).toMatchObject({ effectiveId: "beacon", source: "role_default" });
    expect(before.selectableIds).toEqual(["war-room", "beacon"]);

    const chosen = await service.updatePreference({
      schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
      expectedPolicyRevision: policy.revision,
      expectedPreferenceRevision: 0,
      strategyId: "war-room",
    }, "local:alice", ["viewer", "admin"], "127.0.0.1");
    expect(chosen).toMatchObject({
      preferenceRevision: 1,
      preferredId: "war-room",
      effectiveId: "war-room",
      source: "user",
    });
    expect((await audit.list()).map((row) => row.action)).toEqual([
      "ui_strategy_policy_update",
      "ui_strategy_preference_update",
    ]);
  });

  it("rejects stale policy/preferences and disallowed choices without changing state", async () => {
    const store = new MemoryStrategyGovernanceStore();
    const service = new StrategyGovernanceService({ store, audit: new MemoryAuditStore() });
    const policy = await service.updatePolicy(enabledBeacon(0), "local:admin", "local");
    await expect(service.updatePolicy(enabledBeacon(0), "local:admin", "local"))
      .rejects.toBeInstanceOf(StrategyPolicyStaleError);
    await expect(service.updatePreference({
      schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
      expectedPolicyRevision: policy.revision,
      expectedPreferenceRevision: 0,
      strategyId: "beacon",
    }, "local:viewer", ["viewer"], "local")).rejects.toBeInstanceOf(StrategyPolicyDisallowedError);

    await service.updatePreference({
      schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
      expectedPolicyRevision: policy.revision,
      expectedPreferenceRevision: 0,
      strategyId: "war-room",
    }, "local:viewer", ["viewer"], "local");
    await expect(service.updatePreference({
      schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
      expectedPolicyRevision: policy.revision,
      expectedPreferenceRevision: 0,
      strategyId: "war-room",
    }, "local:viewer", ["viewer"], "local")).rejects.toBeInstanceOf(StrategyPreferenceStaleError);
    expect((await store.loadPreference("local:viewer"))?.revision).toBe(1);
  });

  it("rolls a policy mutation back when its success audit cannot be stored", async () => {
    class FailingAudit extends MemoryAuditStore {
      override async append(): Promise<never> { throw new Error("audit unavailable"); }
    }
    const store = new MemoryStrategyGovernanceStore();
    const service = new StrategyGovernanceService({ store, audit: new FailingAudit() });
    await expect(service.updatePolicy(enabledBeacon(0), "local:admin", "local"))
      .rejects.toThrow("audit unavailable");
    expect(await store.loadPolicy()).toBeNull();
  });

  it("serializes competing policy updates so exactly one revision wins", async () => {
    const store = new MemoryStrategyGovernanceStore();
    const service = new StrategyGovernanceService({ store, audit: new MemoryAuditStore() });
    const results = await Promise.allSettled([
      service.updatePolicy(enabledBeacon(0), "local:admin-a", "local"),
      service.updatePolicy(enabledBeacon(0), "local:admin-b", "local"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await store.loadPolicy())?.revision).toBe(1);
  });

  it("rolls a preference mutation back when its success audit cannot be stored", async () => {
    class FailingPreferenceAudit extends MemoryAuditStore {
      override async append(record: Parameters<MemoryAuditStore["append"]>[0]) {
        if (record.action === "ui_strategy_preference_update") throw new Error("audit unavailable");
        return super.append(record);
      }
    }
    const store = new MemoryStrategyGovernanceStore();
    const service = new StrategyGovernanceService({ store, audit: new FailingPreferenceAudit() });
    const policy = await service.updatePolicy(enabledBeacon(0), "local:admin", "local");
    await expect(service.updatePreference({
      schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
      expectedPolicyRevision: policy.revision,
      expectedPreferenceRevision: 0,
      strategyId: "war-room",
    }, "local:alice", ["admin"], "local")).rejects.toThrow("audit unavailable");
    expect(await store.loadPreference("local:alice")).toBeNull();
  });
});
