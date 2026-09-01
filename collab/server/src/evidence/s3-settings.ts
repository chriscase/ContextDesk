/**
 * Server-only S3 evidence storage settings. Secret material is never stored
 * here; credential files are read only by the credential loader.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

export const EVIDENCE_PROVIDER_FILESYSTEM = "filesystem" as const;
export const EVIDENCE_PROVIDER_S3 = "s3" as const;
export type EvidenceProviderKind =
  | typeof EVIDENCE_PROVIDER_FILESYSTEM
  | typeof EVIDENCE_PROVIDER_S3;

export const DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES = 536_870_912;
export const MIN_EVIDENCE_UPLOAD_BYTES = 1;
export const MAX_EVIDENCE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const MIN_EVIDENCE_S3_UPLOAD_BYTES = MIN_EVIDENCE_UPLOAD_BYTES;
export const DEFAULT_EVIDENCE_S3_TIMEOUT_MS = 30_000;
export const MIN_EVIDENCE_S3_TIMEOUT_MS = 1_000;
export const MAX_EVIDENCE_S3_TIMEOUT_MS = 120_000;
export const EVIDENCE_S3_SUPPORTED_UPLOAD_BYTES_PER_SECOND = 1024 * 1024;
export const DEFAULT_EVIDENCE_S3_MAX_UPLOAD_BYTES =
  (DEFAULT_EVIDENCE_S3_TIMEOUT_MS / 1000)
  * EVIDENCE_S3_SUPPORTED_UPLOAD_BYTES_PER_SECOND;
export const MAX_EVIDENCE_S3_UPLOAD_BYTES =
  (MAX_EVIDENCE_S3_TIMEOUT_MS / 1000)
  * EVIDENCE_S3_SUPPORTED_UPLOAD_BYTES_PER_SECOND;
export const MAX_EVIDENCE_S3_CA_FILE_BYTES = 1024 * 1024;

const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*-----END CERTIFICATE-----/u;

export const EVIDENCE_S3_SETTING_NAMES = [
  "COLLAB_EVIDENCE_S3_ENDPOINT",
  "COLLAB_EVIDENCE_S3_REGION",
  "COLLAB_EVIDENCE_S3_BUCKET",
  "COLLAB_EVIDENCE_S3_PREFIX",
  "COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE",
  "COLLAB_EVIDENCE_S3_ALLOW_HTTP",
  "COLLAB_EVIDENCE_S3_CA_FILE",
  "COLLAB_EVIDENCE_S3_TIMEOUT_MS",
  "COLLAB_EVIDENCE_S3_CREDENTIALS_MODE",
] as const;

export const EVIDENCE_S3_SECRET_NAMES = [
  "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID",
  "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_FILE",
  "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID_REF",
  "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY",
  "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_FILE",
  "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY_REF",
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN_FILE",
  "COLLAB_EVIDENCE_S3_SESSION_TOKEN_REF",
] as const;

const KNOWN_S3_NAMES = new Set<string>([
  ...EVIDENCE_S3_SETTING_NAMES,
  ...EVIDENCE_S3_SECRET_NAMES,
]);

export const EVIDENCE_STORAGE_ERRORS = {
  leftover: "filesystem evidence mode rejects leftover s3 configuration",
  provider: "COLLAB_EVIDENCE_PROVIDER must be filesystem or s3",
  unknownSetting: "s3 evidence mode rejects unknown s3 configuration",
  missingEndpoint: "s3 evidence mode requires COLLAB_EVIDENCE_S3_ENDPOINT",
  missingRegion: "s3 evidence mode requires COLLAB_EVIDENCE_S3_REGION",
  missingBucket: "s3 evidence mode requires COLLAB_EVIDENCE_S3_BUCKET",
  endpoint: "evidence s3 endpoint is invalid",
  endpointHttp: "evidence s3 HTTP endpoint requires COLLAB_EVIDENCE_S3_ALLOW_HTTP=1",
  region: "evidence s3 region is invalid",
  bucket: "evidence s3 bucket is invalid",
  prefix: "evidence s3 prefix is invalid",
  forcePathStyle: "COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE must be 0 or 1",
  allowHttp: "COLLAB_EVIDENCE_S3_ALLOW_HTTP must be 0 or 1",
  timeout: "COLLAB_EVIDENCE_S3_TIMEOUT_MS must be an integer from 1000 to 120000",
  maxUpload:
    "COLLAB_EVIDENCE_MAX_UPLOAD_BYTES must be an integer from 1 to 5368709120",
  s3UploadTimeout:
    "s3 evidence COLLAB_EVIDENCE_MAX_UPLOAD_BYTES exceeds the supported request-timeout envelope; set it to no more than floor(COLLAB_EVIDENCE_S3_TIMEOUT_MS / 1000) * 1048576",
  caFile: "evidence s3 CA file is invalid",
  caFileHttp:
    "COLLAB_EVIDENCE_S3_CA_FILE requires an https evidence s3 endpoint",
  credentialsMode:
    "COLLAB_EVIDENCE_S3_CREDENTIALS_MODE must be default_chain or static",
  defaultChainLeftover:
    "s3 evidence default_chain mode rejects static credential leftovers",
  sourceConflict:
    "s3 evidence credentials sources conflict; configure exactly one",
  missingStaticPair:
    "s3 evidence static credentials require an access key id and secret access key",
  tokenWithoutPair:
    "s3 evidence session token requires static access key id and secret access key",
  credentialInvalid: "s3 evidence credential is invalid",
  credentialFile: "s3 evidence credential file is unreadable",
  credentialFileWindows:
    "s3 evidence credential _FILE and file: _REF sources are unsupported on Windows; use default_chain or process-injected direct environment credentials",
} as const;

export type EvidenceCredentialsMode = "default_chain" | "static";

export interface EvidenceS3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Opaque object-key prefix; empty means the bucket root. */
  prefix: string;
  forcePathStyle: boolean;
  allowHttp: boolean;
  caConfigured: boolean;
  caFilePath: string | null;
  timeoutMs: number;
  maxUploadBytes: number;
  credentialsMode: EvidenceCredentialsMode;
}

