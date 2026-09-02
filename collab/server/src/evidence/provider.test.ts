import { Agent as HttpsAgent } from "node:https";
import { inspect } from "node:util";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { describe, expect, it } from "vitest";
import {
  createPostgresEvidenceWriteLease,
  type EvidenceWriteLeaseClient,
  type EvidenceWriteLeasePool,
} from "./lease.js";
import {
  createEvidenceStore,
  EVIDENCE_S3_CLIENT_MAX_ATTEMPTS,
  EVIDENCE_S3_PROVIDER_CONFIG_ERROR,
  type EvidenceS3RequestHandlerOptions,
} from "./provider.js";
import { loadEvidenceS3Credentials } from "./s3-secrets.js";
import {
  DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
  DEFAULT_EVIDENCE_S3_TIMEOUT_MS,
  EVIDENCE_STORAGE_ERRORS,
  MAX_EVIDENCE_S3_CA_FILE_BYTES,
  loadEvidenceStorageSettings,
  type EvidenceStorageSettings,
} from "./s3-settings.js";
import { FilesystemEvidenceStore } from "./store.js";
import { S3EvidenceError, S3EvidenceStore } from "./s3-store.js";

const CONTROL = ".data/evidence";
const CANARY_ENDPOINT = "https://s3-canary-host.invalid:8443";
const HTTP_CANARY_ENDPOINT = "http://s3-canary-host.invalid:3900";
const CANARY_ACCESS = "CANARYACCESSKEYIDXX";
const CANARY_SECRET = "canarySecretAccessKeyValue!!";
const CANARY_TOKEN = "canarySessionTokenValue!!";
const CANARY_CRED_FILE = "/run/secrets/canary-s3-secret";
const CANARY_CA_BODY =
  "-----BEGIN CERTIFICATE-----\nCANARYCAPEMCONTENTAAAAAAAAAAAAAAAA\n-----END CERTIFICATE-----\n";

class FakeS3Error extends Error {
  readonly Code: string;
  readonly $metadata: { httpStatusCode: number };

  constructor(name: string, status: number, message: string) {
    super(message);
    this.name = name;
    this.Code = name;
    this.$metadata = { httpStatusCode: status };
  }
}

class FakeS3Client {
  readonly calls: Array<{
    name: string;
    input: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }> = [];
  bucketExists = true;
  putKeys: string[] = [];
  putBytes: number[] = [];

  constructor(private readonly bucket: string) {}

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = commandName(command);
    const input = commandInput(command);
    this.calls.push({ name, input: { ...input }, abortSignal: options?.abortSignal });
    if (command instanceof HeadBucketCommand) {
      if (!this.bucketExists || input.Bucket !== this.bucket) {
        throw new FakeS3Error(
          "NotFound",
          404,
          `NotFound bucket=${String(input.Bucket)} endpoint=${CANARY_ENDPOINT} secret=${CANARY_SECRET}`,
        );
      }
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      throw new FakeS3Error("NotFound", 404, "NotFound");
    }
    if (command instanceof PutObjectCommand) {
      this.putKeys.push(String(input.Key ?? ""));
      const body = input.Body;
      if (body && typeof body === "object" && Symbol.asyncIterator in body) {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          this.putBytes.push(chunk.byteLength);
        }
      }
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      return { Contents: [], IsTruncated: false };
    }
    throw new FakeS3Error("NotImplemented", 400, `unsupported ${name}`);
  }
}

function commandName(command: unknown): string {
  if (typeof command === "object" && command !== null) {
    const name = (command as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === "string" && name !== "") return name;
  }
  return "UnknownCommand";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (typeof command === "object" && command !== null && "input" in command) {
    const input = (command as { input?: unknown }).input;
    if (typeof input === "object" && input !== null) return input as Record<string, unknown>;
  }
  return {};
}

function filesystemSettings(
  storage: "postgres" | "sqlite" = "postgres",
  controlRoot = CONTROL,
): EvidenceStorageSettings {
  return { provider: "filesystem", controlRoot, storage };
}

