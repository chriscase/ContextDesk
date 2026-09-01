import {
  UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
} from "@cd-collab/contracts";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { PgAuditStore, type AuditRecord, type StoredAudit } from "../audit/index.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { StrategyGovernanceService, StrategyPolicyStaleError } from "./service.js";
import { PgStrategyGovernanceStore } from "./store.js";

const policyUpdate = {
  schemaId: UI_STRATEGY_POLICY_UPDATE_SCHEMA_ID,
  expectedRevision: 0,
  instance: {
    enabledIds: ["war-room", "beacon"],
    visibleIds: ["war-room", "beacon"],
    defaultId: "war-room",
    selectionMode: "free",
    approvedIds: ["war-room", "beacon"],
  },
  roleRules: [],
} as const;

async function seedUser(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_profiles (id, username, display_name, status, provenance, directory_sync_status)
     VALUES ($1, $2, $2, 'active', 'local', 'not_synced')`,
    [id, id.replaceAll(":", "-")],
  );
}

describe.skipIf(!adminUrl())("PgStrategyGovernanceStore", () => {
  it("commits revision-CAS policy history, preference, and audit in one pool", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url });
      try {
        await seedUser(pool, "local:alice");
        const audit = new PgAuditStore(pool);
        const service = new StrategyGovernanceService({
          store: new PgStrategyGovernanceStore(pool),
          audit,
        });
        const [first, second] = await Promise.allSettled([
          service.updatePolicy(policyUpdate, "local:admin-a", "test"),
          service.updatePolicy(policyUpdate, "local:admin-b", "test"),
        ]);
        expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = [first, second].find((result) => result.status === "rejected");
        expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(StrategyPolicyStaleError);
        const policy = await service.loadPolicy();
        const effective = await service.updatePreference({
          schemaId: UI_STRATEGY_PREFERENCE_UPDATE_SCHEMA_ID,
          expectedPolicyRevision: policy.revision,
          expectedPreferenceRevision: 0,
          strategyId: "beacon",
        }, "local:alice", ["contributor"], "test");
        expect(effective.effectiveId).toBe("beacon");
        expect((await pool.query("SELECT revision FROM ui_strategy_policy_history")).rows).toHaveLength(1);
        expect((await pool.query("SELECT strategy_id FROM ui_strategy_preferences WHERE user_id = 'local:alice'")).rows[0]?.strategy_id).toBe("beacon");
        expect(await audit.list({ identity: "local:alice" })).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });
  });

  it("rolls policy and history back when same-pool audit confirmation fails", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url });
      class FailingAuditStore extends PgAuditStore {
        override async append(_record: AuditRecord): Promise<StoredAudit> {
          throw new Error("injected PostgreSQL audit failure");
        }
      }
      try {
        const service = new StrategyGovernanceService({
          store: new PgStrategyGovernanceStore(pool),
          audit: new FailingAuditStore(pool),
        });
        await expect(service.updatePolicy(policyUpdate, "local:admin", "test"))
          .rejects.toThrow(/injected PostgreSQL audit failure/u);
        expect((await pool.query("SELECT * FROM ui_strategy_policy_state")).rows).toHaveLength(0);
        expect((await pool.query("SELECT * FROM ui_strategy_policy_history")).rows).toHaveLength(0);
        expect((await pool.query("SELECT * FROM audit_events")).rows).toHaveLength(0);
      } finally {
        await pool.end();
      }
    });
  });

  it("fails closed when a persisted PostgreSQL policy fingerprint is corrupted", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url });
      try {
        const service = new StrategyGovernanceService({
          store: new PgStrategyGovernanceStore(pool),
          audit: new PgAuditStore(pool),
        });
        await service.updatePolicy(policyUpdate, "local:admin", "test");
        await pool.query(
          `UPDATE ui_strategy_policy_state
           SET policy = jsonb_set(policy, '{fingerprint}', to_jsonb($1::text))`,
          [`sha256:${"0".repeat(64)}`],
        );
        await expect(service.loadPolicy()).rejects.toThrow(/fingerprint/u);
        await expect(service.effective("local:alice", ["contributor"]))
          .rejects.toThrow(/fingerprint/u);
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses an audit store bound to a different pool", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url });
      const other = new Pool({ connectionString: url });
      try {
        const service = new StrategyGovernanceService({
          store: new PgStrategyGovernanceStore(pool),
          audit: new PgAuditStore(other),
        });
        await expect(service.updatePolicy(policyUpdate, "local:admin", "test"))
          .rejects.toThrow(/must share one pool/u);
      } finally {
        await Promise.all([pool.end(), other.end()]);
      }
    });
  });
});