type EvidenceStorageBase = {
  controlRoot: string;
  storage: "postgres" | "sqlite";
};

/**
 * Secret-free evidence byte-backend settings. `loadEvidenceStorageSettings`
 * always populates `maxUploadBytes`. Filesystem defaults to 512 MiB and keeps
 * the 5 GiB protocol ceiling. S3 defaults to the lower of 30 MiB and its
 * timeout-derived support envelope. Hand-built test fixtures may omit it;
 * {@link evidenceMaxUploadBytes} restores their provider-specific value.
 */
export type EvidenceStorageSettings =
  | (EvidenceStorageBase & {
      provider: "filesystem";
      maxUploadBytes?: number;
    })
  | (EvidenceStorageBase & {
      provider: "s3";
      maxUploadBytes?: number;
      s3: EvidenceS3Settings;
    });

/** Loader/runtime settings: the upload ceiling is always present. */
export type LoadedEvidenceStorageSettings = EvidenceStorageSettings & {
  maxUploadBytes: number;
};

export function evidenceMaxUploadBytes(settings: EvidenceStorageSettings): number {
  if (
    typeof settings.maxUploadBytes === "number"
    && Number.isSafeInteger(settings.maxUploadBytes)
    && settings.maxUploadBytes >= MIN_EVIDENCE_UPLOAD_BYTES
    && settings.maxUploadBytes <= MAX_EVIDENCE_UPLOAD_BYTES
  ) {
    return settings.maxUploadBytes;
  }
  if (settings.provider === "s3") return settings.s3.maxUploadBytes;
  return DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES;
}

export function envIsPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.hasOwn(env, name) && env[name] !== undefined;
}

export function presentEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  if (!envIsPresent(env, name)) return undefined;
  return env[name] as string;
}

function fail(message: string): never {
  throw new Error(message);
}

