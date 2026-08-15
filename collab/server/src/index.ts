import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new FilesystemEvidenceStore({ rootDir: config.evidenceRoot });
  await store.ping();
  const app = await buildApp({ config, pool, store });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
