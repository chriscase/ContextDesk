import {
  AUTH_ERROR_SCHEMA_ID,
  LDAP_ADMIN_ERROR_SCHEMA_ID,
  parseLdapProbeRequest,
  parseLdapPublicConfig,
  type AuthErrorV1,
  type LdapAdminErrorCode,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  hasCsrfHeader,
  probeLdap,
  publicLdapConfig,
  type LdapConfig,
  type LdapSessionFactory,
} from "../auth/index.js";
import {
  authorizeSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";

export interface LdapAdminRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  ldapConfig: LdapConfig | null;
  sessions?: LdapSessionFactory;
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function ldapError(error: LdapAdminErrorCode) {
  return { schemaId: LDAP_ADMIN_ERROR_SCHEMA_ID, error };
}

function publishedAuthMode(config: LdapConfig | null): "ldap" | "local" {
  return config ? "ldap" : "local";
}

async function authorizeAdmin(
  request: FastifyRequest,
  deps: LdapAdminRouteDeps,
): Promise<"ok" | "unauthenticated" | "forbidden" | "unavailable"> {
  const resolved = await authorizeSession(request, deps.sessionAuth);
  if (resolved.kind === "unavailable") return "unavailable";
  if (resolved.kind !== "ok") return "unauthenticated";
  if (!resolved.ctx.has("admin:system_config")) return "forbidden";
  return "ok";
}

async function recordAudit(
  audit: AuditStore,
  record: Parameters<AuditStore["append"]>[0],
): Promise<void> {
  try {
    await audit.append(record);
  } catch {
    // best-effort
  }
}

function originOf(request: FastifyRequest): string {
  return request.ip;
}

export async function registerLdapAdminRoutes(
  app: FastifyInstance,
  deps: LdapAdminRouteDeps,
): Promise<void> {
  app.get("/api/admin/ldap/config", async (request, reply) => {
    const authorized = await authorizeAdmin(request, deps);
    if (authorized === "unauthenticated") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (authorized === "forbidden") {
      void reply.code(403);
      return authError("forbidden");
    }
    if (authorized === "unavailable") {
      void reply.code(503);
      return ldapError("unavailable");
    }
    const authMode = publishedAuthMode(deps.ldapConfig);
    return parseLdapPublicConfig(publicLdapConfig(deps.ldapConfig, authMode));
  });

  app.post("/api/admin/ldap/test", async (request, reply) => {
    const authorized = await authorizeAdmin(request, deps);
    if (authorized === "unauthenticated") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (authorized === "forbidden") {
      void reply.code(403);
      return authError("forbidden");
    }
    if (authorized === "unavailable") {
      void reply.code(503);
      return ldapError("unavailable");
    }
    if (!hasCsrfHeader(request)) {
      void reply.code(403);
      return authError("forbidden");
    }

    let probeUsername: string | null = null;
    let probePassword: string | null = null;
    try {
      const parsed = parseLdapProbeRequest(request.body);
      probeUsername = parsed.probeUsername;
      probePassword = parsed.probePassword;
    } catch {
      void reply.code(400);
      return ldapError("invalid_request");
    }

    const mapping = deps.sessionAuth.roles.snapshot();
    const authMode = publishedAuthMode(deps.ldapConfig);
    const result = await probeLdap({
      config: deps.ldapConfig,
      authMode,
      probeUsername,
      probePassword,
      resolveRoles: (groups) => deps.sessionAuth.roles.resolve(groups),
      roleMapConfigured: mapping.entries.size > 0,
      sessions: deps.sessions,
    });
    await recordAudit(deps.audit, {
      identity: null,
      action: "ldap_probe",
      target: result.ready ? "ready" : "not_ready",
      origin: originOf(request),
      outcome: result.ready ? "success" : "failure",
    });
    const serialized = JSON.stringify(result);
    if (probePassword && serialized.includes(probePassword)) {
      void reply.code(500);
      return ldapError("unavailable");
    }
    if (deps.ldapConfig?.bindPassword && serialized.includes(deps.ldapConfig.bindPassword)) {
      void reply.code(500);
      return ldapError("unavailable");
    }
    return result;
  });
}
