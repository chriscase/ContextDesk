import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
  EVIDENCE_STORAGE_ERRORS,
  MAX_EVIDENCE_S3_UPLOAD_BYTES,
  loadEvidenceStorageSettings,
  normalizeEvidenceS3Prefix,
} from "./s3-settings.js";

const CONTROL = ".data/evidence";
const CANARY_ENDPOINT = "https://s3-canary-host.invalid:8443";
const CANARY_BUCKET = "canary-bucket-xyz";
const CANARY_PREFIX = "canary-prefix-xyz";
const CANARY_CA_BODY =
  "-----BEGIN CERTIFICATE-----\nCANARYCAPEMCONTENTAAAAAAAAAAAAAAAA\n-----END CERTIFICATE-----\n";

function postgresOptions(): { controlRoot: string; storage: "postgres" } {
  return { controlRoot: CONTROL, storage: "postgres" };
}

function s3Base(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COLLAB_EVIDENCE_PROVIDER: "s3",
    COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
    COLLAB_EVIDENCE_S3_REGION: "garage",
    COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
    ...overrides,
  };
}

function load(env: NodeJS.ProcessEnv) {
  return loadEvidenceStorageSettings(env, postgresOptions());
}

function expectThrow(env: NodeJS.ProcessEnv, message: string) {
  expect(() => load(env)).toThrow(message);
  try {
    load(env);
  } catch (error) {
    const text = String(error);
    expect(text).not.toContain(CANARY_ENDPOINT);
    expect(text).not.toContain(CANARY_BUCKET);
    expect(text).not.toContain(CANARY_PREFIX);
    expect(text).not.toContain(CANARY_CA_BODY);
  }
}

describe("evidence storage settings defaults", () => {
  it("defaults to filesystem and keeps the local control-state root", () => {
    const settings = load({});
    expect(settings).toEqual({
      provider: "filesystem",
      controlRoot: CONTROL,
      storage: "postgres",
    });
    expect(JSON.stringify(settings)).not.toMatch(/secret|token|access key/i);
  });

  it("accepts explicit filesystem mode", () => {
    expect(load({ COLLAB_EVIDENCE_PROVIDER: "filesystem" }).provider).toBe(
      "filesystem",
    );
  });

  it("rejects an explicitly blank provider instead of treating it as the default", () => {
    expectThrow(
      { COLLAB_EVIDENCE_PROVIDER: "" },
      EVIDENCE_STORAGE_ERRORS.provider,
    );
  });

  it("fails closed on leftover s3 settings in filesystem mode, including blanks", () => {
    const leftovers = [
      "COLLAB_EVIDENCE_S3_ENDPOINT",
      "COLLAB_EVIDENCE_S3_REGION",
      "COLLAB_EVIDENCE_S3_BUCKET",
      "COLLAB_EVIDENCE_S3_PREFIX",
      "COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE",
      "COLLAB_EVIDENCE_S3_ALLOW_HTTP",
      "COLLAB_EVIDENCE_S3_CA_FILE",
      "COLLAB_EVIDENCE_S3_TIMEOUT_MS",
      "COLLAB_EVIDENCE_MAX_UPLOAD_BYTES",
      "COLLAB_EVIDENCE_S3_CREDENTIALS_MODE",
      "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID",
      "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE",
      "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF",
      "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY",
      "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE",
      "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF",
      "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
      "COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE",
      "COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF",
      "COLLAB_EVIDENCE_S3_PATH_STYLE",
    ];
    for (const name of leftovers) {
      expectThrow({ [name]: "" }, EVIDENCE_STORAGE_ERRORS.leftover);
      expectThrow(
        { [name]: name === "COLLAB_EVIDENCE_S3_ENDPOINT" ? CANARY_ENDPOINT : "1" },
        EVIDENCE_STORAGE_ERRORS.leftover,
      );
    }
  });

  it("does not treat commented examples as leftovers", () => {
    expect(load({}).provider).toBe("filesystem");
  });
});