function s3Env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COLLAB_EVIDENCE_PROVIDER: "s3",
    COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
    COLLAB_EVIDENCE_S3_REGION: "garage",
    COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
    COLLAB_EVIDENCE_S3_PREFIX: "assigned-prefix",
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: CANARY_ACCESS,
    COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: CANARY_SECRET,
    ...overrides,
  };
}

function loadS3Settings(env: NodeJS.ProcessEnv = s3Env()): Extract<
  EvidenceStorageSettings,
  { provider: "s3" }
> {
  const settings = loadEvidenceStorageSettings(env, {
    controlRoot: CONTROL,
    storage: "postgres",
  });
  if (settings.provider !== "s3") throw new Error("expected s3 settings");
  return settings;
}

function staticCredentials(env: NodeJS.ProcessEnv = s3Env()) {
  return loadEvidenceS3Credentials(env);
}

function defaultChainCredentials() {
  return loadEvidenceS3Credentials({
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
  });
}

function fakePool(): EvidenceWriteLeasePool {
  const client: EvidenceWriteLeaseClient = {
    async query() {
      return undefined;
    },
    release() {
      return undefined;
    },
  };
  return { connect: async () => client };
}

function expectSanitized(error: unknown) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  const rendered = inspect(error, { depth: 8, getters: true, showHidden: true });
  for (const canary of [
    CANARY_ENDPOINT,
    HTTP_CANARY_ENDPOINT,
    CANARY_ACCESS,
    CANARY_SECRET,
    CANARY_TOKEN,
    CANARY_CRED_FILE,
    CANARY_CA_BODY,
    "BEGIN CERTIFICATE",
  ]) {
    expect(text).not.toContain(canary);
    expect(rendered).not.toContain(canary);
  }
}

function expectOpaqueStore(store: object) {
  const json = JSON.stringify(store);
  const rendered = inspect(store, { depth: 8, getters: true, showHidden: true });
  for (const canary of [
    CANARY_ENDPOINT,
    HTTP_CANARY_ENDPOINT,
    CANARY_ACCESS,
    CANARY_SECRET,
    CANARY_TOKEN,
    CANARY_CRED_FILE,
    CANARY_CA_BODY,
    "BEGIN CERTIFICATE",
  ]) {
    expect(json).not.toContain(canary);
    expect(rendered).not.toContain(canary);
  }
}

describe("createEvidenceStore filesystem", () => {
  it("uses controlRoot for the default filesystem provider and an external postgres lease", () => {
    const pool = fakePool();
    const leased: EvidenceWriteLeasePool[] = [];
    const store = createEvidenceStore({
      settings: filesystemSettings("postgres", "/var/lib/cd-collab/evidence"),
      writeLeasePool: pool,
      createWriteLease: (source) => {
        leased.push(source);
        return createPostgresEvidenceWriteLease(source);
      },
    });
    expect(store).toBeInstanceOf(FilesystemEvidenceStore);
    expect((store as FilesystemEvidenceStore).rootDir).toBe(
      "/var/lib/cd-collab/evidence",
    );
    expect(store.writeCoordination).toBe("external");
    expect(leased).toEqual([pool]);
  });

  it("uses controlRoot for explicit filesystem mode", () => {
    const settings = loadEvidenceStorageSettings(
      { COLLAB_EVIDENCE_PROVIDER: "filesystem" },
      { controlRoot: "/explicit/control", storage: "postgres" },
    );
    const store = createEvidenceStore({
      settings,
      writeLeasePool: fakePool(),
    });
    expect(store).toBeInstanceOf(FilesystemEvidenceStore);
    expect((store as FilesystemEvidenceStore).rootDir).toBe("/explicit/control");
    expect(store.writeCoordination).toBe("external");
  });

  it("keeps sqlite filesystem coordination as truthful single_process", () => {
    const store = createEvidenceStore({
      settings: filesystemSettings("sqlite", "/sqlite/control"),
    });
    expect(store).toBeInstanceOf(FilesystemEvidenceStore);
    expect((store as FilesystemEvidenceStore).rootDir).toBe("/sqlite/control");
    expect(store.writeCoordination).toBe("single_process");
  });

  it("does not bind referenced-content-hash sources", async () => {
    const store = createEvidenceStore({
      settings: filesystemSettings(),
    });
    await expect(store.recoverUnreferencedWrites()).rejects.toThrow(
      /referenced content hashes are required/,
    );
  });
});

