import { describe, expect, it } from "vitest";
import { loadEvidenceStorageSettings, loadRuntimeConfig, parseTrustProxy, testConfig } from "./config.js";
import {
  DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
  DEFAULT_EVIDENCE_S3_TIMEOUT_MS,
} from "./evidence/s3-settings.js";

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
    expect(testConfig().evidence).toEqual({
      provider: "filesystem",
      controlRoot: ".data/evidence",
      storage: "postgres",
      maxUploadBytes: DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
    });
    expect(testConfig({ evidenceRoot: "/tmp/ev", storage: "sqlite" }).evidence).toEqual({
      provider: "filesystem",
      controlRoot: "/tmp/ev",
      storage: "sqlite",
      maxUploadBytes: DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
    });
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
    expect(config.evidence).toEqual({
      provider: "filesystem",
      controlRoot: ".data/evidence",
      storage: "postgres",
      maxUploadBytes: DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
    });
    expect(loadEvidenceStorageSettings(database, {
      controlRoot: config.evidenceRoot,
      storage: config.storage,
    })).toEqual(config.evidence);
    expect(JSON.stringify(config)).not.toMatch(/COLLAB_EVIDENCE_S3/);
    expect(config).not.toHaveProperty("credentials");
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
    const accessKey = "GKEXAMPLEKEYID0001";
    const credentialFile = "/run/secrets/canary-s3-secret";
    const config = loadRuntimeConfig({
      ...database,
      COLLAB_EVIDENCE_PROVIDER: "s3",
      COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
      COLLAB_EVIDENCE_S3_REGION: "garage",
      COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
      COLLAB_EVIDENCE_S3_PREFIX: "assigned-prefix",
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: accessKey,
      COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: secret,
      COLLAB_EVIDENCE_S3_SESSION_TOKEN: token,
    });
    expect(config.evidenceRoot).toBe(".data/evidence");
    expect(config).not.toHaveProperty("s3");
    expect(config).not.toHaveProperty("credentials");
    expect(config.evidence).toEqual({
      provider: "s3",
      controlRoot: ".data/evidence",
      storage: "postgres",
      maxUploadBytes: DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
      s3: {
        endpoint: "https://objects.example.test",
        region: "garage",
        bucket: "war-room-evidence",
        prefix: "assigned-prefix/",
        forcePathStyle: true,
        allowHttp: false,
        caConfigured: false,
        caFilePath: null,
        timeoutMs: DEFAULT_EVIDENCE_S3_TIMEOUT_MS,
        maxUploadBytes: DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
        credentialsMode: "static",
      },
    });
    const json = JSON.stringify(config);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(token);
    expect(json).not.toContain(accessKey);
    expect(json).not.toContain(credentialFile);
    expect(json).not.toMatch(/BEGIN CERTIFICATE/);
  });

  it("always populates a provider-neutral maxUploadBytes on Config", () => {
    const filesystem = loadRuntimeConfig(database);
    expect(filesystem.evidence.maxUploadBytes).toBe(DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES);
    expect(testConfig().evidence.maxUploadBytes).toBe(DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES);
    expect(
      testConfig({
        evidence: { provider: "filesystem", controlRoot: "/tmp/ev", storage: "sqlite" },
      }).evidence.maxUploadBytes,
    ).toBe(DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES);
  });

  it("accepts COLLAB_EVIDENCE_MAX_UPLOAD_BYTES in filesystem mode", () => {
    const config = loadRuntimeConfig({
      ...database,
      COLLAB_EVIDENCE_MAX_UPLOAD_BYTES: "1048576",
    });
    expect(config.evidence).toEqual({
      provider: "filesystem",
      controlRoot: ".data/evidence",
      storage: "postgres",
      maxUploadBytes: 1_048_576,
    });
  });

  it("fails closed on s3 credential load without storing credentials on Config", () => {
    expect(() =>
      loadRuntimeConfig({
        ...database,
        COLLAB_EVIDENCE_PROVIDER: "s3",
        COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
        COLLAB_EVIDENCE_S3_REGION: "garage",
        COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
        COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      }),
    ).toThrow(/static credentials require an access key id and secret access key/);
  });
});