function hasC0Controls(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function listedS3Leftovers(env: NodeJS.ProcessEnv): string[] {
  const leftovers: string[] = [];
  for (const name of Object.keys(env)) {
    if (!envIsPresent(env, name)) continue;
    if (name.startsWith("COLLAB_EVIDENCE_S3_")) leftovers.push(name);
  }
  return leftovers;
}

function parseMaxUploadBytes(env: NodeJS.ProcessEnv): number {
  return parseOptionalBoundedInt(
    env,
    "COLLAB_EVIDENCE_MAX_UPLOAD_BYTES",
    MIN_EVIDENCE_UPLOAD_BYTES,
    MAX_EVIDENCE_UPLOAD_BYTES,
    DEFAULT_EVIDENCE_MAX_UPLOAD_BYTES,
    EVIDENCE_STORAGE_ERRORS.maxUpload,
  );
}

export function evidenceS3SupportedMaxUploadBytes(timeoutMs: number): number {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_EVIDENCE_S3_TIMEOUT_MS
    || timeoutMs > MAX_EVIDENCE_S3_TIMEOUT_MS
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.timeout);
  }
  return Math.floor(timeoutMs / 1000)
    * EVIDENCE_S3_SUPPORTED_UPLOAD_BYTES_PER_SECOND;
}

export function assertEvidenceS3MaxUploadFitsRequestTimeout(
  maxUploadBytes: number,
  timeoutMs: number,
): void {
  const supportedMaxUploadBytes = evidenceS3SupportedMaxUploadBytes(timeoutMs);
  if (
    !Number.isSafeInteger(maxUploadBytes)
    || maxUploadBytes < MIN_EVIDENCE_S3_UPLOAD_BYTES
    || maxUploadBytes > supportedMaxUploadBytes
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.s3UploadTimeout);
  }
}

function parseS3MaxUploadBytes(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): number {
  const supportedMaxUploadBytes = evidenceS3SupportedMaxUploadBytes(timeoutMs);
  const defaultMaxUploadBytes = Math.min(
    DEFAULT_EVIDENCE_S3_MAX_UPLOAD_BYTES,
    supportedMaxUploadBytes,
  );
  const maxUploadBytes = parseOptionalBoundedInt(
    env,
    "COLLAB_EVIDENCE_MAX_UPLOAD_BYTES",
    MIN_EVIDENCE_S3_UPLOAD_BYTES,
    MAX_EVIDENCE_UPLOAD_BYTES,
    defaultMaxUploadBytes,
    EVIDENCE_STORAGE_ERRORS.maxUpload,
  );
  assertEvidenceS3MaxUploadFitsRequestTimeout(maxUploadBytes, timeoutMs);
  return maxUploadBytes;
}

function assertNoUnknownS3Names(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (!envIsPresent(env, name)) continue;
    if (!name.startsWith("COLLAB_EVIDENCE_S3_")) continue;
    if (!KNOWN_S3_NAMES.has(name)) fail(EVIDENCE_STORAGE_ERRORS.unknownSetting);
  }
}

function parseProvider(env: NodeJS.ProcessEnv): EvidenceProviderKind {
  if (!envIsPresent(env, "COLLAB_EVIDENCE_PROVIDER")) {
    return EVIDENCE_PROVIDER_FILESYSTEM;
  }
  const raw = presentEnvValue(env, "COLLAB_EVIDENCE_PROVIDER") ?? "";
  const mode = raw.trim().toLowerCase();
  if (mode === EVIDENCE_PROVIDER_FILESYSTEM) return EVIDENCE_PROVIDER_FILESYSTEM;
  if (mode === EVIDENCE_PROVIDER_S3) return EVIDENCE_PROVIDER_S3;
  fail(EVIDENCE_STORAGE_ERRORS.provider);
}

function parseFlag(
  env: NodeJS.ProcessEnv,
  name: "COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE" | "COLLAB_EVIDENCE_S3_ALLOW_HTTP",
  invalid: string,
  defaultValue: boolean,
): boolean {
  if (!envIsPresent(env, name)) return defaultValue;
  const raw = presentEnvValue(env, name);
  if (raw === "0") return false;
  if (raw === "1") return true;
  fail(invalid);
}

function parseBoundedInt(
  raw: string,
  min: number,
  max: number,
  invalid: string,
): number {
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) fail(invalid);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(invalid);
  }
  return parsed;
}

function parseOptionalBoundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  fallback: number,
  invalid: string,
): number {
  if (!envIsPresent(env, name)) return fallback;
  const raw = presentEnvValue(env, name) ?? "";
  if (!raw.trim()) fail(invalid);
  return parseBoundedInt(raw, min, max, invalid);
}

function requirePresent(
  env: NodeJS.ProcessEnv,
  name: string,
  missing: string,
  blank = missing,
): string {
  if (!envIsPresent(env, name)) fail(missing);
  const raw = presentEnvValue(env, name) ?? "";
  const value = raw.trim();
  if (!value) fail(blank);
  return value;
}

function parseEndpoint(raw: string, allowHttp: boolean): string {
  const value = raw.trim();
  if (
    !value ||
    hasC0Controls(value) ||
    /\s/u.test(value) ||
    value.includes("..") ||
    value.includes("./")
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  if (parsed.protocol === "http:" && !allowHttp) {
    fail(EVIDENCE_STORAGE_ERRORS.endpointHttp);
  }
  if (
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value.includes("@") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  const authorityStart = value.indexOf("://") + 3;
  const rawPathStart = value.indexOf("/", authorityStart);
  if (rawPathStart !== -1 && value.slice(rawPathStart) !== "/") {
    // URL parsing normalizes encoded dot segments before exposing pathname;
    // inspect the original suffix so an endpoint remains scheme/host/port only.
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  if (!parsed.hostname || !hostnameAllowed(parsed.hostname)) {
    fail(EVIDENCE_STORAGE_ERRORS.endpoint);
  }
  return parsed.origin;
}

function hostnameAllowed(host: string): boolean {
  if (!host || host.includes("\0")) return false;
  if (host === "localhost") return true;
  // WHATWG URL parsing has already validated bracketed IPv6 syntax. Keep the
  // brackets here because Node's URL.hostname includes them.
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    return host.split(".").every((part) => {
      const n = Number.parseInt(part, 10);
      return n >= 0 && n <= 255;
    });
  }
  if (host.includes(":")) {
    return /^[0-9a-f:]+$/iu.test(host);
  }
  const labels = host.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/iu.test(label),
  );
}

function defaultForcePathStyle(endpoint: string): boolean {
  const host = new URL(endpoint).hostname.toLowerCase();
  const awsManaged =
    host === "s3.amazonaws.com" ||
    host.endsWith(".amazonaws.com") ||
    host.endsWith(".amazonaws.com.cn");
  // Garage, Ceph, loopback, and other custom endpoints commonly cannot
  // resolve bucket-prefixed virtual hosts. AWS-managed endpoints retain their
  // native virtual-host default; either behavior can be overridden with 0/1.
  return !awsManaged;
}

function parseRegion(raw: string): string {
  const value = raw.trim();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.region);
  }
  return value;
}

function parseBucket(raw: string): string {
  const value = raw.trim();
  if (value.length < 3 || value.length > 63) fail(EVIDENCE_STORAGE_ERRORS.bucket);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value)) {
    fail(EVIDENCE_STORAGE_ERRORS.bucket);
  }
  if (value.includes("..") || /^\d+\.\d+\.\d+\.\d+$/u.test(value)) {
    fail(EVIDENCE_STORAGE_ERRORS.bucket);
  }
  if (
    value.startsWith("xn--") ||
    value.startsWith("sthree-") ||
    value.startsWith("amzn-s3-demo-") ||
    value.endsWith("-s3alias") ||
    value.endsWith("--ol-s3") ||
    value.endsWith(".mrap") ||
    value.endsWith("--x-s3") ||
    value.endsWith("--table-s3")
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.bucket);
  }
  for (const label of value.split(".")) {
    if (!label || label.startsWith("-") || label.endsWith("-")) {
      fail(EVIDENCE_STORAGE_ERRORS.bucket);
    }
  }
  return value;
}

