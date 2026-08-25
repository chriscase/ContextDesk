import {
  ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  parseAdminRoleMappingList,
  parseAdminRoleMappingRevokeRequest,
  parseAdminRoleMappingUpdateRequest,
  type AppRole,
  type AdminRoleMappingErrorCode,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  authorizeSession,
  capabilityForbidden,
  sessionAuthFailure,
  type SessionAuthorizationDeps,
} from "./session-authorization.js";
import type { MutableGroupRoleMap } from "./roles.js";
import type { GroupRoleStore } from "./store.js";

function roleMappingError(error: AdminRoleMappingErrorCode) {
  return { schemaId: ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID, error };
}

export interface AuthzRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  roles: MutableGroupRoleMap;
  roleStore: GroupRoleStore;
  audit: AuditStore;
}

export async function registerAuthzRoutes(
  app: FastifyInstance,
  deps: AuthzRouteDeps,
): Promise<void> {
  app.post("/api/authz/mutations", async (request, reply) => {
    return authorizeMutation(request, reply, deps, "mutate", "probe");
  });

  app.get("/api/authz/group-role-map", async (request, reply) => {
    const resolved = await authorizeSession(request, deps.sessionAuth);
    if (resolved.kind !== "ok") return sessionAuthFailure(reply, resolved);
    if (!resolved.ctx.has("admin:system_config")) {
      await recordAuditBestEffort(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "role_mapping_read",
        target: "current",
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }

    try {
      const mapping = await deps.roleStore.load();
      const entries = [...mapping.entries.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const response = {
        schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
        mappings: entries
          .slice(0, ADMIN_ROLE_MAPPING_MAX_RESULTS)
          .map(([group, role]) => ({ group, role })),
        limit: ADMIN_ROLE_MAPPING_MAX_RESULTS,
        truncated: entries.length > ADMIN_ROLE_MAPPING_MAX_RESULTS,
      };
      parseAdminRoleMappingList(response);
      await deps.audit.append({
        identity: resolved.ctx.identity.id,
        action: "role_mapping_read",
        target: "current",
        origin: request.ip,
        outcome: "success",
      });
      return response;
    } catch {
      await recordAuditBestEffort(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "role_mapping_read",
        target: "current",
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(503);
      return roleMappingError("unavailable");
    }
  });

  app.put("/api/authz/group-role-map", async (request, reply) => {
    const resolved = await authorizeSession(request, deps.sessionAuth);
    if (resolved.kind !== "ok") return sessionAuthFailure(reply, resolved);
    if (!resolved.ctx.has("admin:system_config")) {
      await deps.audit.append({
        identity: resolved.ctx.identity.id,
        action: "role_mapping_update",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }
    let update: { group: string; role: AppRole };
    try {
      update = parseAdminRoleMappingUpdateRequest(request.body);
    } catch {
      void reply.code(400);
      return roleMappingError("invalid_request");
    }
    const { group, role } = update;
    try {
      await deps.roleStore.set(group, role, resolved.ctx.identity.id);
    } catch {
      const audit = await recordAudit(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "role_mapping_update",
        target: `${group}=${role}`,
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(503);
      return { ...roleMappingError("unavailable"), audit };
    }
    deps.roles.set(group, role);
    const audit = await recordAudit(deps.audit, {
      identity: resolved.ctx.identity.id,
      action: "role_mapping_update",
      target: `${group}=${role}`,
      origin: request.ip,
      outcome: "success",
    });
    return { ok: true, group, role, audit };
  });

  app.delete("/api/authz/group-role-map", async (request, reply) => {
    const resolved = await authorizeSession(request, deps.sessionAuth);
    if (resolved.kind !== "ok") return sessionAuthFailure(reply, resolved);
    if (!resolved.ctx.has("admin:system_config")) {
      await deps.audit.append({
        identity: resolved.ctx.identity.id,
        action: "role_mapping_revoke",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }
    let group: string;
    try {
      group = parseAdminRoleMappingRevokeRequest(request.body).group;
    } catch {
      void reply.code(400);
      return roleMappingError("invalid_request");
    }
    let deleted: boolean;
    try {
      deleted = await deps.roleStore.delete(group);
    } catch {
      const audit = await recordAudit(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "role_mapping_revoke",
        target: group,
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(503);
      return { ...roleMappingError("unavailable"), audit };
    }
    if (!deleted) {
      const audit = await recordAudit(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "role_mapping_revoke",
        target: group,
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(404);
      return { ...roleMappingError("not_found"), audit };
    }
    deps.roles.delete(group);
    const audit = await recordAudit(deps.audit, {
      identity: resolved.ctx.identity.id,
      action: "role_mapping_revoke",
      target: group,
      origin: request.ip,
      outcome: "success",
    });
    return { ok: true, group, revoked: true, audit };
  });
}

async function recordAudit(
  audit: AuditStore,
  record: Parameters<AuditStore["append"]>[0],
): Promise<"recorded" | "failed"> {
  try {
    await audit.append(record);
    return "recorded";
  } catch {
    return "failed";
  }
}

async function recordAuditBestEffort(
  audit: AuditStore,
  record: Parameters<AuditStore["append"]>[0],
): Promise<void> {
  try {
    await audit.append(record);
  } catch {
    // The caller returns no mapping bytes on failure or denial.
  }
}

async function authorizeMutation(
  request: FastifyRequest,
  reply: { code: (n: number) => unknown },
  deps: AuthzRouteDeps,
  _action: "mutate",
  target: string,
) {
  const resolved = await authorizeSession(request, deps.sessionAuth);
  if (resolved.kind !== "ok") return sessionAuthFailure(reply, resolved);
  if (!resolved.ctx.has("investigation:write")) {
    await deps.audit.append({
      identity: resolved.ctx.identity.id,
      action: "mutation",
      target,
      origin: request.ip,
      outcome: "denied",
    });
    return capabilityForbidden(reply);
  }
  await deps.audit.append({
    identity: resolved.ctx.identity.id,
    action: "mutation",
    target,
    origin: request.ip,
    outcome: "success",
  });
  return { ok: true };
}
