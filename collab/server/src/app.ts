import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import {
  HEALTH_SCHEMA_ID,
  READY_SCHEMA_ID,
  type HealthResponseV1,
  type ReadyResponseV1,
} from "@cd-collab/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { latestMigrationVersion } from "./db/migrate.js";
import type { EvidenceStore } from "./evidence/store.js";
import {
  registerAuthRoutes,
  registerBrowserMutationCsrfGuard,
  createEphemeralPublicIdentityCodec,
  type AuthRouteDeps,
  type LdapConfig,
  type LdapSessionFactory,
  type PublicIdentityCodec,
} from "./modules/auth/index.js";
import {
  MemoryGroupRoleStore,
  registerAuthzRoutes,
  type GroupRoleStore,
  type MutableGroupRoleMap,
  type SessionAuthorizationDeps,
} from "./modules/authz/index.js";
import type { AuditStore } from "./modules/audit/index.js";
import { registerAdminAuditRoutes } from "./modules/audit/index.js";
import { registerAdminDirectoryRoutes, registerLdapAdminRoutes } from "./modules/admin/index.js";
import {
  registerComponentHealthRoutes,
  runtimeComponentHealth,
  type ComponentHealthProvider,
} from "./modules/component-health/index.js";
import { registerCatalogRoutes, type CatalogService } from "./modules/catalog/index.js";
import { registerCaseRoutes, type CaseService } from "./modules/cases/index.js";
import { registerCorpusIntakeRoutes } from "./modules/corpus-intake/index.js";
import { registerExportRoutes, type ExportService } from "./modules/export/index.js";
import { registerImportRoutes, type ImportService } from "./modules/import/index.js";
import { registerTriageRunRoutes, type TriageRunService } from "./modules/triage-runs/index.js";
import { registerPresenceRoutes, type PresenceService } from "./modules/presence/index.js";
import {
  registerExperimentRoutes,
  type ExperimentService,
} from "./modules/experiments/index.js";
import { registerOverviewRoutes } from "./modules/overview/index.js";
import { registerInvestigationActivityRoutes } from "./modules/activity/index.js";
import {
  registerPortableInvestigationRoutes,
  type PortableInvestigationService,
} from "./modules/portable-investigations/index.js";
import {
  registerAdminPeopleRoutes,
  registerSelfProfileRoutes,
  MemoryLocalGrantStore,
  MemoryUserProfileStore,
  type LocalGrantStore,
  type UserProfileStore,
} from "./modules/people/index.js";
import { registerSetupRoutes, type SetupService } from "./modules/setup/index.js";

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

const ADMIN_DIRECTORY_DIAGNOSTIC_PATHS = new Set([
  "/api/admin/directory/groups/search",
  "/api/admin/directory/identities/search",
  "/api/admin/directory/mapping/preview",
  "/api/admin/ldap/config",
  "/api/admin/ldap/test",
  "/api/authz/group-role-map",
]);

function mayExposeAdminDiagnostic(url: string, statusCode: number): boolean {
  if (statusCode < 200 || statusCode >= 300) return false;
  return ADMIN_DIRECTORY_DIAGNOSTIC_PATHS.has(requestPath(url));
}

export interface SecurityDeps {
  auth: AuthRouteDeps;
  roles: MutableGroupRoleMap;
  roleStore?: GroupRoleStore;
  audit: AuditStore;
  ldapConfig?: LdapConfig | null;
  ldapSessions?: LdapSessionFactory;
}

export interface AppDeps {
  config: Config;
  pool: Pick<Pool, "query"> | null;
  databaseProbe?: { ping(): void | Promise<void> };
  store: Pick<EvidenceStore, "ping">;
  security?: SecurityDeps;
  domain?: CaseService;
  catalog?: CatalogService;
  imports?: ImportService;
  triageRuns?: TriageRunService;
  presence?: PresenceService;
  experiments?: ExperimentService;
  exporter?: ExportService;
  portable?: PortableInvestigationService;
  setup?: SetupService;
  /** Canonical user profile store. Also wires login-time profile sync onto security.auth. */
  profiles?: UserProfileStore;
  grants?: LocalGrantStore;
  componentHealth?: ComponentHealthProvider;
  serveStatic?: boolean;
  installationId?: string;
  publicIdentities?: PublicIdentityCodec;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const publicIdentities = deps.publicIdentities
    ?? (process.env.NODE_ENV === "test" ? createEphemeralPublicIdentityCodec() : null);
  if (deps.security && !publicIdentities) {
    throw new Error("a durable public identity codec is required when authentication is enabled");
  }
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  registerBrowserMutationCsrfGuard(app);
  const requiredMigrationVersion = latestMigrationVersion();

  app.get("/health", async (): Promise<HealthResponseV1> => {
    return {
      schemaId: HEALTH_SCHEMA_ID,
      status: "ok",
      service: deps.config.serviceName,
    };
  });

