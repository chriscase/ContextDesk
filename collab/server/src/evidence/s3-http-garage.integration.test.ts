/**
 * Opt-in live HTTP -> real Garage S3 qualification.
 *
 * Default (no CONTEXTDESK_RUN_S3_LIVE=1): live cases skip truthfully.
 * Opt-in: missing or unreachable Garage/endpoint/credentials fail closed.
 *
 * This is not a retention, migration, HA, TLS, multi-replica, broader scratch
 * GC, or production-qualification claim. Cleanup is limited to this run's
 * generated prefix. Client abort is a real HTTP destroy, not a route fake.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  parseEvidenceList,
  parseEvidenceUploadSuccess,
} from "@cd-collab/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { testConfig } from "../config.js";
import { createSqliteRuntime } from "../db/sqlite.js";
import {
  createAuthLog,
  createRateLimiter,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  defaultSessionPolicy,
  MapAuthAdapter,
} from "../modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../modules/authz/index.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { createEvidenceStore } from "./provider.js";
import { loadEvidenceS3Credentials } from "./s3-secrets.js";
import { loadEvidenceStorageSettings } from "./s3-settings.js";
import { createS3ClientConfig, S3EvidenceStore } from "./s3-store.js";
import { sha256Hex } from "./store.js";

const COLLAB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const HARNESS_FILE = join(COLLAB_ROOT, "scripts/qualify-s3-evidence.mjs");
const LIVE_OPT_IN_ENV = "CONTEXTDESK_RUN_S3_LIVE";
const CONTROL_PREFIX = "cd-s3-http-garage-eval-";
const ALICE = "fixture-alice-secret";
const NATIVE_FILENAME = "synthetic-http-garage.bin";
const NATIVE_MEDIA_TYPE = "application/octet-stream";
const PAYLOAD_BYTE_LENGTH = 2 * 1024 * 1024 + 17;
const RANGE_PREFIX_END = 1023;
const RANGE_SUFFIX_LEN = 1024;
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
const ROLE_MAP =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

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
    if (parts[1] !== undefined && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
      return { class: "private", reason: "ok" };
    }
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  if (host.includes(":")) {
    if (host === "::1") return { class: "loopback", reason: "ok" };
    if (isUniqueLocalIpv6(host)) return { class: "private", reason: "ok" };
    return { class: "forbidden", reason: "endpoint is not loopback or private" };
  }
  return { class: "forbidden", reason: "endpoint is not loopback or private" };
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
  return { ok: true, reason: "ok" };
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

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

function generatedPrefix(kind: "http" | "abort"): string {
  return `${kind}eval${randomBytes(6).toString("hex")}`;
}

function qualificationEnv(prefix: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COLLAB_EVIDENCE_PROVIDER: "s3",
    COLLAB_EVIDENCE_S3_ENDPOINT: requiredLive("COLLAB_EVIDENCE_S3_ENDPOINT"),
    COLLAB_EVIDENCE_S3_REGION: process.env.COLLAB_EVIDENCE_S3_REGION?.trim() || "garage",
    COLLAB_EVIDENCE_S3_BUCKET: requiredLive("COLLAB_EVIDENCE_S3_BUCKET"),
    COLLAB_EVIDENCE_S3_PREFIX: prefix,
    COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE: "1",
    COLLAB_EVIDENCE_S3_ALLOW_HTTP: "1",
    COLLAB_EVIDENCE_S3_CREDENTIALS_MODE: "static",
    COLLAB_EVIDENCE_S3_TIMEOUT_MS: process.env.COLLAB_EVIDENCE_S3_TIMEOUT_MS ?? "30000",
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
  return env;
}

function requiredLive(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`live HTTP qualification fail closed: ${name} required`);
  return value;
}

function deterministicPayload(byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 13 + 7) & 0xff;
  }
  return bytes;
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobObjectKey(prefix: string, hash: string): string {
  return `${prefix}/blobs/${hash.slice(0, 2)}/${hash}`;
}

function streamStagingPrefix(prefix: string): string {
  return `${prefix}/.stream-staging/`;
}

/** Native file part metadata only — no expectedLength, filename, or mediaType fields. */
function encodeNativeMultipart(
  fields: ReadonlyArray<{ name: string; value: string }>,
  file: { filename: string; mediaType: string; body: Buffer },
  boundary = "----cd-s3-http-garage",
): { payload: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`,
  ));
  chunks.push(file.body);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return typeof raw === "string" ? raw : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function nativeRequest(input: {
  method: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: input.method,
      host: "127.0.0.1",
      port: input.port,
      path: input.path,
      headers: input.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(input.timeoutMs, () => {
      req.destroy(new Error(`${input.method} ${input.path} timed out after ${input.timeoutMs}ms`));
    });
    if (input.body) req.end(input.body);
    else req.end();
  });
}

type LiveApp = Awaited<ReturnType<typeof buildApp>>;

interface LiveWorld {
  app: LiveApp;
  runtime: ReturnType<typeof createSqliteRuntime>;
  store: S3EvidenceStore;
  probe: S3Client;
  sqlitePath: string;
  controlRoot: string;
  prefix: string;
  bucket: string;
  port: number;
}

const disposablePrefixes: string[] = [];
const disposableRoots: string[] = [];

describe("S3 HTTP Garage live qualification gates", () => {
  it("treats only CONTEXTDESK_RUN_S3_LIVE=1 as opt-in", () => {
    expect(isLiveOptIn({})).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "true" })).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "yes" })).toBe(false);
    expect(isLiveOptIn({ [LIVE_OPT_IN_ENV]: "1" })).toBe(true);
  });

  it("fails closed without opt-in and does not treat AWS defaults as a substitute", () => {
    expect(evaluateLiveSafety({}).ok).toBe(false);
    expect(evaluateLiveSafety({ [LIVE_OPT_IN_ENV]: "true" }).reason).toMatch(/opt-in required/);
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
    expect(refused.reason).toMatch(/static COLLAB_EVIDENCE_S3|credentials/);
  });

  it("keeps the opt-in qualify harness pointed at this live HTTP suite", () => {
    const harness = readFileSync(HARNESS_FILE, "utf8");
    expect(harness).toContain("s3-http-garage.integration.test.ts");
    expect(harness).toContain("s3-garage.integration.test.ts");
    expect(harness).toContain(LIVE_OPT_IN_ENV);
  });
});

const live = isLiveOptIn();

describe.skipIf(!live)("live HTTP Garage S3 qualification", () => {
  beforeAll(async () => {
    for (const name of AWS_DEFAULT_CHAIN_ENV_NAMES) {
      delete process.env[name];
    }
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    process.env.AWS_SDK_LOAD_CONFIG = "0";

    const safety = evaluateLiveSafety(process.env);
    if (!safety.ok) {
      throw new Error(`live HTTP qualification fail closed: ${safety.reason}`);
    }

    const prefix = generatedPrefix("http");
    const env = qualificationEnv(prefix);
    const controlRoot = await mkdtemp(join(tmpdir(), CONTROL_PREFIX));
    disposableRoots.push(controlRoot);
    const settings = loadEvidenceStorageSettings(env, {
      controlRoot,
      storage: "sqlite",
    });
    const credentials = loadEvidenceS3Credentials(env);
    if (settings.provider !== "s3" || credentials.mode !== "static") {
      throw new Error("factory-compatible live HTTP config must be static s3");
    }
    const created = createEvidenceStore({ settings, credentials });
    if (!(created instanceof S3EvidenceStore)) {
      throw new Error("expected S3EvidenceStore from factory");
    }
    if (created.writeCoordination !== "single_process") {
      throw new Error("sqlite live HTTP qualification requires single_process write coordination");
    }
    await created.ping();
  }, 60_000);

  afterAll(async () => {
    const problems: string[] = [];
    for (const prefix of disposablePrefixes.splice(0)) {
      try {
        await deleteGeneratedPrefix(prefix);
      } catch {
        problems.push("generated-prefix");
      }
    }
    for (const root of disposableRoots.splice(0)) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        problems.push("temp-root");
      }
    }
    if (problems.length > 0) {
      throw new Error(`disposable HTTP Garage evaluation cleanup failed (${problems.join(",")})`);
    }
  }, 60_000);

  it(
    "uploads >2MiB through production HTTP, preserves native metadata, and recovers across restart",
    async () => {
      const payload = deterministicPayload(PAYLOAD_BYTE_LENGTH);
      const expectedDigest = sha256Hex(payload);
      expect(digestHex(payload)).toBe(expectedDigest);
      expect(payload.byteLength).toBeGreaterThan(2 * 1024 * 1024);

      const controlRoot = await mkdtemp(join(tmpdir(), CONTROL_PREFIX));
      disposableRoots.push(controlRoot);
      const sqlitePath = join(controlRoot, "collab.sqlite");
      const prefix = generatedPrefix("http");
      disposablePrefixes.push(prefix);

      let world = await openWorld({
        prefix,
        controlRoot,
        sqlitePath,
        transferTimeoutMs: 120_000,
      });
      let cookieHeader = "";
      let caseId = "";
      let artifactId = "";
      try {
        cookieHeader = await login(world.app);
        caseId = await createCase(world.app, cookieHeader, "HTTP Garage live upload");
        const uploaded = await streamUploadNative(world.port, cookieHeader, caseId, payload);
        expect(uploaded.schemaId).toBe("cd-collab.evidence_upload_success.v1");
        expect(uploaded.artifact.filename).toBe(NATIVE_FILENAME);
        expect(uploaded.artifact.mediaType).toBe(NATIVE_MEDIA_TYPE);
        expect(uploaded.artifact.byteLength).toBe(payload.byteLength);
        expect(uploaded.artifact.contentHash).toBe(expectedDigest);
        artifactId = uploaded.artifact.id;

        await assertIndependentS3Object(world, expectedDigest, payload);
        await assertHttpContentContract(world.port, cookieHeader, caseId, artifactId, payload, expectedDigest);
        await assertNoStreamStaging(world);
      } finally {
        await closeWorld(world, { deletePrefix: false });
      }

      world = await openWorld({
        prefix,
        controlRoot,
        sqlitePath,
        transferTimeoutMs: 120_000,
      });
      try {
        expect(world.store.writeCoordination).toBe("single_process");
        cookieHeader = await login(world.app);
        const listed = parseEvidenceList(
          JSON.parse(
            (
              await world.app.inject({
                method: "GET",
                url: `/api/cases/${caseId}/evidence`,
                headers: { cookie: cookieHeader },
              })
            ).body,
          ),
        );
        expect(listed.artifacts).toHaveLength(1);
        expect(listed.artifacts[0]?.id).toBe(artifactId);
        expect(listed.artifacts[0]?.filename).toBe(NATIVE_FILENAME);
        expect(listed.artifacts[0]?.mediaType).toBe(NATIVE_MEDIA_TYPE);
        expect(listed.artifacts[0]?.contentHash).toBe(expectedDigest);
        await assertIndependentS3Object(world, expectedDigest, payload);
        await assertHttpContentContract(world.port, cookieHeader, caseId, artifactId, payload, expectedDigest);
        await assertNoStreamStaging(world);
      } finally {
        await closeWorld(world, { deletePrefix: true });
        const idx = disposablePrefixes.indexOf(prefix);
        if (idx >= 0) disposablePrefixes.splice(idx, 1);
      }
    },
    180_000,
  );

  it(
    "aborts a real client multipart upload, restarts, and publishes neither a row nor an object",
    async () => {
      const controlRoot = await mkdtemp(join(tmpdir(), CONTROL_PREFIX));
      disposableRoots.push(controlRoot);
      const sqlitePath = join(controlRoot, "collab.sqlite");
      const prefix = generatedPrefix("abort");
      disposablePrefixes.push(prefix);
      const partial = deterministicPayload(128 * 1024);

      let world = await openWorld({
        prefix,
        controlRoot,
        sqlitePath,
        transferTimeoutMs: 10_000,
      });
      let cookieHeader = "";
      let caseId = "";
      try {
        cookieHeader = await login(world.app);
        caseId = await createCase(world.app, cookieHeader, "HTTP Garage live abort");
        await abortNativeUpload(world.port, cookieHeader, caseId, partial);
        await delay(250);
      } finally {
        await withTimeout(closeWorld(world, { deletePrefix: false }), 20_000, "abort close");
      }

      world = await openWorld({
        prefix,
        controlRoot,
        sqlitePath,
        transferTimeoutMs: 10_000,
      });
      try {
        cookieHeader = await login(world.app);
        const listed = parseEvidenceList(
          JSON.parse(
            (
              await world.app.inject({
                method: "GET",
                url: `/api/cases/${caseId}/evidence`,
                headers: { cookie: cookieHeader },
              })
            ).body,
          ),
        );
        expect(listed.artifacts).toEqual([]);
        await assertNoStreamStaging(world);
        expect(await listObjectKeys(world.probe, world.bucket, `${prefix}/blobs/`)).toEqual([]);
      } finally {
        await closeWorld(world, { deletePrefix: true });
        const idx = disposablePrefixes.indexOf(prefix);
        if (idx >= 0) disposablePrefixes.splice(idx, 1);
      }
    },
    60_000,
  );
});

async function openWorld(options: {
  prefix: string;
  controlRoot: string;
  sqlitePath: string;
  transferTimeoutMs?: number;
}): Promise<LiveWorld> {
  const env = isolateAwsDefaultChainEnv(qualificationEnv(options.prefix));
  const settings = loadEvidenceStorageSettings(env, {
    controlRoot: options.controlRoot,
    storage: "sqlite",
  });
  const credentials = loadEvidenceS3Credentials(env);
  if (settings.provider !== "s3" || credentials.mode !== "static") {
    throw new Error("live HTTP world must be static s3");
  }
  const created = createEvidenceStore({ settings, credentials });
  if (!(created instanceof S3EvidenceStore)) {
    throw new Error("expected S3EvidenceStore from factory");
  }
  const runtime = createSqliteRuntime(options.sqlitePath, parseGroupRoleMap(ROLE_MAP));
  created.addReferencedContentHashSource(() => runtime.cases.listReferencedContentHashes());
  await created.ping();
  await created.recoverUnreferencedWrites();

  const catalog = new CatalogService(runtime.catalog, runtime.audit);
  const domain = new CaseService(created, runtime.audit, runtime.cases, catalog);
  const roles = new MutableGroupRoleMap(await runtime.roleStore.load());
  const app = await buildApp({
    config: testConfig({
      storage: "sqlite",
      sqlitePath: options.sqlitePath,
      databaseUrl: null,
      migrateDatabaseUrl: null,
      evidenceRoot: options.controlRoot,
      evidence: settings,
      authMode: "local",
    }),
    pool: null,
    databaseProbe: runtime.databaseProbe,
    store: created,
    domain,
    catalog,
    ...(options.transferTimeoutMs === undefined
      ? {}
      : { evidenceTransferTimeoutMs: options.transferTimeoutMs }),
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: runtime.sessions,
        policy: defaultSessionPolicy,
        roles,
        audit: runtime.audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit: runtime.audit,
    },
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    await app.close();
    runtime.state.close();
    throw new Error("live HTTP listener did not bind a TCP port");
  }
  const port = address.port;

  const accessKeyId = credentials.accessKeyId();
  const secretAccessKey = credentials.secretAccessKey();
  const sessionToken = credentials.sessionToken();
  const clientConfig = createS3ClientConfig({
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    endpoint: settings.s3.endpoint,
    forcePathStyle: settings.s3.forcePathStyle,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
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
  return {
    app,
    runtime,
    store: created,
    probe: new S3Client(clientConfig),
    sqlitePath: options.sqlitePath,
    controlRoot: options.controlRoot,
    prefix: options.prefix,
    bucket: settings.s3.bucket,
    port,
  };
}

async function closeWorld(world: LiveWorld, options: { deletePrefix: boolean }): Promise<void> {
  let failed = false;
  try {
    if (options.deletePrefix) {
      await world.store.deletePrefix("teardown", `${world.prefix}/`);
    }
  } catch {
    failed = true;
  }
  try {
    await world.app.close();
  } catch {
    failed = true;
  }
  try {
    world.runtime.state.close();
  } catch {
    failed = true;
  }
  try {
    world.probe.destroy();
  } catch {
    failed = true;
  }
  if (failed) throw new Error("live HTTP world close failed");
}

async function login(app: LiveApp): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "alice", password: ALICE },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function createCase(app: LiveApp, cookieHeader: string, title: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: cookieHeader },
    payload: { title },
  });
  expect(created.statusCode).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

async function streamUploadNative(
  port: number,
  cookieHeader: string,
  caseId: string,
  body: Buffer,
): Promise<ReturnType<typeof parseEvidenceUploadSuccess>> {
  const encoded = encodeNativeMultipart(
    [
      { name: "kind", value: "attachment" },
      { name: "summary", value: "synthetic http garage live bytes" },
      { name: "privacyClass", value: "share_safe" },
    ],
    {
      filename: NATIVE_FILENAME,
      mediaType: NATIVE_MEDIA_TYPE,
      body,
    },
  );
  const response = await nativeRequest({
    method: "POST",
    port,
    path: `/api/cases/${caseId}/evidence/stream`,
    headers: {
      cookie: cookieHeader,
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      "content-type": encoded.contentType,
      "content-length": String(encoded.payload.byteLength),
    },
    body: encoded.payload,
    timeoutMs: 90_000,
  });
  expect(response.status).toBe(200);
  return parseEvidenceUploadSuccess(JSON.parse(response.body.toString("utf8")));
}

async function abortNativeUpload(
  port: number,
  cookieHeader: string,
  caseId: string,
  partial: Buffer,
): Promise<void> {
  const boundary = "----cd-s3-http-abort";
  const prelude = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nattachment\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="summary"\r\n\r\nabort\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="abort.bin"\r\nContent-Type: ${NATIVE_MEDIA_TYPE}\r\n\r\n`,
    ),
    partial,
  ]);
  await withTimeout(
    new Promise<void>((resolve) => {
      const req = http.request({
        method: "POST",
        host: "127.0.0.1",
        port,
        path: `/api/cases/${caseId}/evidence/stream`,
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER]: CSRF_HEADER_VALUE,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "transfer-encoding": "chunked",
        },
      });
      const done = (): void => resolve();
      req.on("error", done);
      req.on("close", done);
      req.write(prelude);
      setTimeout(() => {
        req.destroy();
      }, 50);
    }),
    8_000,
    "client multipart abort",
  );
}