describe("evidence s3 endpoint and TLS flags", () => {
  it("requires an explicit credentials mode for s3", () => {
    const env = s3Base();
    delete env.COLLAB_EVIDENCE_S3_CREDENTIALS_MODE;
    expectThrow(env, EVIDENCE_STORAGE_ERRORS.credentialsMode);
  });

  it("accepts https endpoints and Garage/Ceph/AWS region and bucket shapes", () => {
    const garage = load(s3Base());
    expect(garage.provider).toBe("s3");
    if (garage.provider !== "s3") throw new Error("expected s3");
    expect(garage.s3.endpoint).toBe("https://objects.example.test");
    expect(garage.s3.region).toBe("garage");
    expect(garage.s3.bucket).toBe("war-room-evidence");
    expect(garage.s3.prefix).toBe("");
    expect(garage.s3.forcePathStyle).toBe(true);
    expect(garage.s3.allowHttp).toBe(false);
    expect(garage.s3.timeoutMs).toBe(30_000);
    expect(garage.s3.maxUploadBytes).toBe(DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES);
    expect(garage.s3.caConfigured).toBe(false);
    expect(garage.s3.caFilePath).toBeNull();

    const aws = load(
      s3Base({
        COLLAB_EVIDENCE_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        COLLAB_EVIDENCE_S3_REGION: "us-east-1",
        COLLAB_EVIDENCE_S3_BUCKET: "my.war-room-bucket",
      }),
    );
    if (aws.provider !== "s3") throw new Error("expected s3");
    expect(aws.s3.region).toBe("us-east-1");
    expect(aws.s3.bucket).toBe("my.war-room-bucket");
    expect(aws.s3.forcePathStyle).toBe(false);

    const ceph = load(
      s3Base({
        COLLAB_EVIDENCE_S3_REGION: "default",
        COLLAB_EVIDENCE_S3_BUCKET: "ceph-bucket-01",
      }),
    );
    if (ceph.provider !== "s3") throw new Error("expected s3");
    expect(ceph.s3.region).toBe("default");

    const ipv6 = load(
      s3Base({ COLLAB_EVIDENCE_S3_ENDPOINT: "https://[::1]:9443" }),
    );
    if (ipv6.provider !== "s3") throw new Error("expected s3");
    expect(ipv6.s3.endpoint).toBe("https://[::1]:9443");
  });

  it("requires ALLOW_HTTP=1 for http endpoints and keeps https as the default", () => {
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:3900" }),
      EVIDENCE_STORAGE_ERRORS.endpointHttp,
    );
    const allowed = load(
      s3Base({
        COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:3900",
        COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
        COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE: "1",
      }),
    );
    if (allowed.provider !== "s3") throw new Error("expected s3");
    expect(allowed.s3.endpoint).toBe("http://127.0.0.1:3900");
    expect(allowed.s3.allowHttp).toBe(true);
    expect(allowed.s3.forcePathStyle).toBe(true);

    const explicitVirtualHost = load(
      s3Base({ COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE: "0" }),
    );
    if (explicitVirtualHost.provider !== "s3") throw new Error("expected s3");
    expect(explicitVirtualHost.s3.forcePathStyle).toBe(false);
  });

  it("rejects unsafe endpoint forms without echoing the value", () => {
    const unsafe = [
      "objects.example.test",
      "https://user:pass@objects.example.test",
      "https://user@objects.example.test",
      `${CANARY_ENDPOINT}?list-type=2`,
      `${CANARY_ENDPOINT}#frag`,
      "https://objects.example.test/bucket",
      "https://objects.example.test/%2e%2e",
      "https://objects.example.test/%2E./",
      "https://",
      "ftp://objects.example.test",
      "https://objects.example.test/../",
    ];
    for (const endpoint of unsafe) {
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_ENDPOINT: endpoint }),
        EVIDENCE_STORAGE_ERRORS.endpoint,
      );
    }
  });

  it("accepts only strict 0/1 for path-style and HTTP flags", () => {
    for (const value of ["", "true", "false", "yes", "2", " 1 "]) {
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE: value }),
        EVIDENCE_STORAGE_ERRORS.forcePathStyle,
      );
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_ALLOW_HTTP: value }),
        EVIDENCE_STORAGE_ERRORS.allowHttp,
      );
    }
  });
});

