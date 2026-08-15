import { randomUUID } from "node:crypto";
import { Client } from "pg";

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
    await root.query(`CREATE DATABASE ${name}`);
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