export function normalizeEvidenceS3Prefix(raw: string | undefined): string {
  if (raw === undefined) return "";
  const value = raw.trim();
  if (!value) fail(EVIDENCE_STORAGE_ERRORS.prefix);
  if (
    hasC0Controls(value) ||
    /[\\?#[\]@:%~*]/.test(value) ||
    value.includes("://") ||
    value.includes("//") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /[^\u0020-\u007e]/u.test(value)
  ) {
    fail(EVIDENCE_STORAGE_ERRORS.prefix);
  }
  const trimmed = value.replace(/\/+$/u, "");
  if (!trimmed) fail(EVIDENCE_STORAGE_ERRORS.prefix);
  const segments = trimmed.split("/");
  if (segments.length > 8) fail(EVIDENCE_STORAGE_ERRORS.prefix);
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)
    ) {
      fail(EVIDENCE_STORAGE_ERRORS.prefix);
    }
  }
  const prefix = `${segments.join("/")}/`;
  if (prefix.length > 256) fail(EVIDENCE_STORAGE_ERRORS.prefix);
  return prefix;
}

function parseCredentialsMode(env: NodeJS.ProcessEnv): EvidenceCredentialsMode {
  const raw = requirePresent(
    env,
    "COLLAB_EVIDENCE_S3_CREDENTIALS_MODE",
    EVIDENCE_STORAGE_ERRORS.credentialsMode,
  );
  if (raw === "default_chain" || raw === "static") return raw;
  fail(EVIDENCE_STORAGE_ERRORS.credentialsMode);
}

function assertDefaultChainHasNoStaticLeftovers(env: NodeJS.ProcessEnv): void {
  for (const name of EVIDENCE_S3_SECRET_NAMES) {
    if (envIsPresent(env, name)) fail(EVIDENCE_STORAGE_ERRORS.defaultChainLeftover);
  }
}

function assertSafeAbsolutePath(raw: string): string {
  const path = raw.trim();
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    fail("unreadable");
  }
  return path;
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // The bounded read already completed or failed; ignore close errors.
  }
}

export function readUnfollowedRegularFile(
  path: string,
  options: { maxBytes: number; ownerOnly: boolean; platform?: NodeJS.Platform },
): Buffer {
  // Owner-only credential reads cannot prove Windows ACL semantics here.
  // Refuse those sources before path parsing or filesystem access. CA files
  // use ownerOnly=false and are not credential files.
  if (options.ownerOnly && (options.platform ?? process.platform) === "win32") {
    fail(EVIDENCE_STORAGE_ERRORS.credentialFileWindows);
  }
  const resolved = assertSafeAbsolutePath(path);
  let descriptor: number | undefined;
  try {
    const link = lstatSync(resolved);
    if (link.isSymbolicLink() || !link.isFile()) fail("unreadable");
    const flags =
      constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    descriptor = openSync(resolved, flags);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) fail("unreadable");
    // Bind the opened file to the entry inspected before open so a concurrent
    // replacement cannot swap in a different inode between lstat and read.
    if (link.dev !== metadata.dev || link.ino !== metadata.ino) fail("unreadable");
    if (options.ownerOnly) {
      const uid = process.getuid?.();
      if (uid === undefined || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
        fail("unreadable");
      }
    }
    if (metadata.size < 1 || metadata.size > options.maxBytes) fail("unreadable");
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (n === 0) break;
      offset += n;
    }
    if (offset !== bytes.byteLength) fail("unreadable");
    closeQuietly(descriptor);
    descriptor = undefined;
    return bytes;
  } catch (error) {
    closeQuietly(descriptor);
    if (
      error instanceof Error &&
      (error.message === "unreadable" ||
        error.message === EVIDENCE_STORAGE_ERRORS.credentialFileWindows)
    ) {
      throw error;
    }
    fail("unreadable");
  }
}

function parseCaFile(env: NodeJS.ProcessEnv): string | null {
  if (!envIsPresent(env, "COLLAB_EVIDENCE_S3_CA_FILE")) return null;
  const raw = presentEnvValue(env, "COLLAB_EVIDENCE_S3_CA_FILE") ?? "";
  if (!raw.trim()) fail(EVIDENCE_STORAGE_ERRORS.caFile);
  let path: string;
  try {
    path = assertSafeAbsolutePath(raw);
  } catch {
    fail(EVIDENCE_STORAGE_ERRORS.caFile);
  }
  let body: string;
  try {
    body = readUnfollowedRegularFile(path, {
      maxBytes: MAX_EVIDENCE_S3_CA_FILE_BYTES,
      ownerOnly: false,
    }).toString("utf8");
  } catch {
    fail(EVIDENCE_STORAGE_ERRORS.caFile);
  }
  if (body.includes("\0") || !PEM_CERTIFICATE.test(body)) {
    fail(EVIDENCE_STORAGE_ERRORS.caFile);
  }
  return path;
}

