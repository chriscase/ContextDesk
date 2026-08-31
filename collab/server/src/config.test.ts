import { describe, expect, it } from "vitest";
import { loadEvidenceStorageSettings, loadRuntimeConfig, parseTrustProxy, testConfig } from "./config.js";

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

  it("keeps the client address at the socket peer unless an ingress is declared", () => {
    expect(loadRuntimeConfig(database).trustProxy).toBeNull();
    expect(testConfig().trustProxy).toBeNull();
    for (const value of ["", "   ", "0", "false", "off"]) {
      expect(parseTrustProxy(value), value).toBeNull();
    }
  });

  it("accepts an ingress hop count or an explicit address list", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("10.0.0.0/8, 127.0.0.1")).toBe("10.0.0.0/8,127.0.0.1");
    expect(
      loadRuntimeConfig({ ...database, COLLAB_TRUST_PROXY: "1" }).trustProxy,
    ).toBe(1);
  });

  it("refuses trusting every forwarded address and out-of-range hop counts", () => {
    // Trust-all would let any client forge X-Forwarded-For and pick its own
    // rate-limit bucket and audit origin.
    for (const value of ["true", "TRUE", "all", "*"]) {
      expect(() => parseTrustProxy(value), value).toThrow(
        /trusting every forwarded address is refused/,
      );
    }
    expect(() => parseTrustProxy("17")).toThrow(/hop count must be 0\.\.16/);
  });

  it("defaults evidence storage to filesystem and keeps the control-state root", () => {
    const config = loadRuntimeConfig(database);
    expect(config.evidenceRoot).toBe(".data/evidence");
    expect(loadEvidenceStorageSettings(database, {
      controlRoot: config.evidenceRoot,
      storage: config.storage,
    }).provider).toBe("filesystem");
    expect(JSON.stringify(config)).not.toMatch(/COLLAB_EVIDENCE_S3/);
  });

  it("fails closed on leftover s3 configuration in filesystem mode", () => {
    const canary = "https://s3-canary-host.invalid:8443";
    expect(() =>
      loadRuntimeConfig({ ...database, COLLAB_EVIDENCE_S3_ENDPOINT: canary }),
    ).toThrow(/leftover s3 configuration/);
    try {
      loadRuntimeConfig({ ...database, COLLAB_EVIDENCE_S3_ENDPOINT: canary });
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("accepts s3 evidence settings without placing secrets on Config", () => {
    const secret = "canarySecretAccessKeyValue!!";
    const token = "canarySessionTokenValue!!";
    const config = loadRuntimeConfig({
      ...database,
      COLLAB_EVIDENCE_PROVIDER: "s3",
      COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
      COLLAB_EVIDENCE_S3_REGION: "garage",
      COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
      COLLAB_EVIDENCE_S3_PREFIX: "assigned-prefix",
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "GKEXAMPLEKEYID0001",
      COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: secret,
      COLLAB_EVIDENCE_S3_SESSION_TOKEN: token,
    });
    expect(config.evidenceRoot).toBe(".data/evidence");
    expect(config).not.toHaveProperty("s3");
    const json = JSON.stringify(config);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(token);
    expect(json).not.toContain("GKEXAMPLEKEYID0001");
  });
});
