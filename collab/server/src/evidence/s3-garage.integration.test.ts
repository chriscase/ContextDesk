import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvidenceStore } from "./provider.js";
import { loadEvidenceS3Credentials } from "./s3-secrets.js";
import {
  evidenceS3SupportedMaxUploadBytes,
  loadEvidenceStorageSettings,
} from "./s3-settings.js";
import {
  abandonS3WriteBatchForCrashTest,
  createS3ClientConfig,
  S3EvidenceError,
  S3EvidenceStore,
} from "./s3-store.js";
import { sha256Hex, type EvidenceStore } from "./store.js";

const COLLAB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPOSE_FILE = join(COLLAB_ROOT, "deploy/garage-evidence-evaluation.compose.yml");
const GARAGE_TOML_TEMPLATE = join(COLLAB_ROOT, "deploy/garage-evidence-evaluation/garage.toml");
const HARNESS_FILE = join(COLLAB_ROOT, "scripts/qualify-s3-evidence.mjs");
const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const LIVE_OPT_IN_ENV = "CONTEXTDESK_RUN_S3_LIVE";
const RPC_SECRET_PLACEHOLDER = "replace-with-64-hex-characters";
const CONTROL_PREFIX = "cd-s3-garage-eval-";
const FILE_REF_URI = "https://files.example.test/eval/app.log";
const AWS_DEFAULT_CHAIN_ENV_NAMES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCESS_KEY",
  "AWS_SECRET_KEY",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_METADATA_SERVICE_TIMEOUT",
  "AWS_METADATA_SERVICE_NUM_ATTEMPTS",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_CA_BUNDLE",
] as const;
const streamingProviderAvailable =
  typeof (S3EvidenceStore.prototype as unknown as Record<string, unknown>).stageStream ===
    "function" &&
  typeof (S3EvidenceStore.prototype as unknown as Record<string, unknown>).openRead ===
    "function";

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "";
}

function isLiveOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_OPT_IN_ENV] === "1";
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function ipv4Parts(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return null;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts;
}

function isUniqueLocalIpv6(host: string): boolean {
  const firstHextet = host.split(":", 1)[0];
  if (!/^[0-9a-f]{1,4}$/u.test(firstHextet)) return false;
  const value = Number.parseInt(firstHextet, 16);
  return value >= 0xfc00 && value <= 0xfdff;
}

function classifyEndpoint(endpoint: string): { class: "loopback" | "private" | "forbidden"; reason: string } {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    return { class: "forbidden", reason: "endpoint missing" };
  }
  const value = endpoint.trim();
  if (/\s/u.test(value) || value.includes("@")) {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { class: "forbidden", reason: "endpoint invalid" };
  }
  const host = stripIpv6Brackets(url.hostname).toLowerCase();
  if (
    host === "s3.amazonaws.com" ||
    host.endsWith(".amazonaws.com") ||
    host.endsWith(".amazonaws.com.cn")
  ) {
    return { class: "forbidden", reason: "aws-managed endpoint refused" };
  }
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return { class: "loopback", reason: "ok" };
  }
  const parts = ipv4Parts(host);
  if (parts) {
    if (parts[0] === 127) return { class: "loopback", reason: "ok" };
    if (parts[0] === 10) return { class: "private", reason: "ok" };
    if (parts[0] === 192 && parts[1] === 168) return { class: "private", reason: "ok" };
    if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) {
      return { class: "private", reason: "ok" };
    }
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  if (host.includes(":")) {
    if (host === "::1") return { class: "loopback", reason: "ok" };
    if (isUniqueLocalIpv6(host)) {
      return { class: "private", reason: "ok" };
    }
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  return { class: "forbidden", reason: "endpoint is not loopback or private" };
}

function isLoopbackOrPrivateEndpoint(endpoint: string): boolean {
  const classified = classifyEndpoint(endpoint);
  return classified.class === "loopback" || classified.class === "private";
}

