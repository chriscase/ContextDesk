import {
  AUTH_ERROR_SCHEMA_ID,
  type AuthErrorV1,
  type AppRole,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  resolveActiveSession,
  type AuthRouteDeps,
} from "../auth/index.js";
import { canPerform, isAppRole, type MutableGroupRoleMap } from "./roles.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

export interface AuthzRouteDeps {
  auth: Pick<AuthRouteDeps, "sessions" | "policy">;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
}

export async function registerAuthzRoutes(
  app: FastifyInstance,
  deps: AuthzRouteDeps,
): Promise<void> {
  app.post("/api/authz/mutations", async (request, reply) => {
    return authorizeMutation(request, reply, deps, "mutate", "probe");
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
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      !("group" in body) ||
      !("role" in body) ||
      typeof (body as { group: unknown }).group !== "string" ||
      typeof (body as { role: unknown }).role !== "string" ||
      !isAppRole((body as { role: string }).role)
    ) {
      void reply.code(400);
      return authError("forbidden");
    }
    const group = (body as { group: string }).group;
    const role = (body as { role: AppRole }).role;
    deps.roles.set(group, role);
    await deps.audit.append({
      identity: session.identity.id,
      action: "role_mapping_update",
      target: `${group}=${role}`,
      origin: request.ip,
      outcome: "success",
    });
    return { ok: true, group, role };
  });
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
