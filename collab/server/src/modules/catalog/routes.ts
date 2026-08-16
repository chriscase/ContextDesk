import {
  AUTH_ERROR_SCHEMA_ID,
  SOURCE_LIST_SCHEMA_ID,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type AuthRouteDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { CatalogService } from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface CatalogRouteDeps {
  auth: Pick<AuthRouteDeps, "sessions" | "policy">;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  catalog: CatalogService;
}

export async function registerCatalogRoutes(
  app: FastifyInstance,
  deps: CatalogRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      canRead: canPerform(roles, "read"),
      canLead: canPerform(roles, "lead"),
    };
  }

  app.get("/api/catalog/sources", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    return {
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: await deps.catalog.list(),
    };
  });

  app.post("/api/catalog/sources", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "catalog_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const name = str(body.name);
    const kind = str(body.kind);
    if (!name || !kind) {
      void reply.code(400);
      return authError("forbidden");
    }
    const input: {
      name: string;
      kind: string;
      description?: string | null;
      identityId?: string | null;
    } = { name, kind };
    const description = str(body.description);
    if (description !== undefined) input.description = description;
    const identityId = str(body.identityId);
    if (identityId !== undefined) input.identityId = identityId;
    try {
      return await deps.catalog.create(ctx.actor, input, request.ip);
    } catch (err) {
      void reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid" };
    }
  });

  app.post("/api/catalog/sources/:id", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    const name = str(asRecord(request.body).name);
    if (!name) {
      void reply.code(400);
      return authError("forbidden");
    }
    const description = str(asRecord(request.body).description);
    try {
      const patch: { name: string; description?: string | null } = { name };
      if (description !== undefined) patch.description = description;
      return await deps.catalog.update(ctx.actor, id, patch, request.ip);
    } catch (err) {
      void reply.code(404);
      return { error: err instanceof Error ? err.message : "not_found" };
    }
  });

  app.post("/api/catalog/sources/:id/retire", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    try {
      return await deps.catalog.retire(ctx.actor, id, request.ip);
    } catch (err) {
      void reply.code(404);
      return { error: err instanceof Error ? err.message : "not_found" };
    }
  });
}