  app.get("/ready", async (_request, reply): Promise<ReadyResponseV1> => {
    let database: "up" | "down" = "down";
    let evidenceStore: "up" | "down" = "down";
    if (deps.pool) {
      try {
        const migrated = await deps.pool.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1",
          [requiredMigrationVersion],
        );
        if (migrated.rowCount !== 1) throw new Error("required migration is not applied");
        database = "up";
      } catch {
        database = "down";
      }
    } else if (deps.databaseProbe) {
      try {
        await deps.databaseProbe.ping();
        database = "up";
      } catch {
        database = "down";
      }
    }
    try {
      await deps.store.ping();
      evidenceStore = "up";
    } catch {
      evidenceStore = "down";
    }
    const status = database === "up" && evidenceStore === "up" ? "ready" : "not_ready";
    const body: ReadyResponseV1 = {
      schemaId: READY_SCHEMA_ID,
      status,
      database,
      evidenceStore,
    };
    if (status !== "ready") {
      void reply.code(503);
    }
    return body;
  });

  if (deps.setup) {
    await registerSetupRoutes(app, { setup: deps.setup });
  }

  if (deps.security) {
    const security = deps.security;
    app.addHook("preSerialization", async (request, reply, payload) => {
      if (!requestPath(request.url).startsWith("/api/")
        || mayExposeAdminDiagnostic(request.url, reply.statusCode)) return payload;
      return publicIdentities!.sanitizePayload(payload);
    });
    app.addHook("onSend", async (request, reply, payload) => {
      if (!requestPath(request.url).startsWith("/api/")
        || mayExposeAdminDiagnostic(request.url, reply.statusCode)
        || typeof payload !== "string") {
        return payload;
      }
      const sanitized = publicIdentities!.sanitizeText(payload);
      if (publicIdentities!.containsDirectoryDn(sanitized)) {
        void reply.code(500);
        return JSON.stringify({ error: "identity_projection_failed" });
      }
      return sanitized;
    });
    const roleStore = security.roleStore ?? new MemoryGroupRoleStore(security.roles);
    const profiles = deps.profiles ?? new MemoryUserProfileStore();
    const grants = deps.grants ?? new MemoryLocalGrantStore();
    const sessionAuth: SessionAuthorizationDeps = {
      auth: security.auth,
      roles: security.roles,
      profiles,
      grants,
    };
    app.addHook("onRequest", async (request) => {
      if (!request.url.startsWith("/api/")) return;
      if (request.url.startsWith("/api/setup/")) return;
      security.roles.replace(await roleStore.load());
    });
    await registerAuthRoutes(app, {
      ...security.auth,
      profiles,
      grants,
    });
    await registerSelfProfileRoutes(app, {
      sessionAuth,
      audit: security.audit,
      profiles,
      publicIdentities: publicIdentities!,
    });
    await registerAdminPeopleRoutes(app, {
      sessionAuth,
      audit: security.audit,
      profiles,
      grants,
    });
    await registerAuthzRoutes(app, {
      sessionAuth,
      roles: security.roles,
      roleStore,
      audit: security.audit,
    });
    await registerAdminDirectoryRoutes(app, {
      sessionAuth,
      audit: security.audit,
    });
    await registerLdapAdminRoutes(app, {
      sessionAuth,
      audit: security.audit,
      ldapConfig: security.ldapConfig ?? null,
      ...(security.ldapSessions ? { sessions: security.ldapSessions } : {}),
    });
    await registerComponentHealthRoutes(app, {
      sessionAuth,
      provider: deps.componentHealth ?? (() => runtimeComponentHealth(deps.config)),
    });
    await registerAdminAuditRoutes(app, {
      sessionAuth,
      audit: security.audit,
    });
    if (deps.domain) {
      await registerCaseRoutes(app, {
        sessionAuth,
        audit: security.audit,
        domain: deps.domain,
        ...(deps.experiments ? { experiments: deps.experiments } : {}),
      });
      await registerInvestigationActivityRoutes(app, {
        sessionAuth,
        domain: deps.domain,
        installationId: deps.installationId ?? "inst-unconfigured000000",
        publicIdentities: publicIdentities!,
      });
      await registerCorpusIntakeRoutes(app, {
        sessionAuth,
        audit: security.audit,
        domain: deps.domain,
      });
    }
    if (deps.catalog) {
      await registerCatalogRoutes(app, {
        sessionAuth,
        audit: security.audit,
        catalog: deps.catalog,
      });
    }
    if (deps.imports) {
      await registerImportRoutes(app, {
        sessionAuth,
        audit: security.audit,
        imports: deps.imports,
      });
    }
    if (deps.triageRuns) {
      await registerTriageRunRoutes(app, {
        sessionAuth,
        audit: security.audit,
        runs: deps.triageRuns,
        ...(deps.domain ? { cases: deps.domain } : {}),
      });
    }
    if (deps.domain && deps.presence) {
      await registerPresenceRoutes(app, {
        sessionAuth,
        cases: deps.domain,
        presence: deps.presence,
      });
    }
    if (deps.experiments) {
      await registerExperimentRoutes(app, {
        sessionAuth,
        audit: security.audit,
        experiments: deps.experiments,
        ...(deps.imports ? { imports: deps.imports } : {}),
        ...(deps.triageRuns ? { triageRuns: deps.triageRuns } : {}),
      });
    }
    if (deps.domain && deps.experiments && deps.triageRuns && deps.presence) {
      await registerOverviewRoutes(app, {
        sessionAuth,
        cases: deps.domain,
        experiments: deps.experiments,
        triageRuns: deps.triageRuns,
        presence: deps.presence,
      });
    }
    if (deps.exporter) {
      await registerExportRoutes(app, {
        sessionAuth,
        audit: security.audit,
        exporter: deps.exporter,
      });
    }
    if (deps.portable) {
      await registerPortableInvestigationRoutes(app, {
        sessionAuth,
        audit: security.audit,
        portable: deps.portable,
      });
    }
  }

  const staticDir =
    deps.config.staticDir ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (deps.serveStatic !== false && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        void reply.sendFile("index.html");
        return;
      }
      void reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
