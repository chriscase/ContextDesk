import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, testConfig } from "./config.js";

describe("runtime configuration", () => {
  const database = {
    COLLAB_DATABASE_URL: "postgres://app@example.test/collab",
  };

  it("defaults to LDAP and permits explicit local auth", () => {
    expect(loadRuntimeConfig(database).authMode).toBe("ldap");
    expect(loadRuntimeConfig({ ...database, COLLAB_AUTH_MODE: "local" }).authMode).toBe("local");
  });

  it("rejects unknown authentication modes", () => {
    expect(() => loadRuntimeConfig({ ...database, COLLAB_AUTH_MODE: "header" })).toThrow(
      /must be ldap or local/,
    );
  });

  it("keeps test defaults explicit", () => {
    expect(testConfig().authMode).toBe("ldap");
  });
});
