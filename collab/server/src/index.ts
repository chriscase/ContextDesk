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
  bindRecoveryAuthorization,
  type GroupRoleStore,
} from "./modules/authz/index.js";
import { CatalogService, PgCatalogStore, type CatalogStore } from "./modules/catalog/index.js";
import { CaseService, PgCaseStore, type CaseStore } from "./modules/cases/index.js";
import { ExportService, loadExportPrivacyConfig } from "./modules/export/index.js";
import { ImportService, PgRunStore, type RunStore } from "./modules/import/index.js";
import { ExperimentService, PgExperimentStore, type ExperimentStore } from "./modules/experiments/index.js";
import {
  PgTriageJobStore,
  loadConfiguredTriageProfileCatalog,
  RustBridgeTriageExecutor,
  triageBridgeOptions,
  TriageRunService,
  type TriageJobStore,
} from "./modules/triage-runs/index.js";
import { PgPresenceBackend, PresenceService } from "./modules/presence/index.js";
import {
  PgLocalGrantStore,
  PgUserProfileStore,
  type LocalGrantStore,
  type UserProfileStore,
} from "./modules/people/index.js";
import {
  loadPortableInstallationId,
  memoryApplyBoundary,
  PgPortableApplyStateStore,
  PortableInvestigationService,
  type PortableApplyStateStore,
  withPgApplyTransaction,
} from "./modules/portable-investigations/index.js";

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
  applyState: PortableApplyStateStore;
  profiles: UserProfileStore;
  grants: LocalGrantStore;
  runPortableTransaction?: <T>(operation: () => Promise<T>) => Promise<T>;
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
      applyState: runtime.applyState,
      profiles: runtime.profiles,
      grants: runtime.grants,
      runPortableTransaction: runtime.runPortableTransaction,
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
    applyState: new PgPortableApplyStateStore(pool),
    profiles: new PgUserProfileStore(pool),
    grants: new PgLocalGrantStore(pool),
    presence: new PresenceService(new PgPresenceBackend(pool)),
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const storage = createStorage(config);
  const store = new FilesystemEvidenceStore({
    rootDir: config.evidenceRoot,
    ...(storage.pool
      ? {
          acquireWriteLease: async () => {
            const client = await storage.pool!.connect();
            try {
              await client.query(
                `SELECT pg_advisory_lock(hashtextextended('contextdesk-evidence-write-v1', 0))`,
              );
              return async () => {
                try {
                  await client.query(
                    `SELECT pg_advisory_unlock(hashtextextended('contextdesk-evidence-write-v1', 0))`,
                  );
                } finally {
                  client.release();
                }
              };
            } catch (error) {
              client.release(error instanceof Error ? error : undefined);
              throw error;
            }
          },
        }
      : {}),
  });
  await store.ping();
  store.addReferencedContentHashSource(() => storage.cases.listReferencedContentHashes());
  store.addReferencedContentHashSource(() => storage.runs.listReferencedContentHashes());
  await store.recoverUnreferencedWrites();
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
  const bridge = triageBridgeOptions();
  const triageRuns = new TriageRunService({
    cases: domain,
    audit,
    jobs: storage.jobs,
    recoveryAuthorization: bindRecoveryAuthorization({
      lookupGroups: (identity) => adapter.lookupGroups(identity),
      roles,
      profiles: storage.profiles,
      grants: storage.grants,
    }),
    ...(process.env.COLLAB_TRIAGE_WORKER_ID?.trim()
      ? { workerId: process.env.COLLAB_TRIAGE_WORKER_ID.trim() }
      : {}),
    ...(bridge
      ? {
          gatewayExecutor: new RustBridgeTriageExecutor(bridge),
        }
      : {}),
    profiles: loadConfiguredTriageProfileCatalog(),
  });
  await triageRuns.recoverPending();
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: loadExportPrivacyConfig(),
  });
  const persistPorts = {
    cases: storage.cases,
    catalog: storage.catalog,
    experiments: storage.experiments,
    runs: storage.runs,
    jobs: storage.jobs,
    evidence: store,
    audit,
    applyState: storage.applyState,
  };
  const memoryBoundary =
    storage.pool === null
      ? memoryApplyBoundary({
          ...persistPorts,
          ...(storage.runPortableTransaction
            ? { runDurably: storage.runPortableTransaction }
            : {}),
        })
      : null;
  const installationId = await loadPortableInstallationId(
    config.evidenceRoot,
    process.env.COLLAB_INSTALLATION_ID,
  );
  const portable = new PortableInvestigationService({
    installationId,
    cases: domain,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState: storage.applyState,
    applyCoordination: storage.pool === null ? "single_instance" : "postgres_transactional",
    confirmationRestartDurable: storage.pool !== null || config.storage === "sqlite",
    ...(memoryBoundary
      ? { withTransaction: memoryBoundary.withTransaction }
      : {
          withTransaction: (operation) =>
            withPgApplyTransaction(storage.pool as NonNullable<typeof storage.pool>, store, operation),
        }),
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
    portable,
    installationId,
    profiles: storage.profiles,
    grants: storage.grants,
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
