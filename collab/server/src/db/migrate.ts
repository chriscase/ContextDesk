import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

export interface MigrationFile {
  version: string;
  upPath: string;
  downPath: string;
}

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

export function listMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  const names = readdirSync(dir).filter((n) => n.endsWith(".up.sql"));
  const files: MigrationFile[] = names.map((upName) => {
    const version = upName.replace(/\.up\.sql$/, "");
    return {
      version,
      upPath: join(dir, upName),
      downPath: join(dir, `${version}.down.sql`),
    };
  });
  files.sort((a, b) => a.version.localeCompare(b.version));
  return files;
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const exists = await client.query<{ to_regclass: string | null }>(
    `SELECT to_regclass('public.schema_migrations') AS to_regclass`,
  );
  if (!exists.rows[0]?.to_regclass) return new Set();
  const rows = await client.query<{ version: string }>(
    `SELECT version FROM schema_migrations`,
  );
  return new Set(rows.rows.map((r) => r.version));
}

export interface MigrateResult {
  applied: string[];
  pending: string[];
  sql: string[];
}

export async function migrateUp(
  client: Client,
  opts: { dir?: string; dryRun?: boolean } = {},
): Promise<MigrateResult> {
  const files = listMigrations(opts.dir);
  const applied = await appliedVersions(client);
  const pending = files.filter((f) => !applied.has(f.version));
  const sql = pending.map((f) => readFileSync(f.upPath, "utf8"));
  if (opts.dryRun) {
    return { applied: [], pending: pending.map((f) => f.version), sql };
  }
  const newly: string[] = [];
  for (const file of pending) {
    const body = readFileSync(file.upPath, "utf8");
    await client.query(body);
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [file.version],
    );
    newly.push(file.version);
  }
  return { applied: newly, pending: pending.map((f) => f.version), sql };
}

export interface RollbackResult {
  rolledBack: string | null;
  sql: string | null;
}

export async function migrateDown(
  client: Client,
  opts: { dir?: string; dryRun?: boolean } = {},
): Promise<RollbackResult> {
  const files = listMigrations(opts.dir);
  const applied = await appliedVersions(client);
  const latest = [...files].reverse().find((f) => applied.has(f.version));
  if (!latest) {
    return { rolledBack: null, sql: null };
  }
  const sql = readFileSync(latest.downPath, "utf8");
  if (opts.dryRun) {
    return { rolledBack: latest.version, sql };
  }
  await client.query(sql);
  await client.query(`DELETE FROM schema_migrations WHERE version = $1`, [
    latest.version,
  ]);
  return { rolledBack: latest.version, sql };
}
