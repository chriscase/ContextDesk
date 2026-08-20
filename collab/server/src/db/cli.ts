import { Client } from "pg";
import { loadRuntimeConfig } from "../config.js";
import { migrateDown, migrateUp } from "./migrate.js";
import { SqliteState } from "./sqlite.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (command !== "up" && command !== "down") {
    throw new Error("usage: cli.ts <up|down> [--dry-run]");
  }
  const config = loadRuntimeConfig();
  if (config.storage === "sqlite") {
    if (command === "down" && !dryRun) {
      throw new Error("SQLite local mode uses an append-only current schema; delete the local file to reset it");
    }
    const state = new SqliteState(config.sqlitePath as string);
    process.stdout.write(
      `${dryRun ? "SQLite schema ready" : command === "up" ? "SQLite schema ready" : "SQLite rollback unavailable"}: ${config.sqlitePath}\n`,
    );
    state.close();
    return;
  }
  const client = new Client({ connectionString: config.migrateDatabaseUrl as string });
  await client.connect();
  try {
    if (command === "up") {
      const result = await migrateUp(client, { dryRun });
      if (dryRun) {
        process.stdout.write(
          `dry-run pending: ${result.pending.join(", ") || "(none)"}\n`,
        );
        for (const body of result.sql) {
          process.stdout.write(`${body}\n`);
        }
      } else {
        process.stdout.write(
          `applied: ${result.applied.join(", ") || "(none)"}\n`,
        );
      }
      return;
    }
    const result = await migrateDown(client, { dryRun });
    process.stdout.write(
      `${dryRun ? "dry-run rollback" : "rolled back"}: ${result.rolledBack ?? "(none)"}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
