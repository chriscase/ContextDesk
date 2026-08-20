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
    expect(testConfig().storage).toBe("postgres");
  });

  it("supports an explicit SQLite local/single-node runtime without database URLs", () => {
    const config = loadRuntimeConfig({
      COLLAB_STORAGE: "sqlite",
      COLLAB_SQLITE_PATH: "/var/lib/cd-collab/collab.sqlite",
    });
    expect(config.storage).toBe("sqlite");
    expect(config.sqlitePath).toBe("/var/lib/cd-collab/collab.sqlite");
    expect(config.databaseUrl).toBeNull();
    expect(config.migrateDatabaseUrl).toBeNull();
  });

  it("requires the SQLite path and rejects unknown storage modes", () => {
    expect(() => loadRuntimeConfig({ COLLAB_STORAGE: "sqlite" })).toThrow(
      /missing required environment variable: COLLAB_SQLITE_PATH/,
    );
    expect(() => loadRuntimeConfig({ ...database, COLLAB_STORAGE: "memory" })).toThrow(
      /COLLAB_STORAGE must be postgres or sqlite/,
    );
  });
});
