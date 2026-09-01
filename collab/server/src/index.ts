import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createSqliteRuntime } from "./db/sqlite.js";
import { loadRuntimeConfig } from "./config.js";
import { createPostgresEvidenceWriteLease } from "./evidence/lease.js";
import { createEvidenceStore } from "./evidence/provider.js";
import { loadEvidenceS3Credentials } from "./evidence/s3-secrets.js";
import {
  LogTimeService,
  MemoryLogTimeStore,
  PgLogTimeStore,
  ProcessLogTimeBridge,
  createLogTimeCasePort,
  logTimeBridgeOptions,
} from "./modules/log-time/index.js";
import {
  MemoryWorkbenchStore,
  PgWorkbenchStore,
  WorkbenchService,
  createWorkbenchCasePort,
} from "./modules/workbench/index.js";
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
  loadPublicIdentityCodec,
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
import {
  ModelPurposePolicyService,
  PgModelPurposePolicyStore,
  type ModelPurposePolicyStore,
} from "./modules/model-policy/index.js";
import {
  PgStrategyGovernanceStore,
  StrategyGovernanceService,
  type StrategyGovernanceStore,
} from "./modules/strategy-governance/index.js";
import { PgPresenceBackend, PresenceService } from "./modules/presence/index.js";
import {
  PgLocalGrantStore,
  PgUserProfileStore,
  type LocalGrantStore,
  type UserProfileStore,
} from "./modules/people/index.js";
import { EntityService, PgEntityStore, type EntityStore } from "./modules/entities/index.js";
import {
  PgSoftwareImpactStore,
  SoftwareImpactService,
  type SoftwareImpactStore,
} from "./modules/software-impact/index.js";
import { ReferenceService, PgReferenceStore, type ReferenceStore } from "./modules/references/index.js";
import {
  ResolutionService,
  PgResolutionStore,
  type ResolutionStore,
} from "./modules/resolutions/index.js";
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
  modelPolicy: ModelPurposePolicyStore;
  strategyGovernance: StrategyGovernanceStore;
  applyState: PortableApplyStateStore;
  profiles: UserProfileStore;
  grants: LocalGrantStore;
  entities: EntityStore;
  softwareImpact: SoftwareImpactStore | null;
  references: ReferenceStore;
  resolutions: ResolutionStore;
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
      modelPolicy: runtime.modelPolicy,
      strategyGovernance: runtime.strategyGovernance,
      applyState: runtime.applyState,
      profiles: runtime.profiles,
      grants: runtime.grants,
      entities: runtime.entities,
      softwareImpact: runtime.softwareImpact,
      references: runtime.references,
      resolutions: runtime.resolutions,
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
    modelPolicy: new PgModelPurposePolicyStore(pool),
    strategyGovernance: new PgStrategyGovernanceStore(pool),
    applyState: new PgPortableApplyStateStore(pool),
    profiles: new PgUserProfileStore(pool),
    grants: new PgLocalGrantStore(pool),
    entities: new PgEntityStore(pool),
    softwareImpact: new PgSoftwareImpactStore(pool),
    references: new PgReferenceStore(pool),
    resolutions: new PgResolutionStore(pool),
    presence: new PresenceService(new PgPresenceBackend(pool)),
  };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const storage = createStorage(config);
  const store = createEvidenceStore({
    settings: config.evidence,
    ...(config.evidence.provider === "s3"
      ? { credentials: loadEvidenceS3Credentials(process.env) }
      : {}),
    ...(storage.pool
      ? {
          writeLeasePool: storage.pool,
          createWriteLease: createPostgresEvidenceWriteLease,
        }
      : {}),
  });
  store.addReferencedContentHashSource(() => storage.cases.listReferencedContentHashes());
  store.addReferencedContentHashSource(() => storage.runs.listReferencedContentHashes());
  await store.ping();
  await store.recoverUnreferencedWrites();
  const publicIdentities = await loadPublicIdentityCodec(
    config.evidenceRoot,
    process.env.COLLAB_PUBLIC_IDENTITY_KEY,
  );
  const log = createAuthLog();
  const ldapConfig = config.authMode === "ldap" ? loadLdapConfig() : null;
  const adapter = ldapConfig
    ? new LdapAuthAdapter(ldapConfig, log)
    : loadLocalAuthAdapter();
  const roles = new MutableGroupRoleMap(await storage.roleStore.load());
  const audit = storage.audit;
  const catalog = new CatalogService(storage.catalog, audit);
  // The resolution service is constructed first so it can guard status
  // transitions on the case service, and is then given the case service back
  // as its investigation gateway. The dependency is genuinely mutual: the
  // guard needs to read investigations, and the transition needs the guard.
  const resolutions = new ResolutionService({
    store: storage.resolutions,
    audit,
  });
  const domain = new CaseService(store, audit, storage.cases, catalog, resolutions);
  const investigations = {
    getCase: (id: string, actor: { id: string; username: string }, isAdmin: boolean) =>
      domain.getCase(id, actor, isAdmin),
    appendDomainTimeline: (
      caseId: string,
      event: {
        kind: string;
        actor: { id: string; username: string };
        targetId: string | null;
        clientTime: string | null;
        payload: unknown;
      },
    ) => domain.appendDomainTimeline(caseId, event),
  };
  resolutions.bindInvestigations(investigations);
  const entities = new EntityService({
    store: storage.entities,
    audit,
    investigations,
  });
  const softwareImpact = storage.softwareImpact
    ? new SoftwareImpactService({
        store: storage.softwareImpact,
        audit,
        investigations,
      })
    : null;
  const references = new ReferenceService({
    store: storage.references,
    audit,
    investigations,
  });
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
  // Log-time review needs the shipped host pipeline. With no host binary or
  // no corpus root configured, the routes stay unregistered rather than
  // offering a review surface that cannot answer. The workbench still serves
  // investigation-owned intake bytes without that host.
  const logTimeStore =
    storage.pool === null ? new MemoryLogTimeStore() : new PgLogTimeStore(storage.pool);
  const logTimeBridge = logTimeBridgeOptions();
  const logTime = logTimeBridge
    ? new LogTimeService({
        store: logTimeStore,
        bridge: new ProcessLogTimeBridge(logTimeBridge),
        cases: createLogTimeCasePort({
          cases: storage.cases,
          domain,
          evidence: store,
          jobs: storage.jobs,
        }),
        audit,
      })
    : null;
  domain.bindNormalizationRevision(async (caseId) =>
    (await logTimeStore.getCorpus(caseId))?.corpusRevision ?? null,
  );
  const workbench = new WorkbenchService({
    store:
      storage.pool === null ? new MemoryWorkbenchStore() : new PgWorkbenchStore(storage.pool),
    cases: createWorkbenchCasePort({
      cases: storage.cases,
      domain,
      evidence: store,
      currentNormalizationRevision: async (caseId) =>
        (await logTimeStore.getCorpus(caseId))?.corpusRevision ?? null,
      ...(logTime
        ? {
            listHostEventStamps: async (caseId, sources, k) => {
              const listed = await logTime.listWorkbenchEvents(caseId, sources ?? [], k);
              if (!listed) return null;
              return listed.search.hits.map((hit) => ({
                source: hit.source,
                message: hit.message,
                ts: hit.ts,
                timeQuality: hit.timeQuality,
                unresolvedLocalTimestamp: hit.unresolvedLocalTimestamp,
              }));
            },
            // The shipped host owns timestamp resolution, so a time-filtered
            // workbench search is answered against its corpus rather than
            // against whichever intake lines happened to carry an offset.
            hostSearch: async (caseId, input) => {
              const found = await logTime.searchWorkbench(caseId, input);
              if (!found) return null;
              return {
                corpusRevision: found.corpusRevision,
                stamps: found.search.hits.map((hit) => ({
                  source: hit.source,
                  message: hit.message,
                  ts: hit.ts,
                  timeQuality: hit.timeQuality,
                  unresolvedLocalTimestamp: hit.unresolvedLocalTimestamp,
                })),
                bounded: found.search.bounded,
                atLeast: found.search.atLeast,
                cancelled: found.search.cancelled,
                diagnostic: found.search.diagnostic,
              };
            },
          }
        : {}),
    }),
    audit,
  });
  const bridge = triageBridgeOptions();
  const triageProfiles = loadConfiguredTriageProfileCatalog();
  const modelPolicy = new ModelPurposePolicyService({
    store: storage.modelPolicy,
    profiles: triageProfiles,
  });
  const strategyGovernance = new StrategyGovernanceService({
    store: storage.strategyGovernance,
    audit,
  });
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
    profiles: triageProfiles,
    modelPolicy,
  });
  await triageRuns.recoverPending();
  const exporter = new ExportService({
    cases: domain,
    catalog,
    imports,
    audit,
    privacy: loadExportPrivacyConfig(),
    record: {
      involvementFor: (caseId) => entities.involvementsForExport(caseId),
      entityPrivacy: () => entities.entityPrivacyMap(),
      referencesFor: (caseId) => references.exportProjection(caseId),
      activeResolutionFor: (caseId) => resolutions.active(caseId),
    },
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
    publicIdentities,
    cases: domain,
    catalog,
    imports,
    triageRuns,
    experiments,
    audit,
    applyState: storage.applyState,
    probe: {
      cases: storage.cases,
      catalog: storage.catalog,
      experiments: storage.experiments,
      runs: storage.runs,
      jobs: storage.jobs,
    },
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
    ...(logTime ? { logTime } : {}),
    workbench,
    domain,
    catalog,
    imports,
    triageRuns,
    modelPolicy,
    strategyGovernance,
    presence: storage.presence,
    experiments,
    exporter,
    portable,
    entities,
    ...(softwareImpact ? { softwareImpact } : {}),
    references,
    resolutions,
    installationId,
    publicIdentities,
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
      ldapConfig,
    },
  });
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
