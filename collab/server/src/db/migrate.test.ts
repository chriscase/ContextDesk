import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "./migrate.js";

function adminUrl(): string | undefined {
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

async function withDisposableDb(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const admin = adminUrl();
  if (!admin) {
    throw new Error(
      "COLLAB_TEST_ADMIN_URL is required for migration tests (disposable PostgreSQL)",
    );
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
    await fn(client);
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

describe.skipIf(!adminUrl())("migrations", () => {
  it("applies and rolls back the baseline migration", async () => {
    await withDisposableDb(async (client) => {
      const up = await migrateUp(client);
      expect(up.applied).toContain("001_baseline");
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(tables.rows).toHaveLength(1);
      const down = await migrateDown(client);
      expect(down.rolledBack).toBe("001_baseline");
      const gone = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(gone.rows).toHaveLength(0);
    });
  });

  it("dry-run lists pending SQL without applying", async () => {
    await withDisposableDb(async (client) => {
      const dry = await migrateUp(client, { dryRun: true });
      expect(dry.pending).toContain("001_baseline");
      expect(dry.applied).toHaveLength(0);
      expect(dry.sql.some((s) => s.includes("evidence_file_references"))).toBe(
        true,
      );
      const tables = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'evidence_file_references'`,
      );
      expect(tables.rows).toHaveLength(0);
    });
  });
});
