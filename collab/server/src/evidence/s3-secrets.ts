/**
 * Server-only S3 credential loader. Secret contents never enter Config, doctor
 * JSON, or inspect/JSON output of the returned object.
 */
import {
  EVIDENCE_S3_SECRET_NAMES,
  EVIDENCE_STORAGE_ERRORS,
  envIsPresent,
  presentEnvValue,
  readUnfollowedRegularFile,
} from "./s3-settings.js";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const BIND_SECRET_MAX_BYTES = 16 * 1024;

export type EvidenceS3CredentialsMode = "default_chain" | "static";

export type EvidenceS3SecretBytesReader = (
  path: string,
  options: { maxBytes: number; ownerOnly: boolean; platform?: NodeJS.Platform },
) => Buffer;

/** Readonly test/production seam. Defaults to the real process platform. */
export type EvidenceS3CredentialLoaderDeps = {
  readonly platform: NodeJS.Platform;
  readonly readUnfollowedRegularFile: EvidenceS3SecretBytesReader;
};

function resolveCredentialLoaderDeps(
  deps?: EvidenceS3CredentialLoaderDeps,
): EvidenceS3CredentialLoaderDeps {
  return {
    platform: deps?.platform ?? process.platform,
    readUnfollowedRegularFile:
      deps?.readUnfollowedRegularFile ?? readUnfollowedRegularFile,
  };
}

class DefaultChainCredentials {
  readonly mode = "default_chain" as const;

  toJSON(): { mode: "default_chain" } {
    return { mode: "default_chain" };
  }

  [INSPECT](): string {
    return "EvidenceS3Credentials { mode: 'default_chain' }";
  }
}

class StaticCredentials {
  readonly mode = "static" as const;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #sessionToken: string | undefined;

  constructor(
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken: string | undefined,
  ) {
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
    this.#sessionToken = sessionToken;
  }

  accessKeyId(): string {
    return this.#accessKeyId;
  }

  secretAccessKey(): string {
    return this.#secretAccessKey;
  }

  sessionToken(): string | undefined {
    return this.#sessionToken;
  }

  toJSON(): { mode: "static"; configured: true } {
    return { mode: "static", configured: true };
  }

  [INSPECT](): string {
    return "EvidenceS3Credentials { mode: 'static', configured: true }";
  }
}

export type EvidenceS3Credentials = DefaultChainCredentials | StaticCredentials;

function fail(message: string): never {
  throw new Error(message);
}

function decodeSecretBytes(bytes: Buffer): string {
  if (bytes.byteLength < 1 || bytes.byteLength > BIND_SECRET_MAX_BYTES) {
    fail(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
  }
  const body = bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n$/, "");
  if (!body.trim() || body.includes("\0")) {
    fail(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
  }
  return body;
}

function isKnownCredentialError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

function assertCredentialFileSourcesSupported(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    fail(EVIDENCE_STORAGE_ERRORS.credentialFileWindows);
  }
}

function readSecretFile(
  path: string,
  deps: EvidenceS3CredentialLoaderDeps,
): string {
  assertCredentialFileSourcesSupported(deps.platform);
  let bytes: Buffer;
  try {
    bytes = deps.readUnfollowedRegularFile(path, {
      maxBytes: BIND_SECRET_MAX_BYTES,
      ownerOnly: true,
      platform: deps.platform,
    });
  } catch (error) {
    if (isKnownCredentialError(error, EVIDENCE_STORAGE_ERRORS.credentialFileWindows)) {
      throw error;
    }
    fail(EVIDENCE_STORAGE_ERRORS.credentialFile);
  }
  try {
    return decodeSecretBytes(bytes);
  } catch (error) {
    if (isKnownCredentialError(error, EVIDENCE_STORAGE_ERRORS.credentialInvalid)) {
      throw error;
    }
    fail(EVIDENCE_STORAGE_ERRORS.credentialFile);
  }
}