async function assertHttpContentContract(
  port: number,
  cookieHeader: string,
  caseId: string,
  artifactId: string,
  payload: Buffer,
  digest: string,
): Promise<void> {
  const url = `/api/cases/${caseId}/evidence/${artifactId}/content`;
  const etag = `"${digest}"`;
  const size = payload.byteLength;
  const suffixStart = size - RANGE_SUFFIX_LEN;

  const head = await nativeRequest({
    method: "HEAD",
    port,
    path: url,
    headers: { cookie: cookieHeader },
    timeoutMs: 15_000,
  });
  expect(head.status).toBe(200);
  expect(head.body.byteLength).toBe(0);
  expect(headerValue(head.headers, "etag")).toBe(etag);
  expect(headerValue(head.headers, "accept-ranges")).toBe("bytes");
  expect(headerValue(head.headers, "content-length")).toBe(String(size));
  expect(headerValue(head.headers, "content-type")).toBe(NATIVE_MEDIA_TYPE);
  expect(headerValue(head.headers, "content-disposition")).toBe(
    `attachment; filename="${NATIVE_FILENAME}"`,
  );

  const full = await nativeRequest({
    method: "GET",
    port,
    path: url,
    headers: { cookie: cookieHeader },
    timeoutMs: 30_000,
  });
  expect(full.status).toBe(200);
  expect(full.body.byteLength).toBe(size);
  expect(full.body.equals(payload)).toBe(true);
  expect(headerValue(full.headers, "etag")).toBe(etag);
  expect(headerValue(full.headers, "content-length")).toBe(String(size));
  expect(headerValue(full.headers, "content-type")).toBe(NATIVE_MEDIA_TYPE);

  const prefix = await nativeRequest({
    method: "GET",
    port,
    path: url,
    headers: { cookie: cookieHeader, range: `bytes=0-${RANGE_PREFIX_END}` },
    timeoutMs: 15_000,
  });
  expect(prefix.status).toBe(206);
  expect(prefix.body.equals(payload.subarray(0, RANGE_PREFIX_END + 1))).toBe(true);
  expect(headerValue(prefix.headers, "content-range")).toBe(`bytes 0-${RANGE_PREFIX_END}/${size}`);
  expect(headerValue(prefix.headers, "content-length")).toBe(String(RANGE_PREFIX_END + 1));

  const suffix = await nativeRequest({
    method: "GET",
    port,
    path: url,
    headers: { cookie: cookieHeader, range: `bytes=${suffixStart}-` },
    timeoutMs: 15_000,
  });
  expect(suffix.status).toBe(206);
  expect(suffix.body.equals(payload.subarray(suffixStart))).toBe(true);
  expect(headerValue(suffix.headers, "content-range")).toBe(
    `bytes ${suffixStart}-${size - 1}/${size}`,
  );
  expect(headerValue(suffix.headers, "content-length")).toBe(String(RANGE_SUFFIX_LEN));

  const cached = await nativeRequest({
    method: "GET",
    port,
    path: url,
    headers: { cookie: cookieHeader, "if-none-match": etag },
    timeoutMs: 15_000,
  });
  expect(cached.status).toBe(304);
  expect(cached.body.byteLength).toBe(0);
  expect(headerValue(cached.headers, "etag")).toBe(etag);
}