describe("createEvidenceStore s3 credentials", () => {
  it("projects static credentials only when both settings and credentials are static", () => {
    const captured: S3ClientConfig[] = [];
    const fake = new FakeS3Client("war-room-evidence");
    const store = createEvidenceStore({
      settings: loadS3Settings(
        s3Env({ COLLAB_EVIDENCE_S3_SESSION_TOKEN: CANARY_TOKEN }),
      ),
      credentials: staticCredentials(
        s3Env({ COLLAB_EVIDENCE_S3_SESSION_TOKEN: CANARY_TOKEN }),
      ),
      createS3Client: (config) => {
        captured.push(config);
        return fake;
      },
    });
    expect(store).toBeInstanceOf(S3EvidenceStore);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.credentials).toEqual({
      accessKeyId: CANARY_ACCESS,
      secretAccessKey: CANARY_SECRET,
      sessionToken: CANARY_TOKEN,
    });
    expectOpaqueStore(store);
  });

  it("uses the SDK default chain only when both sides are default_chain", () => {
    const captured: S3ClientConfig[] = [];
    const fake = new FakeS3Client("war-room-evidence");
    const loaded = loadS3Settings({
      COLLAB_EVIDENCE_PROVIDER: "s3",
      COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
      COLLAB_EVIDENCE_S3_REGION: "garage",
      COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
    });
    const store = createEvidenceStore({
      settings: loaded,
      credentials: defaultChainCredentials(),
      createS3Client: (config) => {
        captured.push(config);
        return fake;
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.credentials).toBeUndefined();
    expect(captured[0]?.credentialDefaultProvider).toBeUndefined();
    expectOpaqueStore(store);
  });

  it("fails closed on settings/credentials mode mismatch", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const createS3Client = () => fake;
    try {
      createEvidenceStore({
        settings: loadS3Settings(),
        credentials: defaultChainCredentials(),
        createS3Client,
      });
      throw new Error("expected mismatch refusal");
    } catch (error) {
      expect((error as Error).message).toBe(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
      expectSanitized(error);
    }
    try {
      createEvidenceStore({
        settings: loadS3Settings({
          COLLAB_EVIDENCE_PROVIDER: "s3",
          COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test",
          COLLAB_EVIDENCE_S3_REGION: "garage",
          COLLAB_EVIDENCE_S3_BUCKET: "war-room-evidence",
          COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain",
        }),
        credentials: staticCredentials(),
        createS3Client,
      });
      throw new Error("expected mismatch refusal");
    } catch (error) {
      expect((error as Error).message).toBe(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
      expectSanitized(error);
    }
  });
});

describe("createEvidenceStore s3 client projection", () => {
  it("projects endpoint, path style, prefix, region, bucket, checksums, and maxAttempts=3 once", async () => {
    const captured: S3ClientConfig[] = [];
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    const store = createEvidenceStore({
      settings,
      credentials: staticCredentials(),
      createS3Client: (config) => {
        captured.push(config);
        return fake;
      },
    });
    expect(captured).toHaveLength(1);
    expect(EVIDENCE_S3_CLIENT_MAX_ATTEMPTS).toBe(3);
    expect(captured[0]?.maxAttempts).toBe(EVIDENCE_S3_CLIENT_MAX_ATTEMPTS);
    expect(captured[0]?.region).toBe("garage");
    expect(captured[0]?.endpoint).toBe("https://objects.example.test");
    expect(captured[0]?.forcePathStyle).toBe(true);
    expect(captured[0]?.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(captured[0]?.responseChecksumValidation).toBe("WHEN_REQUIRED");
    expect(captured[0]?.disableS3ExpressSessionAuth).toBe(true);
    await store.ping();
    expect(fake.calls.filter((call) => call.name === "HeadBucketCommand")).toHaveLength(1);
    expect(fake.calls[0]?.input.Bucket).toBe("war-room-evidence");
    await store.put(new TextEncoder().encode("prefix-probe"));
    expect(fake.putKeys[0]).toMatch(/^assigned-prefix\//);
    expect(store.writeCoordination).toBe("single_process");
  });

  it("supplies an external postgres lease in s3 mode when a pool exists", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const store = createEvidenceStore({
      settings: loadS3Settings(),
      credentials: staticCredentials(),
      writeLeasePool: fakePool(),
      createS3Client: () => fake,
    });
    expect(store.writeCoordination).toBe("external");
  });

  it("keeps sqlite s3 coordination truthful as single_process", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    const store = createEvidenceStore({
      settings: { ...settings, storage: "sqlite" },
      credentials: staticCredentials(),
      createS3Client: () => fake,
    });
    expect(store.writeCoordination).toBe("single_process");
  });
});

describe("createEvidenceStore custom CA", () => {
  it("re-reads a bounded regular CA file and builds a verified TLS handler with both timeouts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-provider-"));
    const file = join(dir, "ca.pem");
    await writeFile(file, CANARY_CA_BODY, { mode: 0o644 });
    const beforeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const handlers: EvidenceS3RequestHandlerOptions[] = [];
    const captured: S3ClientConfig[] = [];
    const fake = new FakeS3Client("war-room-evidence");
    try {
      const settings = loadS3Settings(s3Env({ COLLAB_EVIDENCE_S3_CA_FILE: file }));
      const store = createEvidenceStore({
        settings,
        credentials: staticCredentials(),
        createRequestHandler: (options) => {
          handlers.push(options);
          return { kind: "test-handler" };
        },
        createS3Client: (config) => {
          captured.push(config);
          return fake;
        },
      });
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.connectionTimeout).toBe(DEFAULT_EVIDENCE_S3_TIMEOUT_MS);
      expect(handlers[0]?.requestTimeout).toBe(DEFAULT_EVIDENCE_S3_TIMEOUT_MS);
      expect(handlers[0]?.throwOnRequestTimeout).toBe(true);
      expect(handlers[0]?.httpsAgent).toBeInstanceOf(HttpsAgent);
      expect(handlers[0]?.httpsAgent?.options.rejectUnauthorized).toBe(true);
      expect(handlers[0]?.httpsAgent?.options.ca).toEqual(Buffer.from(CANARY_CA_BODY));
      expect(captured[0]?.requestHandler).toEqual({ kind: "test-handler" });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(beforeTls);
      expectOpaqueStore(store);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("constructs the real NodeHttpHandler in production assembly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-handler-"));
    const file = join(dir, "ca.pem");
    await writeFile(file, CANARY_CA_BODY, { mode: 0o644 });
    const captured: S3ClientConfig[] = [];
    const fake = new FakeS3Client("war-room-evidence");
    try {
      const settings = loadS3Settings(s3Env({ COLLAB_EVIDENCE_S3_CA_FILE: file }));
      createEvidenceStore({
        settings,
        credentials: staticCredentials(),
        createS3Client: (config) => {
          captured.push(config);
          return fake;
        },
      });
      expect(captured[0]?.requestHandler).toBeInstanceOf(NodeHttpHandler);
      const handler = captured[0]?.requestHandler as NodeHttpHandler;
      handler.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a CA symlink and an oversize CA without echoing path or PEM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-collab-s3-ca-bad-"));
    const file = join(dir, "ca.pem");
    const link = join(dir, "ca.link");
    const oversize = join(dir, "oversize.pem");
    await writeFile(file, CANARY_CA_BODY, { mode: 0o644 });
    await writeFile(oversize, "a".repeat(MAX_EVIDENCE_S3_CA_FILE_BYTES + 1), {
      mode: 0o644,
    });
    if (process.platform !== "win32") {
      await symlink(file, link);
    }
    const fake = new FakeS3Client("war-room-evidence");
    const base = loadS3Settings();
    try {
      if (process.platform !== "win32") {
        try {
          createEvidenceStore({
            settings: {
              ...base,
              s3: { ...base.s3, caConfigured: true, caFilePath: link },
            },
            credentials: staticCredentials(),
            createS3Client: () => fake,
          });
          throw new Error("expected symlink refusal");
        } catch (error) {
          expect((error as Error).message).toBe(EVIDENCE_STORAGE_ERRORS.caFile);
          expectSanitized(error);
          expect(String(error)).not.toContain(link);
        }
      }
      try {
        createEvidenceStore({
          settings: {
            ...base,
            s3: { ...base.s3, caConfigured: true, caFilePath: oversize },
          },
          credentials: staticCredentials(),
          createS3Client: () => fake,
        });
        throw new Error("expected oversize refusal");
      } catch (error) {
        expect((error as Error).message).toBe(EVIDENCE_STORAGE_ERRORS.caFile);
        expectSanitized(error);
        expect(String(error)).not.toContain(oversize);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createEvidenceStore HTTP allowlist", () => {
  it("accepts HTTP only for previously validated allowHttp=true settings", async () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings(
      s3Env({
        COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:3900",
        COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
      }),
    );
    const captured: S3ClientConfig[] = [];
    const store = createEvidenceStore({
      settings,
      credentials: staticCredentials(),
      createS3Client: (config) => {
        captured.push(config);
        return fake;
      },
    });
    expect(captured[0]?.endpoint).toBe("http://127.0.0.1:3900");
    await store.ping();
  });

  it("fails closed on handcrafted http settings that did not prove allowHttp", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    const inconsistent: EvidenceStorageSettings = {
      ...settings,
      s3: {
        ...settings.s3,
        endpoint: HTTP_CANARY_ENDPOINT,
        allowHttp: false,
      },
    };
    try {
      createEvidenceStore({
        settings: inconsistent,
        credentials: staticCredentials(),
        createS3Client: () => fake,
      });
      throw new Error("expected inconsistent http refusal");
    } catch (error) {
      expect((error as Error).message).toBe(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
      expectSanitized(error);
    }
  });

  it("fails closed when handcrafted HTTP settings claim a custom CA", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    const inconsistent: EvidenceStorageSettings = {
      ...settings,
      s3: {
        ...settings.s3,
        endpoint: HTTP_CANARY_ENDPOINT,
        allowHttp: true,
        caConfigured: true,
        caFilePath: CANARY_CRED_FILE,
      },
    };
    try {
      createEvidenceStore({
        settings: inconsistent,
        credentials: staticCredentials(),
        createS3Client: () => fake,
      });
      throw new Error("expected plaintext custom CA refusal");
    } catch (error) {
      expect((error as Error).message).toBe(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
      expectSanitized(error);
    }
  });

  it("fails closed on handcrafted non-origin endpoints and out-of-range timeouts", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    for (const s3 of [
      { ...settings.s3, endpoint: `${CANARY_ENDPOINT}/bucket` },
      { ...settings.s3, endpoint: `https://user:pass@objects.example.test` },
      { ...settings.s3, endpoint: `${CANARY_ENDPOINT}?query=1` },
      { ...settings.s3, endpoint: `${CANARY_ENDPOINT}#fragment` },
      { ...settings.s3, timeoutMs: 0 },
      { ...settings.s3, timeoutMs: 120_001 },
    ]) {
      expect(() => createEvidenceStore({
        settings: { ...settings, s3 },
        credentials: staticCredentials(),
        createS3Client: () => fake,
      })).toThrow(EVIDENCE_S3_PROVIDER_CONFIG_ERROR);
    }
  });
});

describe("createEvidenceStore readiness and sources", () => {
  it("pings through HeadBucket on the injected client and fails closed without a network", async () => {
    const fake = new FakeS3Client("war-room-evidence");
    const store = createEvidenceStore({
      settings: loadS3Settings(),
      credentials: staticCredentials(),
      createS3Client: () => fake,
    });
    await store.ping();
    fake.bucketExists = false;
    await expect(store.ping()).rejects.toBeInstanceOf(S3EvidenceError);
    try {
      await store.ping();
    } catch (error) {
      expectSanitized(error);
    }
  });

  it("keeps send-only injected clients compatible with streamed intake", async () => {
    const fake = new FakeS3Client("war-room-evidence");
    const store = createEvidenceStore({
      settings: loadS3Settings(),
      credentials: staticCredentials(),
      createS3Client: () => fake,
    });
    const stage = await store.stageStream(
      (async function* (): AsyncIterable<Uint8Array> {
        yield new Uint8Array([1, 2, 3]);
      })(),
      { maxBytes: 3, expectedLength: 3, contentType: "text/plain" },
    );
    expect(stage.meta.byteLength).toBe(3);
    expect(fake.putKeys).toHaveLength(1);
    expect(fake.putBytes).toEqual([3]);
  });

  it("constructs the S3 client once and leaves reference sources to the caller, once each", async () => {
    const fake = new FakeS3Client("war-room-evidence");
    let constructed = 0;
    const store = createEvidenceStore({
      settings: loadS3Settings(),
      credentials: staticCredentials(),
      createS3Client: () => {
        constructed += 1;
        return fake;
      },
    });
    expect(constructed).toBe(1);
    await expect(store.recoverUnreferencedWrites()).rejects.toThrow(
      /referenced content hashes are required/,
    );
    const loaders: string[] = [];
    store.addReferencedContentHashSource(async () => {
      loaders.push("cases");
      return [];
    });
    store.addReferencedContentHashSource(async () => {
      loaders.push("runs");
      return [];
    });
    await store.recoverUnreferencedWrites();
    expect(loaders).toEqual(["cases", "runs"]);
    expect(constructed).toBe(1);
  });
});

describe("createEvidenceStore response-body idle deadline", () => {
  it("passes validated timeoutMs as responseBodyIdleTimeoutMs, keeps Smithy header timeouts, and forwards abortSignal", async () => {
    const fake = new FakeS3Client("war-room-evidence");
    const handlers: EvidenceS3RequestHandlerOptions[] = [];
    const settings = loadS3Settings(
      s3Env({ COLLAB_EVIDENCE_S3_TIMEOUT_MS: "45000" }),
    );
    const store = createEvidenceStore({
      settings,
      credentials: staticCredentials(),
      createRequestHandler: (options) => {
        handlers.push(options);
        return { kind: "idle-handler" };
      },
      createS3Client: () => fake,
    });
    expect(store).toBeInstanceOf(S3EvidenceStore);
    expect((store as S3EvidenceStore).responseBodyIdleTimeoutMs).toBe(45_000);
    expect(settings.s3.timeoutMs).toBe(45_000);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.connectionTimeout).toBe(45_000);
    expect(handlers[0]?.requestTimeout).toBe(45_000);
    expect(handlers[0]?.throwOnRequestTimeout).toBe(true);
    expect(handlers[0]).not.toHaveProperty("socketTimeout");
    expectOpaqueStore(store);

    const controller = new AbortController();
    const hash = "a".repeat(64);
    expect(await store.head(hash as never, controller.signal)).toBeNull();
    const heads = fake.calls.filter((call) => call.name === "HeadObjectCommand");
    expect(heads).toHaveLength(1);
    expect(heads[0]?.abortSignal).toBe(controller.signal);
    expectOpaqueStore(store);
  });

  it("defaults responseBodyIdleTimeoutMs to the validated settings timeout", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings();
    const store = createEvidenceStore({
      settings,
      credentials: staticCredentials(),
      createS3Client: () => fake,
    });
    expect((store as S3EvidenceStore).responseBodyIdleTimeoutMs).toBe(
      DEFAULT_EVIDENCE_S3_TIMEOUT_MS,
    );
    expect((store as S3EvidenceStore).responseBodyIdleTimeoutMs).toBe(settings.s3.timeoutMs);
  });
});

describe("createEvidenceStore redaction", () => {
  it("never projects credentials, credential file paths, endpoints, or PEM", () => {
    const fake = new FakeS3Client("war-room-evidence");
    const settings = loadS3Settings(
      s3Env({ COLLAB_EVIDENCE_S3_ENDPOINT: CANARY_ENDPOINT }),
    );
    const store = createEvidenceStore({
      settings,
      credentials: staticCredentials(),
      createS3Client: () => fake,
    });
    expectOpaqueStore(store);
    expect(DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(JSON.stringify(settings)).not.toContain(CANARY_SECRET);
    expect(JSON.stringify(settings)).not.toContain(CANARY_CRED_FILE);
  });
});