function resolveFileRef(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith("file:") || value.includes("://")) {
    fail(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
  }
  const path = value.slice("file:".length);
  if (!path || path.includes("\0")) fail(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
  return path;
}

function readOwnerOnlyCredentialSource(
  raw: string,
  kind: "file" | "ref",
  deps: EvidenceS3CredentialLoaderDeps,
): string {
  assertCredentialFileSourcesSupported(deps.platform);
  const path = kind === "ref" ? resolveFileRef(raw) : raw.trim();
  return readSecretFile(path, deps);
}

type SecretSource = { kind: "env" | "file" | "ref"; value: string };

function resolveSecretSource(
  env: NodeJS.ProcessEnv,
  baseName: string,
  deps: EvidenceS3CredentialLoaderDeps,
): SecretSource | undefined {
  const directPresent = envIsPresent(env, baseName);
  const filePresent = envIsPresent(env, `${baseName}_FILE`);
  const refPresent = envIsPresent(env, `${baseName}_REF`);
  const sources = [directPresent, filePresent, refPresent].filter(Boolean).length;
  if (sources > 1) fail(EVIDENCE_STORAGE_ERRORS.sourceConflict);
  if (sources === 0) return undefined;
  if (directPresent) {
    const raw = presentEnvValue(env, baseName) ?? "";
    if (!raw.trim() || raw.includes("\0") || Buffer.byteLength(raw, "utf8") > BIND_SECRET_MAX_BYTES) {
      fail(EVIDENCE_STORAGE_ERRORS.credentialInvalid);
    }
    return { kind: "env", value: raw };
  }
  if (filePresent) {
    const raw = presentEnvValue(env, `${baseName}_FILE`) ?? "";
    return { kind: "file", value: readOwnerOnlyCredentialSource(raw, "file", deps) };
  }
  const ref = presentEnvValue(env, `${baseName}_REF`) ?? "";
  return { kind: "ref", value: readOwnerOnlyCredentialSource(ref, "ref", deps) };
}

function loadStaticSecret(
  env: NodeJS.ProcessEnv,
  baseName: string,
  deps: EvidenceS3CredentialLoaderDeps,
): string | undefined {
  const source = resolveSecretSource(env, baseName, deps);
  return source?.value;
}

/**
 * Load S3 credentials for the evidence byte backend. Default-chain mode never
 * copies AWS_* environment values into the returned object.
 */
export function loadEvidenceS3Credentials(
  env: NodeJS.ProcessEnv,
  deps?: EvidenceS3CredentialLoaderDeps,
): EvidenceS3Credentials {
  const resolved = resolveCredentialLoaderDeps(deps);
  const modeRaw = presentEnvValue(env, "COLLAB_EVIDENCE_S3_CREDENTIALS_MODE")?.trim();
  if (modeRaw !== "default_chain" && modeRaw !== "static") {
    fail(EVIDENCE_STORAGE_ERRORS.credentialsMode);
  }
  if (modeRaw === "default_chain") {
    for (const name of EVIDENCE_S3_SECRET_NAMES) {
      if (envIsPresent(env, name)) fail(EVIDENCE_STORAGE_ERRORS.defaultChainLeftover);
    }
    return new DefaultChainCredentials();
  }
  const accessKeyId = loadStaticSecret(
    env,
    "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID",
    resolved,
  );
  const secretAccessKey = loadStaticSecret(
    env,
    "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY",
    resolved,
  );
  const sessionToken = loadStaticSecret(
    env,
    "COLLAB_EVIDENCE_S3_SESSION_TOKEN",
    resolved,
  );
  if (sessionToken && (!accessKeyId || !secretAccessKey)) {
    fail(EVIDENCE_STORAGE_ERRORS.tokenWithoutPair);
  }
  if (!accessKeyId || !secretAccessKey) {
    fail(EVIDENCE_STORAGE_ERRORS.missingStaticPair);
  }
  return new StaticCredentials(accessKeyId, secretAccessKey, sessionToken);
}

export function redactEvidenceS3Error(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  for (const known of Object.values(EVIDENCE_STORAGE_ERRORS)) {
    if (message === known) return known;
  }
  return "s3 evidence configuration is invalid";
}
