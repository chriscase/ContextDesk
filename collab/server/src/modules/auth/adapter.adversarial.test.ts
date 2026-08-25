import { describe, expect, it } from "vitest";
import { MapAuthAdapter } from "./adapter.js";

function identity(username: string) {
  return {
    id: `local:${username}`,
    username,
    displayName: username,
  };
}

function adapter() {
  return new MapAuthAdapter(
    new Map([
      [
        "lead",
        {
          password: "correct-horse",
          identity: identity("lead"),
          groups: ["local:case-lead"],
        },
      ],
      [
        "unicode",
        {
          password: "café🔐",
          identity: identity("unicode"),
          groups: ["local:operators"],
        },
      ],
    ]),
  );
}

describe("MapAuthAdapter timing-safe password compare", () => {
  it("accepts an equal configured password and preserves the owner-local boundary", async () => {
    const auth = adapter();
    const success = await auth.authenticate("lead", "correct-horse");
    expect(success).toEqual({
      identity: identity("lead"),
      groups: ["local:case-lead"],
    });
  });

  it("rejects an unequal same-length password without throwing", async () => {
    const auth = adapter();
    await expect(auth.authenticate("lead", "correct-horsf")).resolves.toBeNull();
    await expect(auth.authenticate("lead", "CORRECT-HORSE")).resolves.toBeNull();
  });

  it("rejects unequal-length passwords without throwing", async () => {
    const auth = adapter();
    await expect(auth.authenticate("lead", "short")).resolves.toBeNull();
    await expect(auth.authenticate("lead", "correct-horse!")).resolves.toBeNull();
    await expect(auth.authenticate("lead", "")).resolves.toBeNull();
    await expect(auth.authenticate("lead", "a".repeat(256))).resolves.toBeNull();
  });

  it("compares Unicode by UTF-8 bytes, not visual equality", async () => {
    const auth = adapter();
    await expect(auth.authenticate("unicode", "café🔐")).resolves.toMatchObject({
      identity: { username: "unicode" },
    });
    // NFC vs NFD: same visual letters, different UTF-8 byte length/contents.
    await expect(auth.authenticate("unicode", "cafe\u0301🔐")).resolves.toBeNull();
    await expect(auth.authenticate("unicode", "cafe🔐")).resolves.toBeNull();
  });

  it("returns null for unknown users, including when the password matches a known account", async () => {
    const auth = adapter();
    await expect(auth.authenticate("nobody", "correct-horse")).resolves.toBeNull();
    await expect(auth.authenticate("nobody", "wrong")).resolves.toBeNull();
    await expect(auth.authenticate("", "correct-horse")).resolves.toBeNull();
    await expect(auth.authenticate("lead-extra", "correct-horse")).resolves.toBeNull();
  });

  it("does not return the password or a derived digest", async () => {
    const auth = adapter();
    const result = await auth.authenticate("lead", "correct-horse");
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("correct-horse");
    expect(JSON.stringify(result)).not.toContain("sha256");
    expect(JSON.stringify(result)).not.toContain("unknownUserProbe");
  });
});