function collabStaticCredsPresent(env: NodeJS.ProcessEnv): boolean {
  const access =
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID") ||
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE") ||
    present(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF");
  const secret =
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY") ||
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE") ||
    present(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF");
  return Boolean(access && secret);
}

function evaluateLiveSafety(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason: string;
  endpointClass?: string;
} {
  if (!isLiveOptIn(env)) {
    return { ok: false, reason: "opt-in required (CONTEXTDESK_RUN_S3_LIVE=1)" };
  }
  const mode = (env.COLLAB_EVIDENCE_S3_CREDENTIALS_MODE ?? "").trim();
  if (mode === "default_chain") {
    return { ok: false, reason: "default_chain credentials are refused" };
  }
  if (mode !== "static") {
    return { ok: false, reason: "credentials mode must be static" };
  }
  if (!collabStaticCredsPresent(env)) {
    if (
      present(env, "AWS_ACCESS_KEY_ID") ||
      present(env, "AWS_SECRET_ACCESS_KEY") ||
      present(env, "AWS_PROFILE")
    ) {
      return { ok: false, reason: "AWS default-chain credentials are refused" };
    }
    return { ok: false, reason: "static COLLAB_EVIDENCE_S3 credentials required" };
  }
  const endpoint = (env.COLLAB_EVIDENCE_S3_ENDPOINT ?? "").trim();
  const classified = classifyEndpoint(endpoint);
  if (classified.class === "forbidden") {
    return { ok: false, reason: classified.reason };
  }
  if (endpoint.toLowerCase().startsWith("http://") && env.COLLAB_EVIDENCE_S3_ALLOW_HTTP !== "1") {
    return { ok: false, reason: "HTTP endpoint requires COLLAB_EVIDENCE_S3_ALLOW_HTTP=1" };
  }
  if (!present(env, "COLLAB_EVIDENCE_S3_BUCKET")) {
    return { ok: false, reason: "bucket required" };
  }
  if (!present(env, "COLLAB_EVIDENCE_S3_REGION")) {
    return { ok: false, reason: "region required" };
  }
  return { ok: true, reason: "ok", endpointClass: classified.class };
}

function isolateAwsDefaultChainEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of AWS_DEFAULT_CHAIN_ENV_NAMES) {
    delete env[name];
  }
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_SDK_LOAD_CONFIG = "0";
  return env;
}

function sanitizeText(text: string, secrets: string[] = []): string {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/Credential=[^,\s]+/g, "Credential=[redacted]");
  out = out.replace(/Signature=[A-Za-z0-9/+=]+/g, "Signature=[redacted]");
  return out;
}