describe("evidence s3 prefix, bucket, timeout, and size", () => {
  it("normalizes a safe opaque prefix and rejects traversal or disclosure-prone forms", () => {
    expect(normalizeEvidenceS3Prefix("assigned-prefix")).toBe("assigned-prefix/");
    expect(normalizeEvidenceS3Prefix("war-room/evidence/")).toBe("war-room/evidence/");
    const loaded = load(s3Base({ COLLAB_EVIDENCE_S3_PREFIX: "assigned-prefix" }));
    if (loaded.provider !== "s3") throw new Error("expected s3");
    expect(loaded.s3.prefix).toBe("assigned-prefix/");

    const unsafe = [
      "..",
      "foo/../bar",
      "foo/./bar",
      "./foo",
      "foo\\bar",
      "foo\nbar",
      "foo\0bar",
      `${CANARY_PREFIX}?list`,
      `${CANARY_PREFIX}#meta`,
      "alice:secret@host",
      "https://evil.example",
      "foo%2e%2e",
      "foo%2fbar",
      "foo//bar",
      "/etc/passwd",
      "C:\\secrets",
      "~/.aws",
      "",
      " ",
    ];
    for (const prefix of unsafe) {
      expect(() => normalizeEvidenceS3Prefix(prefix)).toThrow(EVIDENCE_STORAGE_ERRORS.prefix);
    }
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_PREFIX: CANARY_PREFIX + "/../" }),
      EVIDENCE_STORAGE_ERRORS.prefix,
    );
  });

  it("rejects unsafe buckets and regions", () => {
    for (const bucket of [
      "AB",
      "UpperBucket",
      "under_score",
      "192.168.1.1",
      "xn--bucket",
      "bucket-s3alias",
      "bucket--ol-s3",
      "bucket.mrap",
      "bucket--x-s3",
      "bucket--table-s3",
      "sthree-bucket",
      "amzn-s3-demo-bucket",
      "a..b",
      "-leading",
      "trailing-",
      CANARY_BUCKET.toUpperCase(),
    ]) {
      expectThrow(s3Base({ COLLAB_EVIDENCE_S3_BUCKET: bucket }), EVIDENCE_STORAGE_ERRORS.bucket);
    }
    for (const region of ["US-EAST-1", "us_east_1", "", "us/east", "a.b"]) {
      expectThrow(s3Base({ COLLAB_EVIDENCE_S3_REGION: region }), EVIDENCE_STORAGE_ERRORS.region);
    }
  });

  it("bounds timeout and upload size, defaulting upload to 512 MiB", () => {
    const settings = load(s3Base());
    if (settings.provider !== "s3") throw new Error("expected s3");
    expect(settings.s3.maxUploadBytes).toBe(536_870_912);
    const min = load(s3Base({ COLLAB_EVIDENCE_MAX_UPLOAD_BYTES: "1" }));
    const max = load(
      s3Base({ COLLAB_EVIDENCE_MAX_UPLOAD_BYTES: String(MAX_EVIDENCE_S3_UPLOAD_BYTES) }),
    );
    if (min.provider !== "s3" || max.provider !== "s3") throw new Error("expected s3");
    expect(min.s3.maxUploadBytes).toBe(1);
    expect(max.s3.maxUploadBytes).toBe(MAX_EVIDENCE_S3_UPLOAD_BYTES);
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_MAX_UPLOAD_BYTES: "0" }),
      EVIDENCE_STORAGE_ERRORS.maxUpload,
    );
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_MAX_UPLOAD_BYTES: "5368709121" }),
      EVIDENCE_STORAGE_ERRORS.maxUpload,
    );
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "999" }),
      EVIDENCE_STORAGE_ERRORS.timeout,
    );
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "120001" }),
      EVIDENCE_STORAGE_ERRORS.timeout,
    );
    const timeoutMin = load(s3Base({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "1000" }));
    const timeoutMax = load(s3Base({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "120000" }));
    if (timeoutMin.provider !== "s3" || timeoutMax.provider !== "s3") {
      throw new Error("expected s3");
    }
    expect(timeoutMin.s3.timeoutMs).toBe(1_000);
    expect(timeoutMax.s3.timeoutMs).toBe(120_000);
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "30000ms" }),
      EVIDENCE_STORAGE_ERRORS.timeout,
    );
  });

  it("rejects unknown s3 environment names", () => {
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_PATH_STYLE: "1" }),
      EVIDENCE_STORAGE_ERRORS.unknownSetting,
    );
  });
});

describe("evidence s3 custom CA file", () => {
  it("stores only path and boolean after validating a bounded regular PEM file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-"));
    const file = join(dir, "ca.pem");
    await writeFile(file, CANARY_CA_BODY, { mode: 0o644 });
    try {
      const settings = load(s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: file }));
      if (settings.provider !== "s3") throw new Error("expected s3");
      expect(settings.s3.caConfigured).toBe(true);
      expect(settings.s3.caFilePath).toBe(file);
      const json = JSON.stringify(settings);
      expect(json).not.toContain(CANARY_CA_BODY);
      expect(json).not.toMatch(/BEGIN CERTIFICATE/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects relative, blank, empty, and non-PEM CA files", async () => {
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: "" }),
      EVIDENCE_STORAGE_ERRORS.caFile,
    );
    expectThrow(
      s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: "relative-ca.pem" }),
      EVIDENCE_STORAGE_ERRORS.caFile,
    );
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-bad-"));
    const empty = join(dir, "empty.pem");
    const notPem = join(dir, "not.pem");
    await writeFile(empty, "", { mode: 0o644 });
    await writeFile(notPem, "not-a-certificate\n", { mode: 0o644 });
    try {
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: empty }),
        EVIDENCE_STORAGE_ERRORS.caFile,
      );
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: notPem }),
        EVIDENCE_STORAGE_ERRORS.caFile,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects CA files containing NUL or exceeding the byte bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-bounds-"));
    const nul = join(dir, "nul.pem");
    const oversize = join(dir, "oversize.pem");
    await writeFile(nul, `${CANARY_CA_BODY}\0`, { mode: 0o644 });
    await writeFile(oversize, "a".repeat(1024 * 1024 + 1), { mode: 0o644 });
    try {
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: nul }),
        EVIDENCE_STORAGE_ERRORS.caFile,
      );
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: oversize }),
        EVIDENCE_STORAGE_ERRORS.caFile,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a CA symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-link-"));
    const file = join(dir, "ca.pem");
    const link = join(dir, "ca.link");
    await writeFile(file, CANARY_CA_BODY, { mode: 0o644 });
    await symlink(file, link);
    try {
      expectThrow(
        s3Base({ COLLAB_EVIDENCE_S3_CA_FILE: link }),
        EVIDENCE_STORAGE_ERRORS.caFile,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
