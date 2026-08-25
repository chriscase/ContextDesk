import {
  ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
  ADMIN_PEOPLE_ERROR_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_SCHEMA_ID,
  AUTH_ERROR_SCHEMA_ID,
  computeDirectoryMappingPreview,
  parseAdminDirectoryMappingPreviewRequest,
  parseAdminPeopleGrantRequest,
  parseAdminPeopleListRequest,
  parseAdminPeopleListResponse,
  parseAdminPeopleRevokeRequest,
  parseAdminPeopleStatusRequest,
  type AdminPeopleErrorCode,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  authorizeSession,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { effectiveCapabilityRows } from "./capabilities.js";
import { hasCsrfHeader } from "./csrf.js";
import type { LocalGrantStore } from "./grants.js";
import { IdempotencyCache } from "./idempotency.js";
import type { UserProfileStore } from "./store.js";

export interface AdminPeopleRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  profiles: UserProfileStore;
  grants: LocalGrantStore;
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function peopleError(error: AdminPeopleErrorCode) {
  return { schemaId: ADMIN_PEOPLE_ERROR_SCHEMA_ID, error };
}

/**
 * Session -> profile -> capability, in that order. Authorization is always
 * decided before a target user is ever looked up, so a caller lacking
 * admin:users gets an identical 403 whether the target id exists or not -
 * no enumeration signal leaks through the error path. Inactive or historical
 * callers fail closed as unauthenticated.
 */
async function authorize(
  request: FastifyRequest,
  deps: AdminPeopleRouteDeps,
  capability: "admin:users" | "admin:system_config",
): Promise<AuthorizedSession | "unauthenticated" | "forbidden" | "unavailable"> {
  const resolved = await authorizeSession(request, deps.sessionAuth);
  if (resolved.kind === "unavailable") return "unavailable";
  if (resolved.kind !== "ok") return "unauthenticated";
  if (!resolved.ctx.has(capability)) return "forbidden";
  return resolved.ctx;
}

async function recordAudit(
  audit: AuditStore,
  record: Parameters<AuditStore["append"]>[0],
): Promise<void> {
  try {
    await audit.append(record);
  } catch {
    // Best-effort: the caller has already decided the HTTP outcome: a
    // successful mutation is not undone by a failed audit write, and a
    // failed/denied outcome returns no additional data either way.
  }
}

const idempotency = new IdempotencyCache();

async function withIdempotency(
  reply: FastifyReply,
  scopeKey: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<unknown> {
  const cached = idempotency.get(scopeKey);
  if (cached) {
    void reply.code(cached.status);
    return cached.body;
  }
  const result = await run();
  idempotency.set(scopeKey, result);
  void reply.code(result.status);
  return result.body;
}

export async function registerAdminPeopleRoutes(
  app: FastifyInstance,
  deps: AdminPeopleRouteDeps,
): Promise<void> {
  app.post("/api/admin/people/search", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:users");
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
      return peopleError("unavailable");
    }
    let query: ReturnType<typeof parseAdminPeopleListRequest>;
    try {
      query = parseAdminPeopleListRequest(request.body);
    } catch {
      void reply.code(400);
      return peopleError("invalid_request");
    }
    try {
      const page = await deps.profiles.list(query);
      const response = parseAdminPeopleListResponse({
        schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
        people: page.people,
        nextCursor: page.nextCursor,
      });
      await recordAudit(deps.audit, {
        identity: authorized.identity.id,
        action: "people_search",
        target: query.term.length > 0 ? "filtered" : "all",
        origin: request.ip,
        outcome: "success",
      });
      return response;
    } catch {
      await recordAudit(deps.audit, {
        identity: authorized.identity.id,
        action: "people_search",
        target: "error",
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(503);
      return peopleError("unavailable");
    }
  });

  app.get("/api/admin/people/:id/effective", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:users");
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
      return peopleError("unavailable");
    }
    const id = (request.params as { id: string }).id;
    const target = await deps.profiles.getById(id);
    if (!target) {
      void reply.code(404);
      return peopleError("not_found");
    }
    let groups: string[] = [];
    try {
      groups = await deps.sessionAuth.auth.adapter.lookupGroups({
        id: target.id,
        username: target.username,
        displayName: target.displayName,
      });
    } catch {
      groups = [];
    }
    const roles = deps.sessionAuth.roles.resolve(groups);
    const grants = await deps.grants.list(id);
    await recordAudit(deps.audit, {
      identity: authorized.identity.id,
      action: "people_effective_read",
      target: id,
      origin: request.ip,
      outcome: "success",
    });
    return {
      schemaId: ADMIN_PEOPLE_EFFECTIVE_SCHEMA_ID,
      userId: id,
      roles,
      capabilities: effectiveCapabilityRows(roles, grants),
    };
  });

  app.post("/api/admin/people/:id/status", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:users");
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
      return peopleError("unavailable");
    }
    if (!hasCsrfHeader(request)) {
      void reply.code(403);
      return peopleError("csrf_required");
    }
    const id = (request.params as { id: string }).id;
    let body: ReturnType<typeof parseAdminPeopleStatusRequest>;
    try {
      body = parseAdminPeopleStatusRequest(request.body);
    } catch {
      void reply.code(400);
      return peopleError("invalid_request");
    }
    return withIdempotency(
      reply,
      `people_status:${id}:${body.idempotencyKey}`,
      async () => {
        const result = await deps.profiles.setStatus(id, body.status, body.expectedRevision);
        if (result.outcome === "ok") {
          if (body.status === "suspended" || body.status === "disabled") {
            await deps.sessionAuth.auth.sessions.revokeAllForIdentity(id);
          }
          await recordAudit(deps.audit, {
            identity: authorized.identity.id,
            action: "people_status_update",
            target: `${id}=${body.status}`,
            origin: request.ip,
            outcome: "success",
          });
          return { status: 200, body: { schemaId: result.profile.schemaId, profile: result.profile } };
        }
        await recordAudit(deps.audit, {
          identity: authorized.identity.id,
          action: "people_status_update",
          target: `${id}=${body.status}`,
          origin: request.ip,
          outcome: "failure",
        });
        if (result.outcome === "not_found") return { status: 404, body: peopleError("not_found") };
        return { status: 409, body: peopleError("stale_revision") };
      },
    );
  });

  app.post("/api/admin/people/:id/grants", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:users");
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
      return peopleError("unavailable");
    }
    if (!hasCsrfHeader(request)) {
      void reply.code(403);
      return peopleError("csrf_required");
    }
    const id = (request.params as { id: string }).id;
    let body: ReturnType<typeof parseAdminPeopleGrantRequest>;
    try {
      body = parseAdminPeopleGrantRequest(request.body);
    } catch {
      void reply.code(400);
      return peopleError("invalid_request");
    }
    return withIdempotency(
      reply,
      `people_grant:${id}:${body.idempotencyKey}`,
      async () => {
        const target = await deps.profiles.getById(id);
        if (!target) {
          await recordAudit(deps.audit, {
            identity: authorized.identity.id,
            action: "people_grant",
            target: `${id}:${body.capability}`,
            origin: request.ip,
            outcome: "failure",
          });
          return { status: 404, body: peopleError("not_found") };
        }
        // Historical/imported attribution stubs never authenticate and
        // must never hold a capability, no matter who asks.
        if (target.provenance === "imported_historical") {
          await recordAudit(deps.audit, {
            identity: authorized.identity.id,
            action: "people_grant",
            target: `${id}:${body.capability}`,
            origin: request.ip,
            outcome: "denied",
          });
          return { status: 403, body: peopleError("forbidden") };
        }
        await deps.grants.grant(id, body.capability, authorized.identity.id);
        await recordAudit(deps.audit, {
          identity: authorized.identity.id,
          action: "people_grant",
          target: `${id}:${body.capability}`,
          origin: request.ip,
          outcome: "success",
        });
        return { status: 200, body: { ok: true, userId: id, capability: body.capability } };
      },
    );
  });

  app.delete("/api/admin/people/:id/grants", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:users");
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
      return peopleError("unavailable");
    }
    if (!hasCsrfHeader(request)) {
      void reply.code(403);
      return peopleError("csrf_required");
    }
    const id = (request.params as { id: string }).id;
    let body: ReturnType<typeof parseAdminPeopleRevokeRequest>;
    try {
      body = parseAdminPeopleRevokeRequest(request.body);
    } catch {
      void reply.code(400);
      return peopleError("invalid_request");
    }
    return withIdempotency(
      reply,
      `people_revoke:${id}:${body.idempotencyKey}`,
      async () => {
        await deps.grants.revoke(id, body.capability);
        await recordAudit(deps.audit, {
          identity: authorized.identity.id,
          action: "people_revoke",
          target: `${id}:${body.capability}`,
          origin: request.ip,
          outcome: "success",
        });
        return { status: 200, body: { ok: true, userId: id, capability: body.capability } };
      },
    );
  });

  app.post("/api/admin/directory/mapping/preview", async (request, reply) => {
    const authorized = await authorize(request, deps, "admin:system_config");
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
      return peopleError("unavailable");
    }
    let body: ReturnType<typeof parseAdminDirectoryMappingPreviewRequest>;
    try {
      body = parseAdminDirectoryMappingPreviewRequest(request.body);
    } catch {
      void reply.code(400);
      return peopleError("invalid_request");
    }
    try {
      const preview = computeDirectoryMappingPreview(body);
      await recordAudit(deps.audit, {
        identity: authorized.identity.id,
        action: "directory_mapping_preview",
        target: "sample",
        origin: request.ip,
        outcome: "success",
      });
      return preview;
    } catch {
      await recordAudit(deps.audit, {
        identity: authorized.identity.id,
        action: "directory_mapping_preview",
        target: "sample",
        origin: request.ip,
        outcome: "failure",
      });
      void reply.code(400);
      return peopleError("invalid_request");
    }
  });
}
