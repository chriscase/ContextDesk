import { describe, expect, it } from "vitest";
import { MemoryLocalGrantStore } from "./grants.js";

describe("MemoryLocalGrantStore", () => {
  it("grants a capability once and reports already_granted on repeat", async () => {
    const store = new MemoryLocalGrantStore();
    expect(await store.grant("local:alice", "admin:users", "local:root")).toBe("granted");
    expect(await store.grant("local:alice", "admin:users", "local:root")).toBe("already_granted");
    const grants = await store.list("local:alice");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.capability).toBe("admin:users");
    expect(grants[0]?.grantedBy).toBe("local:root");
  });

  it("revoke is idempotent and reports not_granted on repeat", async () => {
    const store = new MemoryLocalGrantStore();
    await store.grant("local:bob", "audit:view", "local:root");
    expect(await store.revoke("local:bob", "audit:view")).toBe("revoked");
    expect(await store.revoke("local:bob", "audit:view")).toBe("not_granted");
    expect(await store.list("local:bob")).toEqual([]);
  });

  it("lists grants for a user sorted by capability", async () => {
    const store = new MemoryLocalGrantStore();
    await store.grant("local:carol", "export:create", "local:root");
    await store.grant("local:carol", "admin:users", "local:root");
    const grants = await store.list("local:carol");
    expect(grants.map((g) => g.capability)).toEqual(["admin:users", "export:create"]);
  });

  it("returns an empty list for a user with no grants", async () => {
    const store = new MemoryLocalGrantStore();
    expect(await store.list("local:nobody")).toEqual([]);
  });

  it("round-trips through capture/restore for the SQLite persistence wrapper", async () => {
    const store = new MemoryLocalGrantStore();
    await store.grant("local:dave", "run:strategies", "local:root");
    const snapshot = store.capture();

    const restored = new MemoryLocalGrantStore();
    restored.restore(snapshot);
    expect(await restored.list("local:dave")).toEqual([
      { capability: "run:strategies", grantedBy: "local:root", grantedAt: expect.any(String) },
    ]);
  });
});
