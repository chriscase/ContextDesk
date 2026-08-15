import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { PgAuditStore } from "./modules/audit/index.js";
import {
  LdapAuthAdapter,
  MemorySessionStore,
  PgSessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  loadLdapConfig,
} from "./modules/auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "./modules/authz/index.js";
import { CatalogService, PgCatalogStore } from "./modules/catalog/index.js";
import { CaseService, PgCaseStore } from "./modules/cases/index.js";
import { ExportService, loadExportPrivacyConfig } from "./modules/export/index.js";
import { ImportService, PgRunStore } from "./modules/import/index.js";

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const ldap = loadLdapConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new FilesystemEvidenceStore({ rootDir: config.evidenceRoot });
  await store.ping();
  const log = createAuthLog();
  const adapter = new LdapAuthAdapter(ldap, log);
  const sessions = process.env.COLLAB_SESSION_STORE === "memory"
    ? new MemorySessionStore()
    : new PgSessionStore(pool);
  const roles = new MutableGroupRoleMap(
    parseGroupRoleMap(process.env.COLLAB_GROUP_ROLE_MAP),
  );
  const audit = new PgAuditStore(pool);
  const catalog = new CatalogService(new PgCatalogStore(pool), audit);
  const domain = new CaseService(store, audit, new PgCaseStore(pool), catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases: domain,
    catalog,
    runs: new PgRunStore(pool),
  });
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: loadExportPrivacyConfig(),
  });
  const app = await buildApp({
    config,
    pool,
    store,
    domain,
    catalog,
    imports,
    exporter,
    security: {
      auth: {
        adapter,
        sessions,
        policy: defaultSessionPolicy,
        roles,
        audit,
        log,
        limiter: createRateLimiter({ maxFails: 5, windowMs: 15 * 60 * 1000 }),
        cookieSecure: process.env.COLLAB_COOKIE_SECURE !== "0",
      },
      roles,
      audit,
    },
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
