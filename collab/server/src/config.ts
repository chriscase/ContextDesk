/**
 * Process configuration from the environment. No credentials are hardcoded;
 * secret-bearing URLs are secret-store-sourced (see collab/deploy/.env.example).
 */

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
    evidenceRoot: env.COLLAB_EVIDENCE_ROOT ?? ".data/evidence",
    staticDir: env.COLLAB_STATIC_DIR?.trim() || null,
    authMode: authMode(env),
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
    ...overrides,
  };
}
