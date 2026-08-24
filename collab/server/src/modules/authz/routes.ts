import {
  ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  AUTH_ERROR_SCHEMA_ID,
  parseAdminRoleMappingList,
  parseAdminRoleMappingRevokeRequest,
  parseAdminRoleMappingUpdateRequest,
  type AuthErrorV1,
  type AppRole,
  type AdminRoleMappingErrorCode,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  resolveActiveSession,
  type ActiveSessionDeps,
} from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "./roles.js";
import type { GroupRoleStore } from "./store.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function roleMappingError(error: AdminRoleMappingErrorCode) {
  return { schemaId: ADMIN_ROLE_MAPPING_ERROR_SCHEMA_ID, error };
}

export interface AuthzRouteDeps {
  auth: ActiveSessionDeps;
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
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!canPerform(deps.roles.resolve(session.groups), "admin")) {
      await recordAuditBestEffort(deps.audit, {
        identity: session.identity.id,
        action: "role_mapping_read",
        target: "current",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
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
        identity: session.identity.id,
        action: "role_mapping_read",
        target: "current",
        origin: request.ip,
        outcome: "success",
      });
      return response;
    } catch {
      await recordAuditBestEffort(deps.audit, {
        identity: session.identity.id,
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
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const roles = deps.roles.resolve(session.groups);
    if (!canPerform(roles, "admin")) {
      await deps.audit.append({
        identity: session.identity.id,
        action: "role_mapping_update",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
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
      await deps.roleStore.set(group, role, session.identity.id);
    } catch {
      const audit = await recordAudit(deps.audit, {
        identity: session.identity.id,
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
      identity: session.identity.id,
      action: "role_mapping_update",
      target: `${group}=${role}`,
      origin: request.ip,
      outcome: "success",
    });
    return { ok: true, group, role, audit };
  });

  app.delete("/api/authz/group-role-map", async (request, reply) => {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const roles = deps.roles.resolve(session.groups);
    if (!canPerform(roles, "admin")) {
      await deps.audit.append({
        identity: session.identity.id,
        action: "role_mapping_revoke",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
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
        identity: session.identity.id,
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
        identity: session.identity.id,
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
      identity: session.identity.id,
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
  action: "mutate",
  target: string,
) {
  const session = await resolveActiveSession(request, deps.auth);
  if (!session) {
    void reply.code(401);
    return authError("unauthenticated");
  }
  const roles = deps.roles.resolve(session.groups);
  if (!canPerform(roles, action)) {
    await deps.audit.append({
      identity: session.identity.id,
      action: "mutation",
      target,
      origin: request.ip,
      outcome: "denied",
    });
    void reply.code(403);
    return authError("forbidden");
  }
  await deps.audit.append({
    identity: session.identity.id,
    action: "mutation",
    target,
    origin: request.ip,
    outcome: "success",
  });
  return { ok: true };
}
