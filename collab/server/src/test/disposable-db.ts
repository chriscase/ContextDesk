import { randomUUID } from "node:crypto";
import { Client } from "pg";

export const COLLAB_APP_ROLE = "collab_app";
export const COLLAB_APP_ROLE_PASSWORD = "fixture-app-role";
const APP_ROLE_LOCK_KEY = 874_221_001;

export function adminUrl(): string | undefined {
  return process.env.COLLAB_TEST_ADMIN_URL;
}

function withDatabaseName(connectionString: string, name: string): string {
  try {
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  } catch {
    return connectionString.replace(/\/[^/?]+(?=\?|$)/, `/${name}`);
  }
}

export function appRoleUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return `postgres://${COLLAB_APP_ROLE}:${encodeURIComponent(COLLAB_APP_ROLE_PASSWORD)}@${parsed.host}${path}`;
}

async function ensureAppRole(admin: Client): Promise<void> {
  await admin.query("BEGIN");
  try {
    // Vitest runs database-backed files concurrently. Serialize only the
    // shared cluster role mutation; each test's disposable database remains
    // independent and can be created and exercised in parallel.
    await admin.query("SELECT pg_advisory_xact_lock($1)", [APP_ROLE_LOCK_KEY]);
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
          CREATE ROLE collab_app LOGIN PASSWORD '${COLLAB_APP_ROLE_PASSWORD}';
        ELSE
          ALTER ROLE collab_app WITH LOGIN PASSWORD '${COLLAB_APP_ROLE_PASSWORD}';
        END IF;
      END $$;
    `);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

export async function withDisposableDb(
  fn: (client: Client, url: string) => Promise<void>,
): Promise<void> {
  const admin = adminUrl();
  if (!admin) {
    throw new Error("COLLAB_TEST_ADMIN_URL is required");
  }
  const name = `collab_mig_${randomUUID().replaceAll("-", "")}`;
  const root = new Client({ connectionString: admin });
  await root.connect();
  try {
    await ensureAppRole(root);
    await root.query(`CREATE DATABASE ${name}`);
    await root.query(`GRANT CONNECT ON DATABASE ${name} TO collab_app`);
  } finally {
    await root.end();
  }
  const url = withDatabaseName(admin, name);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client, url);
  } finally {
    await client.end();
    const cleanup = new Client({ connectionString: admin });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
    } finally {
      await cleanup.end();
    }
  }
}