function harnessEvaluateLiveSafety(env: NodeJS.ProcessEnv): { ok: boolean; reason: string } {
  const href = pathToFileURL(HARNESS_FILE).href;
  const script = `
    import { evaluateLiveSafety } from ${JSON.stringify(href)};
    process.stdout.write(JSON.stringify(evaluateLiveSafety(${JSON.stringify(env)})));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: isolateAwsDefaultChainEnv({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    }),
  });
  return JSON.parse(stdout) as { ok: boolean; reason: string };
}

function liveOptInEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [LIVE_OPT_IN_ENV]: "1",
    COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:3900",
    COLLAB_EVIDENCE_S3_REGION: "garage",
    COLLAB_EVIDENCE_S3_BUCKET: "cd-evidence-eval",
    COLLAB_EVIDENCE_S3_PREFIX: "evalfixture",
    COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "GKsyntheticaccesskey",
    COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: "synthetic-secret-value",
    ...overrides,
  };
}

function expectSanitized(error: unknown, extra: string[] = []): void {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  expect(text).not.toContain("http://");
  expect(text).not.toContain("https://");
  expect(text).not.toContain("blobs/");
  expect(text).not.toContain(FILE_REF_URI);
  for (const value of extra) {
    if (value.length >= 4) expect(text).not.toContain(value);
  }
}

describe("S3 Garage live qualification gates", () => {
  it("treats only CONTEXTDESK_RUN_S3_LIVE=1 as opt-in", () => {
    expect(isLiveOptIn({})).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "true" })).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "yes" })).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "1" })).toBe(true);
  });

  it("fails closed without opt-in and does not accept AWS defaults as a substitute", () => {
    expect(evaluateLiveSafety({}).ok).toBe(false);
    expect(evaluateLiveSafety({ [LIVE_OPT_IN_ENV]: "true" }).ok).toBe(false);
    const refused = evaluateLiveSafety({
      [LIVE_OPT_IN_ENV]: "1",
      COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.0.0.1:3900",
      COLLAB_EVIDENCE_S3_REGION: "garage",
      COLLAB_EVIDENCE_S3_BUCKET: "cd-evidence-eval",
      COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
      COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
      AWS_ACCESS_KEY_ID: "aws-default-id-synthetic",
      AWS_SECRET_ACCESS_KEY: "aws-default-chain-secret",
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/static COLLAB_EVIDENCE_S3|AWS default-chain/);
  });

  it("refuses default_chain, AWS-managed endpoints, and public hosts", () => {
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "default_chain" }),
      ).reason,
    ).toMatch(/default_chain/);
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "https://s3.amazonaws.com" }),
      ).ok,
    ).toBe(false);
    expect(classifyEndpoint("https://s3.amazonaws.com").class).toBe("forbidden");
    expect(classifyEndpoint("https://bucket.s3.us-east-1.amazonaws.com").reason).toMatch(
      /aws-managed/,
    );
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "https://objects.example.test" }),
      ).ok,
    ).toBe(false);
    expect(isLoopbackOrPrivateEndpoint("https://8.8.8.8")).toBe(false);
  });

  it("accepts loopback and RFC1918 endpoints only with static credentials", () => {
    expect(evaluateLiveSafety(liveOptInEnv()).ok).toBe(true);
    expect(evaluateLiveSafety(liveOptInEnv()).endpointClass).toBe("loopback");
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://10.0.0.8:3900" }),
      ).endpointClass,
    ).toBe("private");
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://192.168.1.10:3900" }),
      ).endpointClass,
    ).toBe("private");
    expect(
      evaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://172.16.4.2:3900" }),
      ).endpointClass,
    ).toBe("private");
    expect(isLoopbackOrPrivateEndpoint("http://127.0.0.1:3900")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://localhost:3900")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://[::1]:3900")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://[fd12::1]:3900")).toBe(true);
    expect(isLoopbackOrPrivateEndpoint("http://[fc::1]:3900")).toBe(false);
    expect(isLoopbackOrPrivateEndpoint("http://127.999.0.1:3900")).toBe(false);
  });

  it("requires HTTP opt-in for loopback http:// endpoints", () => {
    const result = evaluateLiveSafety(
      liveOptInEnv({ COLLAB_EVIDENCE_S3_ALLOW_HTTP: "0" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ALLOW_HTTP/);
  });

  it("strips AWS default-chain environment names and does not copy their values", () => {
    const isolated = isolateAwsDefaultChainEnv({
      AWS_ACCESS_KEY_ID: "aws-default-id-synthetic",
      AWS_SECRET_ACCESS_KEY: "aws-default-chain-secret",
      AWS_PROFILE: "default",
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: "GKkeep",
      PATH: process.env.PATH,
    });
    for (const name of AWS_DEFAULT_CHAIN_ENV_NAMES) {
      if (name === "AWS_SDK_LOAD_CONFIG") continue;
      expect(isolated[name], name).toBeUndefined();
    }
    expect(isolated.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(isolated.AWS_SDK_LOAD_CONFIG).toBe("0");
    expect(isolated.COLLAB_EVIDENCE_S3_ACCESS_KEY_ID).toBe("GKkeep");
    expect(JSON.stringify(isolated)).not.toContain("aws-default-id-synthetic");
    expect(JSON.stringify(isolated)).not.toContain("aws-default-chain-secret");
  });

  it("redacts credentials and signature material", () => {
    const secret = "super-secret-eval-value";
    const redacted = sanitizeText(
      `Credential=GKabc/garage, Signature=abcdef1234 secret=${secret}`,
      [secret],
    );
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("Credential=[redacted]");
    expect(redacted).toContain("Signature=[redacted]");
  });
});

describe("S3 Garage evaluation compose fixture", () => {
  it("pins Garage v2.3.0, loopback S3, named volumes, health, and no credentials", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const toml = readFileSync(GARAGE_TOML_TEMPLATE, "utf8");
    expect(compose).toContain(GARAGE_IMAGE);
    expect(compose).toMatch(/127\.0\.0\.1:3900:3900/);
    expect(compose).not.toMatch(/3901:3901/);
    expect(compose).not.toMatch(/3902:3902/);
    expect(compose).not.toMatch(/3903:3903/);
    expect(compose).toMatch(/garage-evidence-eval-meta/);
    expect(compose).toMatch(/garage-evidence-eval-data/);
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).toMatch(/--single-node/);
    expect(compose).toMatch(/--default-bucket/);
    expect(toml).toContain(RPC_SECRET_PLACEHOLDER);
    expect(toml).not.toMatch(/rpc_secret\s*=\s*"[0-9a-f]{64}"/);
    expect(toml).not.toMatch(/\[admin\]/);
    expect(toml).not.toMatch(/\[s3_web\]/);
    expect(join(COLLAB_ROOT, "deploy/garage-evidence-evaluation.compose.yml")).toBe(
      COMPOSE_FILE,
    );
  });

  it("keeps the harness fail-closed and free of committed secrets", () => {
    const harness = readFileSync(HARNESS_FILE, "utf8");
    expect(harness).toContain(LIVE_OPT_IN_ENV);
    expect(harness).toContain("AWS_EC2_METADATA_DISABLED");
    expect(harness).not.toMatch(/AKIA[A-Z0-9]{16}/);
    expect(harness).not.toMatch(/rpc_secret\s*=\s*"[0-9a-f]{64}"/);
    expect(harness).toMatch(/default_chain credentials are refused/);
  });

  it("loads the harness module and fail-closes on AWS-managed endpoints", () => {
    const result = harnessEvaluateLiveSafety(
      liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "https://s3.amazonaws.com" }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/aws-managed|not loopback or private/);
    const accepted = harnessEvaluateLiveSafety(liveOptInEnv());
    expect(accepted.ok).toBe(true);
    expect(
      harnessEvaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://127.999.0.1:3900" }),
      ).ok,
    ).toBe(false);
    expect(
      harnessEvaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://[fc::1]:3900" }),
      ).ok,
    ).toBe(false);
    expect(
      harnessEvaluateLiveSafety(
        liveOptInEnv({ COLLAB_EVIDENCE_S3_ENDPOINT: "http://[fd12::1]:3900" }),
      ).ok,
    ).toBe(true);
  });
});

const live = isLiveOptIn();

let controlRoot: string | undefined;
let store: S3EvidenceStore | undefined;
let isoStore: S3EvidenceStore | undefined;
let objectPrefix: string | undefined;
let isoPrefix: string | undefined;
let bucket = "";
let endpoint = "";
let accessKeyId = "";
let secretAccessKey = "";
let rangeClient: S3Client | undefined;

describe.skipIf(!live)("S3EvidenceStore live Garage qualification", () => {
  beforeAll(async () => {
    for (const name of AWS_DEFAULT_CHAIN_ENV_NAMES) {
      delete process.env[name];
    }
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    process.env.AWS_SDK_LOAD_CONFIG = "0";

    const safety = evaluateLiveSafety(process.env);
    if (!safety.ok) {
      throw new Error(`live qualification fail closed: ${safety.reason}`);
    }

    controlRoot = await mkdtemp(join(tmpdir(), CONTROL_PREFIX));
    objectPrefix = (process.env.COLLAB_EVIDENCE_S3_PREFIX ?? `eval${randomBytes(6).toString("hex")}`)
      .trim()
      .replace(/\/+$/u, "");
    isoPrefix = (process.env.CONTEXTDESK_S3_LIVE_ISOLATION_PREFIX ?? `iso${randomBytes(6).toString("hex")}`)
      .trim()
      .replace(/\/+$/u, "");
    const env = qualificationEnv(objectPrefix);
    const settings = loadEvidenceStorageSettings(env, {
      controlRoot,
      storage: "sqlite",
    });
    const credentials = loadEvidenceS3Credentials(env);
    if (settings.provider !== "s3" || credentials.mode !== "static") {
      throw new Error("factory-compatible live config must be static s3");
    }
    expect(settings.maxUploadBytes).toBe(
      Number.parseInt(env.COLLAB_EVIDENCE_MAX_UPLOAD_BYTES ?? "", 10),
    );
    expect(settings.maxUploadBytes).toBeLessThanOrEqual(
      evidenceS3SupportedMaxUploadBytes(settings.s3.timeoutMs),
    );
    const created = createEvidenceStore({ settings, credentials });
    if (!(created instanceof S3EvidenceStore)) {
      throw new Error("expected S3EvidenceStore from factory");
    }
    store = created;
    bucket = settings.s3.bucket;
    endpoint = settings.s3.endpoint;
    accessKeyId = credentials.accessKeyId();
    secretAccessKey = credentials.secretAccessKey();
    const isoEnv = qualificationEnv(isoPrefix);
    const isoSettings = loadEvidenceStorageSettings(isoEnv, {
      controlRoot,
      storage: "sqlite",
    });
    const isoCreds = loadEvidenceS3Credentials(isoEnv);
    const isoCreated = createEvidenceStore({
      settings: isoSettings,
      credentials: isoCreds,
    });
    if (!(isoCreated instanceof S3EvidenceStore)) {
      throw new Error("expected S3EvidenceStore from factory");
    }
    isoStore = isoCreated;
    const clientConfig = createS3ClientConfig({
      bucket,
      region: settings.s3.region,
      endpoint: settings.s3.endpoint,
      forcePathStyle: settings.s3.forcePathStyle,
      accessKeyId,
      secretAccessKey,
    });
    if (!clientConfig.credentials) {
      throw new Error("refusing default credential chain");
    }
    clientConfig.maxAttempts = 3;
    clientConfig.requestHandler = new NodeHttpHandler({
      connectionTimeout: settings.s3.timeoutMs,
      requestTimeout: settings.s3.timeoutMs,
      throwOnRequestTimeout: true,
    });
    rangeClient = new S3Client(clientConfig);
  }, 60_000);

  afterAll(async () => {
    let cleanupFailed = false;
    try {
      if (store && objectPrefix) {
        await store.deletePrefix("teardown", `${objectPrefix}/`);
      }
    } catch {
      cleanupFailed = true;
    }
    try {
      if (isoStore && isoPrefix) {
        await isoStore.deletePrefix("teardown", `${isoPrefix}/`);
      }
    } catch {
      cleanupFailed = true;
    }
    rangeClient?.destroy();
    if (controlRoot) await rm(controlRoot, { recursive: true, force: true });
    if (cleanupFailed) {
      throw new Error("disposable S3 evaluation prefix cleanup failed");
    }
  }, 60_000);

  it("pings with HeadBucket through the factory-built store", async () => {
    await liveStore().ping();
    expect(liveStore().writeCoordination).toBe("single_process");
  });

  it("puts, heads, gets, and verifies exact bytes", async () => {
    const bytes = payload("put-head-get-verify");
    const meta = await liveStore().put(bytes, { contentType: "text/plain" });
    expect(meta.hash).toBe(sha256Hex(bytes));
    expect(meta.byteLength).toBe(bytes.byteLength);
    const head = await liveStore().head(meta.hash);
    expect(head).toEqual(meta);
    const got = await liveStore().get(meta.hash);
    expect(got).not.toBeNull();
    expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(await liveStore().verify(meta.hash)).toBe(true);
  });

  it("reads an exact inclusive byte range via GetObject (not openRead)", async () => {
    const bytes = payload("exact-byte-range-abcdefghijklmnop");
    const meta = await liveStore().put(bytes);
    const key = liveStore().blobKey(meta.hash);
    if (!rangeClient) throw new Error("range client was not created");
    const output = await rangeClient.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: "bytes=0-6",
      }),
    );
    const body = output.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body || typeof body.transformToByteArray !== "function") {
      throw new Error("range get returned no body");
    }
    const ranged = await body.transformToByteArray();
    expect(Buffer.from(ranged).equals(Buffer.from(bytes.slice(0, 7)))).toBe(true);
    expect(ranged.byteLength).toBe(7);
  });

  it("stages, commits, and rolls back without exposing staging as canonical", async () => {
    const bytes = payload("stage-commit-rollback");
    const stage = await liveStore().stage(bytes, { contentType: "text/plain" });
    try {
      expect(await liveStore().head(stage.meta.hash)).toBeNull();
      await stage.commit();
      expect(await liveStore().verify(stage.meta.hash)).toBe(true);
      await stage.rollback();
      expect(await liveStore().head(stage.meta.hash)).toBeNull();
    } finally {
      stage.release();
    }
  });

  it("promotes, finalizes, and rolls back write batches with journal recovery", async () => {
    const kept = await liveStore().put(payload("batch-kept"));
    const finalizedBytes = payload("batch-finalize");
    const finalizeBatch = await liveStore().beginWriteBatch();
    const finalized = await finalizeBatch.put(finalizedBytes);
    expect(await liveStore().head(finalized.hash)).toBeNull();
    await finalizeBatch.promote();
    expect(await liveStore().verify(finalized.hash)).toBe(true);
    await finalizeBatch.finalize();
    expect(await liveStore().verify(finalized.hash)).toBe(true);

    const rolledBytes = payload("batch-rollback");
    const rollbackBatch = await liveStore().beginWriteBatch();
    const rolled = await rollbackBatch.put(rolledBytes);
    await rollbackBatch.promote();
    expect(await liveStore().verify(rolled.hash)).toBe(true);
    await rollbackBatch.rollback();
    expect(await liveStore().head(rolled.hash)).toBeNull();
    expect(await liveStore().verify(kept.hash)).toBe(true);

    const crashBytes = payload("batch-crash-journal");
    const crashBatch = await liveStore().beginWriteBatch();
    const crashed = await crashBatch.put(crashBytes);
    await crashBatch.promote();
    await abandonS3WriteBatchForCrashTest(crashBatch);
    const recovered = await liveStore().recoverUnreferencedWrites(new Set([kept.hash, finalized.hash]));
    expect(recovered.journals).toBeGreaterThanOrEqual(1);
    expect(recovered.reclaimed).toContain(crashed.hash);
    expect(await liveStore().head(crashed.hash)).toBeNull();
    expect(await liveStore().verify(kept.hash)).toBe(true);
  });

  it("is duplicate-safe for identical content-addressed puts", async () => {
    const bytes = payload("duplicate-safety");
    const first = await liveStore().put(bytes);
    const second = await liveStore().put(bytes);
    expect(second.hash).toBe(first.hash);
    expect(await liveStore().verify(first.hash)).toBe(true);
    const got = await liveStore().get(first.hash);
    expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
  });

  it("round-trips file-server references without fetching the URI", async () => {
    const remote = payload("file-ref-target");
    const created = await liveStore().putFileServerReference({
      uri: FILE_REF_URI,
      expectedHash: sha256Hex(remote),
      verificationStatus: "unverified",
    });
    expect(created.uri).toBe(FILE_REF_URI);
    expect(await liveStore().getFileServerReference(created.id)).toEqual(created);
    const verified = await liveStore().verifyFileServerReference(created.id, remote);
    expect(verified.verificationStatus).toBe("verified");
    const mismatched = await liveStore().verifyFileServerReference(
      created.id,
      payload("file-ref-other"),
    );
    expect(mismatched.verificationStatus).toBe("unverified");
    await liveStore().abandonFileServerReference(created.id);
    expect(await liveStore().getFileServerReference(created.id)).toBeNull();
  });

  it("isolates object prefixes on the same bucket", async () => {
    const bytes = payload("prefix-isolation");
    const meta = await liveStore().put(bytes);
    expect(await liveIsoStore().head(meta.hash)).toBeNull();
    expect(await liveIsoStore().get(meta.hash)).toBeNull();
    const isoBytes = payload("prefix-isolation-other");
    const isoMeta = await liveIsoStore().put(isoBytes);
    expect(await liveStore().head(isoMeta.hash)).toBeNull();
    expect(await liveStore().verify(meta.hash)).toBe(true);
    expect(await liveIsoStore().verify(isoMeta.hash)).toBe(true);
  });

  it("fails closed on unauthorized static credentials without leaking secrets", async () => {
    const deniedAccess = `GK${randomBytes(16).toString("hex")}`;
    const deniedSecret = randomBytes(32).toString("hex");
    const deniedEnv = qualificationEnv(requiredPrefix(), {
      COLLAB_EVIDENCE_S3_ACCESS_KEY_ID: deniedAccess,
      COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY: deniedSecret,
      COLLAB_EVIDENCE_S3_TIMEOUT_MS: "3000",
    });
    const deniedStore = createEvidenceStore({
      settings: loadEvidenceStorageSettings(deniedEnv, {
        controlRoot: requiredControlRoot(),
        storage: "sqlite",
      }),
      credentials: loadEvidenceS3Credentials(deniedEnv),
    });
    try {
      await deniedStore.ping();
      throw new Error("expected unauthorized ping to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(S3EvidenceError);
      expectSanitized(error, [deniedAccess, deniedSecret, endpoint, bucket, accessKeyId, secretAccessKey]);
    }
  });

  it.skipIf(streamingProviderAvailable)(
    "truthfully identifies the S3EvidenceStore stageStream/openRead provider gap",
    () => {
      const streaming = liveStore() as { stageStream?: unknown; openRead?: unknown };
      expect(typeof streaming.stageStream).toBe("undefined");
      expect(typeof streaming.openRead).toBe("undefined");
      expect(typeof liveStore().stage).toBe("function");
      expect(typeof liveStore().beginWriteBatch).toBe("function");
    },
  );

  it.skipIf(!streamingProviderAvailable)(
    "streams staged bytes and opens verified full and inclusive range reads when supported",
    async () => {
      const streaming = streamingLiveStore();
      const chunks = [
        new TextEncoder().encode("garage-stream-alpha|"),
        new TextEncoder().encode("bravo|"),
        new TextEncoder().encode(`charlie:${randomUUID()}\n`),
      ];
      const bytes = concatBytes(chunks);
      const stage = await streaming.stageStream(asAsyncChunks(chunks), {
        maxBytes: bytes.byteLength,
        expectedLength: bytes.byteLength,
        contentType: "text/plain",
      });
      expect(stage.meta.hash).toBe(sha256Hex(bytes));
      expect(stage.meta.byteLength).toBe(bytes.byteLength);
      expect(await streaming.head(stage.meta.hash)).toBeNull();

      await stage.promote();
      const full = await streaming.openRead(stage.meta.hash);
      expect(full.range).toBeNull();
      expect(full.byteLength).toBe(bytes.byteLength);
      expect(Buffer.from(await collectChunks(full.bytes())).equals(Buffer.from(bytes))).toBe(true);

      const start = 3;
      const end = Math.min(bytes.byteLength - 1, 17);
      const ranged = await streaming.openRead(stage.meta.hash, { start, end });
      expect(ranged.range).toEqual({ start, end });
      expect(ranged.byteLength).toBe(end - start + 1);
      expect(
        Buffer.from(await collectChunks(ranged.bytes())).equals(
          Buffer.from(bytes.slice(start, end + 1)),
        ),
      ).toBe(true);

      await stage.finalize();
    },
  );

  it.skipIf(!present(process.env, "CONTEXTDESK_S3_LIVE_COMPOSE_FILE"))(
    "persists canonical bytes across a compose restart",
    async () => {
      const bytes = payload("restart-persistence");
      const meta = await liveStore().put(bytes);
      await restartEvaluationGarage([accessKeyId, secretAccessKey, endpoint, bucket]);
      const restarted = createEvidenceStore({
        settings: loadEvidenceStorageSettings(qualificationEnv(requiredPrefix()), {
          controlRoot: requiredControlRoot(),
          storage: "sqlite",
        }),
        credentials: loadEvidenceS3Credentials(qualificationEnv(requiredPrefix())),
      });
      expect(await restarted.verify(meta.hash)).toBe(true);
      const got = await restarted.get(meta.hash);
      expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
    },
    120_000,
  );
});

function qualificationEnv(
  prefix: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COLLAB_EVIDENCE_PROVIDER: "s3",
    COLLAB_EVIDENCE_S3_ENDPOINT: requiredLive("COLLAB_EVIDENCE_S3_ENDPOINT"),
    COLLAB_EVIDENCE_S3_REGION: process.env.COLLAB_EVIDENCE_S3_REGION?.trim() || "garage",
    COLLAB_EVIDENCE_S3_BUCKET: requiredLive("COLLAB_EVIDENCE_S3_BUCKET"),
    COLLAB_EVIDENCE_S3_PREFIX: prefix,
    COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE: "1",
    COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_TIMEOUT_MS: process.env.COLLAB_EVIDENCE_S3_TIMEOUT_MS ?? "8000",
  };
  for (const name of [
    "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID",
    "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE",
    "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF",
    "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY",
    "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE",
    "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF",
    "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
    "COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE",
    "COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF",
  ] as const) {
    if (present(process.env, name)) env[name] = process.env[name];
  }
  const qualified = { ...env, ...overrides };
  if (!present(qualified, "COLLAB_EVIDENCE_MAX_UPLOAD_BYTES")) {
    const timeoutMs = Number.parseInt(
      qualified.COLLAB_EVIDENCE_S3_TIMEOUT_MS ?? "",
      10,
    );
    qualified.COLLAB_EVIDENCE_MAX_UPLOAD_BYTES = String(
      evidenceS3SupportedMaxUploadBytes(timeoutMs),
    );
  }
  return qualified;
}

function requiredLive(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`live qualification fail closed: ${name} required`);
  return value;
}

function payload(label: string): Uint8Array {
  return new TextEncoder().encode(`${label}:${randomUUID()}\n`);
}

function liveStore(): S3EvidenceStore {
  if (!store) throw new Error("live S3EvidenceStore was not created");
  return store;
}

function liveIsoStore(): S3EvidenceStore {
  if (!isoStore) throw new Error("live isolation S3EvidenceStore was not created");
  return isoStore;
}

function streamingLiveStore(): S3EvidenceStore & Pick<EvidenceStore, "stageStream" | "openRead"> {
  const candidate = liveStore() as S3EvidenceStore & Partial<
    Pick<EvidenceStore, "stageStream" | "openRead">
  >;
  if (typeof candidate.stageStream !== "function" || typeof candidate.openRead !== "function") {
    throw new Error("S3EvidenceStore streaming provider correction is not available");
  }
  return candidate as S3EvidenceStore & Pick<EvidenceStore, "stageStream" | "openRead">;
}

async function* asAsyncChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function collectChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return concatBytes(chunks);
}

function requiredPrefix(): string {
  if (!objectPrefix) throw new Error("live object prefix was not created");
  return objectPrefix;
}

function requiredControlRoot(): string {
  if (!controlRoot) throw new Error("live control root was not created");
  return controlRoot;
}

function restartEvaluationGarage(secrets: string[]): Promise<void> {
  const file = process.env.CONTEXTDESK_S3_LIVE_COMPOSE_FILE;
  const project = process.env.CONTEXTDESK_S3_LIVE_COMPOSE_PROJECT;
  const workdir = process.env.CONTEXTDESK_S3_LIVE_COMPOSE_WORKDIR;
  if (!file || !project || !workdir) {
    return Promise.reject(new Error("compose restart is not configured"));
  }
  const args = [
    "compose",
    "-f",
    file,
    "--project-directory",
    workdir,
    "-p",
    project,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args, "restart", "garage"], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolateAwsDefaultChainEnv(process.env),
    });
    let combined = "";
    child.stdout.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      combined += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(sanitizeText(`compose restart exited ${code}: ${combined}`, secrets)));
        return;
      }
      waitForGarageStatus(args, workdir, secrets).then(resolve, reject);
    });
  });
}

function waitForGarageStatus(
  composeArgs: string[],
  workdir: string,
  secrets: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      const child = spawn("docker", [...composeArgs, "exec", "-T", "garage", "/garage", "status"], {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        env: isolateAwsDefaultChainEnv(process.env),
      });
      let combined = "";
      child.stdout.on("data", (chunk: Buffer) => {
        combined += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        combined += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        if (attempts >= 20) {
          reject(new Error(sanitizeText(`Garage did not become ready after restart: ${combined}`, secrets)));
          return;
        }
        setTimeout(tick, 2000);
      });
    };
    tick();
  });
}