async function assertIndependentS3Object(
  world: LiveWorld,
  digest: string,
  payload: Buffer,
): Promise<void> {
  const key = blobObjectKey(world.prefix, digest);
  const head = await world.probe.send(new HeadObjectCommand({
    Bucket: world.bucket,
    Key: key,
  }));
  expect(head.ContentLength).toBe(payload.byteLength);
  if (typeof head.ContentType === "string") {
    expect(head.ContentType).toBe(NATIVE_MEDIA_TYPE);
  }
  const got = await world.probe.send(new GetObjectCommand({
    Bucket: world.bucket,
    Key: key,
  }));
  const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error("independent GetObject returned no body");
  }
  const bytes = Buffer.from(await body.transformToByteArray());
  expect(bytes.byteLength).toBe(payload.byteLength);
  expect(bytes.equals(payload)).toBe(true);
  expect(sha256Hex(bytes)).toBe(digest);
}

async function listObjectKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const output = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1000,
  }));
  const keys: string[] = [];
  for (const entry of output.Contents ?? []) {
    if (typeof entry.Key !== "string" || !entry.Key.startsWith(prefix)) {
      throw new Error("live S3 list returned an unexpected object key");
    }
    keys.push(entry.Key);
  }
  return keys;
}

async function assertNoStreamStaging(world: LiveWorld): Promise<void> {
  expect(await listObjectKeys(world.probe, world.bucket, streamStagingPrefix(world.prefix))).toEqual([]);
}

async function deleteGeneratedPrefix(prefix: string): Promise<void> {
  if (!/^(http|abort)eval[0-9a-f]+$/u.test(prefix)) {
    throw new Error("refusing to delete a non-generated HTTP evaluation prefix");
  }
  const controlRoot = await mkdtemp(join(tmpdir(), `${CONTROL_PREFIX}teardown-`));
  try {
    const env = isolateAwsDefaultChainEnv(qualificationEnv(prefix));
    const settings = loadEvidenceStorageSettings(env, {
      controlRoot,
      storage: "sqlite",
    });
    const credentials = loadEvidenceS3Credentials(env);
    const created = createEvidenceStore({ settings, credentials });
    if (!(created instanceof S3EvidenceStore)) {
      throw new Error("expected S3EvidenceStore for generated prefix cleanup");
    }
    await created.deletePrefix("teardown", `${prefix}/`);
  } finally {
    await rm(controlRoot, { recursive: true, force: true });
  }
}
