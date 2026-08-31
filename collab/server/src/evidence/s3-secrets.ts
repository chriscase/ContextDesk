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

function readSecretFile(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readUnfollowedRegularFile(path, {
      maxBytes: BIND_SECRET_MAX_BYTES,
      ownerOnly: true,
    });
  } catch {
    fail(EVIDENCE_STORAGE_ERRORS.credentialFile);
  }
  try {
    return decodeSecretBytes(bytes);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === EVIDENCE_STORAGE_ERRORS.credentialInvalid
    ) {
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

type SecretSource = { kind: "env" | "file" | "ref"; value: string };

function resolveSecretSource(
  env: NodeJS.ProcessEnv,
  baseName: string,
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
    const path = (presentEnvValue(env, `${baseName}_FILE`) ?? "").trim();
    return { kind: "file", value: readSecretFile(path) };
  }
  const ref = presentEnvValue(env, `${baseName}_REF`) ?? "";
  return { kind: "ref", value: readSecretFile(resolveFileRef(ref)) };
}

function loadStaticSecret(
  env: NodeJS.ProcessEnv,
  baseName: string,
): string | undefined {
  const source = resolveSecretSource(env, baseName);
  return source?.value;
}

/**
 * Load S3 credentials for the evidence byte backend. Default-chain mode never
 * copies AWS_* environment values into the returned object.
 */
export function loadEvidenceS3Credentials(
  env: NodeJS.ProcessEnv,
): EvidenceS3Credentials {
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
  const accessKeyId = loadStaticSecret(env, "COLLAB_EVIDENCE_S3_ACCESS_KEY_ID");
  const secretAccessKey = loadStaticSecret(env, "COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY");
  const sessionToken = loadStaticSecret(env, "COLLAB_EVIDENCE_S3_SESSION_TOKEN");
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
