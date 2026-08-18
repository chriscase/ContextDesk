/**
 * Process configuration from the environment. No credentials are hardcoded;
 * secret-bearing URLs are secret-store-sourced (see collab/deploy/.env.example).
 */

export interface Config {
  host: string;
  port: number;
  serviceName: string;
  /** Least-privilege application role. */
  databaseUrl: string;
  /** Separate migrator role (DDL). */
  migrateDatabaseUrl: string;
  evidenceRoot: string;
  /** Built UI assets; null skips static serving (API-only). */
  staticDir: string | null;
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

/** Load config, requiring database URLs (used by the process entrypoint). */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  return {
    host: env.COLLAB_HOST ?? "127.0.0.1",
    port: parsePort(env.COLLAB_PORT),
    serviceName: env.COLLAB_SERVICE_NAME ?? "cd-collab",
    databaseUrl: must(env, "COLLAB_DATABASE_URL"),
    migrateDatabaseUrl:
      env.COLLAB_MIGRATE_DATABASE_URL ?? must(env, "COLLAB_DATABASE_URL"),
    evidenceRoot: env.COLLAB_EVIDENCE_ROOT ?? ".data/evidence",
    staticDir: env.COLLAB_STATIC_DIR?.trim() || null,
  };
}

/** Test/helper config that does not require a live database URL. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8787,
    serviceName: "cd-collab",
    databaseUrl: "postgres://collab_app@127.0.0.1:5432/collab",
    migrateDatabaseUrl: "postgres://collab_migrator@127.0.0.1:5432/collab",
    evidenceRoot: ".data/evidence",
    staticDir: null,
    ...overrides,
  };
}
