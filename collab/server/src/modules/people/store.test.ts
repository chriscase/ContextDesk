import { describe, expect, it } from "vitest";
import {
  assertFieldUpdateContract,
  assertListContract,
  assertLoginSyncContract,
} from "./store.contract-tests.js";
import { MemoryUserProfileStore } from "./store.js";

describe("MemoryUserProfileStore contract", () => {
  it("satisfies the login-sync contract", async () => {
    await assertLoginSyncContract(new MemoryUserProfileStore());
  });

  it("satisfies the field-update contract", async () => {
    await assertFieldUpdateContract(new MemoryUserProfileStore());
  });

  it("satisfies the list/search contract", async () => {
    await assertListContract(new MemoryUserProfileStore());
  });
});

describe("MemoryUserProfileStore capture/restore", () => {
  it("round-trips state for the SQLite single-node persistence wrapper", async () => {
    const store = new MemoryUserProfileStore();
    await store.touchOnLogin({
      id: "local:alice",
      username: "alice",
      displayName: "Alice",
      provenance: "local",
      directorySubject: null,
    });
    const snapshot = store.capture();

    const restored = new MemoryUserProfileStore();
    restored.restore(snapshot);
    const profile = await restored.getById("local:alice");
    expect(profile?.username).toBe("alice");
    expect(profile?.displayName).toBe("Alice");
  });

  it("returns independent copies so callers cannot mutate internal state", async () => {
    const store = new MemoryUserProfileStore();
    await store.touchOnLogin({
      id: "local:mallory",
      username: "mallory",
      displayName: "Mallory",
      provenance: "local",
      directorySubject: null,
    });
    const profile = await store.getById("local:mallory");
    if (!profile) throw new Error("setup failed");
    (profile as { displayName: string }).displayName = "Tampered";
    const reread = await store.getById("local:mallory");
    expect(reread?.displayName).toBe("Mallory");
  });
});
