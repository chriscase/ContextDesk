import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryStrategyGovernanceStore,
  PgStrategyGovernanceStore,
  StrategyGovernanceCommitOutcomeUnknownError,
  type UiStrategyPreferenceRecord,
} from "./store.js";

function poolWithClient(client: Pick<PoolClient, "query" | "release">): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

describe("PgStrategyGovernanceStore transaction faults", () => {
  it("releases a checked-out client when BEGIN fails", async () => {
    const failure = new Error("begin failed");
    const client = {
      query: vi.fn(async () => { throw failure; }),
      release: vi.fn(),
    };
    const store = new PgStrategyGovernanceStore(poolWithClient(client as unknown as PoolClient));
    await expect(store.withAtomic(async () => "unreachable")).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("discards the client and reports unknown outcome when COMMIT fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "COMMIT") throw new Error("connection lost");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const store = new PgStrategyGovernanceStore(poolWithClient(client as unknown as PoolClient));
    await expect(store.withAtomic(async () => "written"))
      .rejects.toBeInstanceOf(StrategyGovernanceCommitOutcomeUnknownError);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("rejects malformed persisted PostgreSQL preference rows", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          user_id: "local:alice",
          strategy_id: "unknown-strategy",
          revision: 1,
          updated_at: new Date("2026-09-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      })),
    } as unknown as Pool;
    const store = new PgStrategyGovernanceStore(pool);
    await expect(store.loadPreference("local:alice")).rejects.toThrow(/strategyId is invalid/);
  });
});

describe("MemoryStrategyGovernanceStore preference validation", () => {
  const valid: UiStrategyPreferenceRecord = {
    userId: "local:alice",
    strategyId: "keystone",
    revision: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("rejects malformed preference writes without changing an existing record", async () => {
    const store = new MemoryStrategyGovernanceStore();
    await expect(store.savePreference(valid, 0)).resolves.toBe(true);
    await expect(store.savePreference({ ...valid, strategyId: "unknown" } as UiStrategyPreferenceRecord, 1))
      .rejects.toThrow(/strategyId is invalid/);
    await expect(store.savePreference({ ...valid, revision: 1.5 }, 1))
      .rejects.toThrow(/positive safe integer/);
    await expect(store.savePreference({ ...valid, sessionToken: "must-not-persist" } as UiStrategyPreferenceRecord, 1))
      .rejects.toThrow(/fields are invalid/);
    await expect(store.savePreference({ ...valid, updatedAt: "September 1, 2026" }, 1))
      .rejects.toThrow(/canonical ISO timestamp/);
    await expect(store.loadPreference(valid.userId)).resolves.toEqual(valid);
  });

  it("fails closed on malformed restored preference records before replacing state", async () => {
    const store = new MemoryStrategyGovernanceStore();
    await store.savePreference(valid, 0);
    expect(() => store.restore({
      policy: null,
      preferences: [["local:mallory", { ...valid, userId: "local:alice" }]],
    })).toThrow(/key must match userId/);
    await expect(store.loadPreference(valid.userId)).resolves.toEqual(valid);
    await expect(store.loadPreference("local:mallory")).resolves.toBeNull();
  });
});
