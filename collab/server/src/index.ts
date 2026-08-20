import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createSqliteRuntime } from "./db/sqlite.js";
import { loadRuntimeConfig } from "./config.js";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { PgAuditStore, type AuditStore } from "./modules/audit/index.js";
import {
  LdapAuthAdapter,
  MemorySessionStore,
  PgSessionStore,
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  loadLocalAuthAdapter,
  loadLdapConfig,
  type SessionStore,
} from "./modules/auth/index.js";
import {
  MutableGroupRoleMap,
  parseGroupRoleMap,
  PgGroupRoleStore,
  type GroupRoleStore,
} from "./modules/authz/index.js";
import { CatalogService, PgCatalogStore, type CatalogStore } from "./modules/catalog/index.js";
import { CaseService, PgCaseStore, type CaseStore } from "./modules/cases/index.js";
import { ExportService, loadExportPrivacyConfig } from "./modules/export/index.js";
import { ImportService, PgRunStore, type RunStore } from "./modules/import/index.js";
import { ExperimentService, PgExperimentStore, type ExperimentStore } from "./modules/experiments/index.js";
import {
  PgTriageJobStore,
  parseTriageProfileCatalog,
  RustBridgeTriageExecutor,
  TriageRunService,
  type TriageJobStore,
} from "./modules/triage-runs/index.js";
import { PgPresenceBackend, PresenceService } from "./modules/presence/index.js";

interface StorageRuntime {
  pool: Pool | null;
  databaseProbe?: { ping(): void | Promise<void> };
  audit: AuditStore;
  sessions: SessionStore;
  roleStore: GroupRoleStore;
  catalog: CatalogStore;
  cases: CaseStore;
  runs: RunStore;
  experiments: ExperimentStore;
  jobs: TriageJobStore;
  presence: PresenceService;
}

function createStorage(config: ReturnType<typeof loadRuntimeConfig>): StorageRuntime {
  const bootstrapRoles = parseGroupRoleMap(process.env.COLLAB_GROUP_ROLE_MAP);
  if (config.storage === "sqlite") {
    const runtime = createSqliteRuntime(config.sqlitePath as string, bootstrapRoles);
    return {
      pool: null,
      databaseProbe: runtime.databaseProbe,
      audit: runtime.audit,
      sessions: runtime.sessions,
      roleStore: runtime.roleStore,
      catalog: runtime.catalog,
      cases: runtime.cases,
      runs: runtime.runs,
      experiments: runtime.experiments,
      jobs: runtime.jobs,
      presence: new PresenceService(),
    };
  }

  const pool = new Pool({ connectionString: config.databaseUrl as string });
  return {
    pool,
    audit: new PgAuditStore(pool),
    sessions: process.env.COLLAB_SESSION_STORE === "memory"
      ? new MemorySessionStore()
      : new PgSessionStore(pool),
    roleStore: new PgGroupRoleStore(pool, bootstrapRoles),
    catalog: new PgCatalogStore(pool),
    cases: new PgCaseStore(pool),
    runs: new PgRunStore(pool),
    experiments: new PgExperimentStore(pool),
    jobs: new PgTriageJobStore(pool),
    presence: new PresenceService(new PgPresenceBackend(pool)),
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const storage = createStorage(config);
  const store = new FilesystemEvidenceStore({ rootDir: config.evidenceRoot });
  await store.ping();
  const log = createAuthLog();
  const adapter = config.authMode === "local"
    ? loadLocalAuthAdapter()
    : new LdapAuthAdapter(loadLdapConfig(), log);
  const roles = new MutableGroupRoleMap(await storage.roleStore.load());
  const audit = storage.audit;
  const catalog = new CatalogService(storage.catalog, audit);
  const domain = new CaseService(store, audit, storage.cases, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases: domain,
    catalog,
    runs: storage.runs,
  });
  const experiments = new ExperimentService({
    cases: domain,
    audit,
    experiments: storage.experiments,
  });
  const triageRuns = new TriageRunService({
    cases: domain,
    audit,
    jobs: storage.jobs,
    ...(process.env.COLLAB_TRIAGE_WORKER_ID?.trim()
      ? { workerId: process.env.COLLAB_TRIAGE_WORKER_ID.trim() }
      : {}),
    ...(process.env.COLLAB_TRIAGE_RUNNER?.trim()
      ? {
          gatewayExecutor: new RustBridgeTriageExecutor({
            command: process.env.COLLAB_TRIAGE_RUNNER.trim(),
            ...(process.env.COLLAB_TRIAGE_LIBRARY?.trim()
              ? { library: process.env.COLLAB_TRIAGE_LIBRARY.trim() }
              : {}),
            ...(process.env.COLLAB_TRIAGE_RUNNER_DATA_DIR?.trim()
              ? { dataDir: process.env.COLLAB_TRIAGE_RUNNER_DATA_DIR.trim() }
              : {}),
            timeoutMs: Number.parseInt(process.env.COLLAB_TRIAGE_RUNNER_TIMEOUT_MS ?? "300000", 10),
          }),
        }
      : {}),
    profiles: parseTriageProfileCatalog(process.env.COLLAB_TRIAGE_PROFILE_CATALOG),
  });
  await triageRuns.recoverPending();
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: loadExportPrivacyConfig(),
  });
  const app = await buildApp({
    config,
    pool: storage.pool,
    ...(storage.databaseProbe ? { databaseProbe: storage.databaseProbe } : {}),
    store,
    domain,
    catalog,
    imports,
    triageRuns,
    presence: storage.presence,
    experiments,
    exporter,
    security: {
      auth: {
        adapter,
        sessions: storage.sessions,
        policy: defaultSessionPolicy,
        roles,
        audit,
        log,
        limiter: createRateLimiter({ maxFails: 5, windowMs: 15 * 60 * 1000 }),
        cookieSecure: process.env.COLLAB_COOKIE_SECURE !== "0",
      },
      roles,
      roleStore: storage.roleStore,
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