/**
 * Load non-secret evidence storage settings. Fail closed on leftover S3
 * configuration in filesystem mode. Does not contact a bucket.
 */
export function loadEvidenceStorageSettings(
  env: NodeJS.ProcessEnv,
  options: { controlRoot: string; storage: "postgres" | "sqlite" },
): LoadedEvidenceStorageSettings {
  const provider = parseProvider(env);
  if (provider === EVIDENCE_PROVIDER_FILESYSTEM) {
    if (listedS3Leftovers(env).length > 0) fail(EVIDENCE_STORAGE_ERRORS.leftover);
    return {
      provider,
      controlRoot: options.controlRoot,
      storage: options.storage,
      maxUploadBytes: parseMaxUploadBytes(env),
    };
  }
  assertNoUnknownS3Names(env);
  const allowHttp = parseFlag(
    env,
    "COLLAB_EVIDENCE_S3_ALLOW_HTTP",
    EVIDENCE_STORAGE_ERRORS.allowHttp,
    false,
  );
  const endpoint = parseEndpoint(
    requirePresent(
      env,
      "COLLAB_EVIDENCE_S3_ENDPOINT",
      EVIDENCE_STORAGE_ERRORS.missingEndpoint,
      EVIDENCE_STORAGE_ERRORS.endpoint,
    ),
    allowHttp,
  );
  const forcePathStyle = parseFlag(
    env,
    "COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE",
    EVIDENCE_STORAGE_ERRORS.forcePathStyle,
    defaultForcePathStyle(endpoint),
  );
  const region = parseRegion(
    requirePresent(
      env,
      "COLLAB_EVIDENCE_S3_REGION",
      EVIDENCE_STORAGE_ERRORS.missingRegion,
      EVIDENCE_STORAGE_ERRORS.region,
    ),
  );
  const bucket = parseBucket(
    requirePresent(
      env,
      "COLLAB_EVIDENCE_S3_BUCKET",
      EVIDENCE_STORAGE_ERRORS.missingBucket,
      EVIDENCE_STORAGE_ERRORS.bucket,
    ),
  );
  const prefix = envIsPresent(env, "COLLAB_EVIDENCE_S3_PREFIX")
    ? normalizeEvidenceS3Prefix(presentEnvValue(env, "COLLAB_EVIDENCE_S3_PREFIX"))
    : "";
  const timeoutMs = parseOptionalBoundedInt(
    env,
    "COLLAB_EVIDENCE_S3_TIMEOUT_MS",
    MIN_EVIDENCE_S3_TIMEOUT_MS,
    MAX_EVIDENCE_S3_TIMEOUT_MS,
    DEFAULT_EVIDENCE_S3_TIMEOUT_MS,
    EVIDENCE_STORAGE_ERRORS.timeout,
  );
  const maxUploadBytes = parseS3MaxUploadBytes(env, timeoutMs);
  const credentialsMode = parseCredentialsMode(env);
  if (credentialsMode === "default_chain") {
    assertDefaultChainHasNoStaticLeftovers(env);
  }
  const caFilePath = parseCaFile(env);
  if (endpoint.startsWith("http://") && caFilePath !== null) {
    fail(EVIDENCE_STORAGE_ERRORS.caFileHttp);
  }
  return {
    provider,
    controlRoot: options.controlRoot,
    storage: options.storage,
    maxUploadBytes,
    s3: {
      endpoint,
      region,
      bucket,
      prefix,
      forcePathStyle,
      allowHttp,
      caConfigured: caFilePath !== null,
      caFilePath,
      timeoutMs,
      maxUploadBytes,
      credentialsMode,
    },
  };
}
