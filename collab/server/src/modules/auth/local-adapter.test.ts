import { describe, expect, it } from "vitest";
import { loadLocalAuthAdapter } from "./local-adapter.js";

describe("local auth adapter", () => {
  it("authenticates configured private users and resolves their groups", async () => {
    const adapter = loadLocalAuthAdapter({
      COLLAB_LOCAL_USERS: JSON.stringify([
        {
          username: "lead",
          password: "local-secret",
          displayName: "Local Lead",
          groups: ["local:case-lead"],
        },
      ]),
    });
    const success = await adapter.authenticate("lead", "local-secret");
    expect(success).toMatchObject({
      identity: { id: "local:lead", username: "lead", displayName: "Local Lead" },
      groups: ["local:case-lead"],
    });
    expect(await adapter.authenticate("lead", "wrong")).toBeNull();
    expect(await adapter.lookupGroups(success!.identity)).toEqual(["local:case-lead"]);
    expect(await adapter.searchIdentities("local", { limit: 20, timeoutMs: 100 })).toEqual([
      {
        id: "local:lead",
        username: "lead",
        displayName: "Local Lead",
        source: "local",
      },
    ]);
    expect(
      await adapter.searchDirectoryGroups("local", { limit: 20, timeoutMs: 100 }),
    ).toEqual([
      {
        dn: "local:case-lead",
        name: "case-lead",
        source: "local",
      },
    ]);
  });

  it("bounds, sorts, and privacy-projects configured local search results", async () => {
    const adapter = loadLocalAuthAdapter({
      COLLAB_LOCAL_USERS: JSON.stringify(
        Array.from({ length: 25 }, (_, index) => ({
          username: `person-${String(index).padStart(2, "0")}`,
          password: `secret-${index}`,
          displayName: `Person ${String(index).padStart(2, "0")}`,
          groups: ["local:operators"],
        })),
      ),
    });
    const identities = await adapter.searchIdentities("person", {
      limit: 20,
      timeoutMs: 100,
    });
    expect(identities).toHaveLength(20);
    expect(identities[0]?.username).toBe("person-00");
    expect(JSON.stringify(identities)).not.toContain("secret-");
    expect(
      await adapter.searchDirectoryGroups("local", { limit: 20, timeoutMs: 100 }),
    ).toHaveLength(1);
  });

  it("fails closed for missing, malformed, and duplicate local users", () => {
    expect(() => loadLocalAuthAdapter({})).toThrow(/requires COLLAB_LOCAL_USERS/);
    expect(() => loadLocalAuthAdapter({ COLLAB_LOCAL_USERS: "not-json" })).toThrow(/valid JSON/);
    expect(() => loadLocalAuthAdapter({ COLLAB_LOCAL_USERS: "[]" })).toThrow(/non-empty/);
    const duplicate = JSON.stringify([
      { username: "lead", password: "one", groups: ["local:lead"] },
      { username: "lead", password: "two", groups: ["local:lead"] },
    ]);
    expect(() => loadLocalAuthAdapter({ COLLAB_LOCAL_USERS: duplicate })).toThrow(/duplicate/);
  });
});
