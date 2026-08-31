/**
 * Process configuration from the environment. No credentials are hardcoded;
 * secret-bearing URLs are secret-store-sourced (see collab/deploy/.env.example).
 * Evidence S3 credentials stay in the server credential loader, never on Config.
 */
import { loadEvidenceS3Credentials } from "./evidence/s3-secrets.js";
import { loadEvidenceStorageSettings } from "./evidence/s3-settings.js";

export {
  loadEvidenceStorageSettings,
} from "./evidence/s3-settings.js";
export type {
  EvidenceProviderKind,
  EvidenceS3Settings,
  EvidenceStorageSettings,
} from "./evidence/s3-settings.js";

export interface Config {
  host: string;
  port: number;
  serviceName: string;
  serviceVersion: string | null;
  serviceCommit: string | null;
  /** Least-privilege application role. */
  storage: "postgres" | "sqlite";
  databaseUrl: string | null;
  /** Separate migrator role (DDL). */
  migrateDatabaseUrl: string | null;
  /** Required only for SQLite local/single-node mode. */
  sqlitePath: string | null;
  evidenceRoot: string;
  /** Built UI assets; null skips static serving (API-only). */
  staticDir: string | null;
  authMode: "ldap" | "local";
  /**
   * Ingress hops to trust when deriving the client address. null keeps the
   * socket peer as the client (no proxy). See {@link parseTrustProxy}.
   */
  trustProxy: number | string | null;
}

function parsePort(raw: string | undefined): number {
  const portRaw = raw ?? "8787";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COLLAB_PORT must be an integer 1..65535, got ${portRaw}`);
  }
  return port;
}

function must(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function authMode(env: NodeJS.ProcessEnv): "ldap" | "local" {
  const mode = (env.COLLAB_AUTH_MODE ?? "ldap").trim().toLowerCase();
  if (mode !== "ldap" && mode !== "local") {
    throw new Error(`COLLAB_AUTH_MODE must be ldap or local, got ${mode}`);
  }
  return mode;
}

/**
 * How far to trust `X-Forwarded-*` when deriving `request.ip`.
 *
 * `request.ip` keys the login rate limiter and is recorded as the audit
 * `origin`. The documented shared deployment terminates TLS at a reverse proxy
 * and forwards HTTP, which makes the socket peer that proxy for every request:
 * left unset there, one user's failed logins rate-limit every other user, and
 * no audit record can attribute an origin.
 *
 * Unset or `0` keeps the socket peer as the client, which is correct for a
 * directly exposed or loopback deployment. A positive integer trusts that many
 * hops closest to this server. A comma-separated list trusts those addresses,
 * CIDR blocks, or the `loopback` / `linklocal` / `uniquelocal` keywords; an
 * address that is not parsable is refused when the server is built, not at
 * request time. Trusting every forwarded address is deliberately not
 * accepted - it would let any client forge `X-Forwarded-For` and evade the
 * login rate limiter outright.
 */
export function parseTrustProxy(raw: string | undefined): number | string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^(?:true|all|\*)$/i.test(value)) {
    throw new Error(
      "COLLAB_TRUST_PROXY must be a hop count or an address list; trusting every forwarded address is refused",
    );
  }
  if (/^(?:false|off)$/i.test(value)) return null;
  if (/^\d+$/u.test(value)) {
    const hops = Number.parseInt(value, 10);
    if (hops === 0) return null;
    if (hops > 16) {
      throw new Error(`COLLAB_TRUST_PROXY hop count must be 0..16, got ${value}`);
    }
    return hops;
  }
  const entries = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (entries.length === 0) {
    throw new Error("COLLAB_TRUST_PROXY must be a hop count or an address list");
  }
  return entries.join(",");
}

function storageMode(env: NodeJS.ProcessEnv): "postgres" | "sqlite" {
  const mode = (env.COLLAB_STORAGE ?? "postgres").trim().toLowerCase();
  if (mode !== "postgres" && mode !== "sqlite") {
    throw new Error(`COLLAB_STORAGE must be postgres or sqlite, got ${mode}`);
  }
  return mode;
}

/** Load config for the process entrypoint; storage-specific fields are validated here. */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const storage = storageMode(env);
  const databaseUrl = storage === "postgres" ? must(env, "COLLAB_DATABASE_URL") : null;
  const migrateDatabaseUrl = storage === "postgres"
    ? env.COLLAB_MIGRATE_DATABASE_URL ?? databaseUrl
    : null;
  const sqlitePath = storage === "sqlite" ? must(env, "COLLAB_SQLITE_PATH") : null;
  const evidenceRoot = env.COLLAB_EVIDENCE_ROOT ?? ".data/evidence";
  const evidence = loadEvidenceStorageSettings(env, {
    controlRoot: evidenceRoot,
    storage,
  });
  if (evidence.provider === "s3") {
    loadEvidenceS3Credentials(env);
  }
  return {
    host: env.COLLAB_HOST ?? "127.0.0.1",
    port: parsePort(env.COLLAB_PORT),
    serviceName: env.COLLAB_SERVICE_NAME ?? "cd-collab",
    serviceVersion: env.COLLAB_SERVICE_VERSION?.trim() || null,
    serviceCommit: env.COLLAB_SERVICE_COMMIT?.trim() || null,
    storage,
    databaseUrl,
    migrateDatabaseUrl,
    sqlitePath,
    evidenceRoot,
    staticDir: env.COLLAB_STATIC_DIR?.trim() || null,
    authMode: authMode(env),
    trustProxy: parseTrustProxy(env.COLLAB_TRUST_PROXY),
  };
}

/** Test/helper config that does not require a live database URL. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8787,
    serviceName: "cd-collab",
    serviceVersion: null,
    serviceCommit: null,
    storage: "postgres",
    databaseUrl: "postgres://collab_app@127.0.0.1:5432/collab",
    migrateDatabaseUrl: "postgres://collab_migrator@127.0.0.1:5432/collab",
    sqlitePath: null,
    evidenceRoot: ".data/evidence",
    staticDir: null,
    authMode: "ldap",
    trustProxy: null,
    ...overrides,
  };
}
