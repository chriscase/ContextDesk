import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseSourceCreateRequest,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { projectSourceForCaller } from "./project.js";
import {
  CatalogCommitOutcomeUnknownError,
  CatalogMutationRefusedError,
  CatalogPermanentUnknownError,
  CatalogVersionedSourceError,
  type CatalogService,
} from "./service.js";

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

function presentSchemaId(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!Object.hasOwn(body, "schemaId")) return undefined;
  return (body as Record<string, unknown>).schemaId;
}

function invalid(reply: FastifyReply) {
  void reply.code(400);
  return { error: "invalid" };
}

function unknownCommit(reply: FastifyReply) {
  void reply.code(503);
  return { error: "commit_outcome_unknown" };
}

function internal(reply: FastifyReply) {
  void reply.code(500);
  return { error: "internal" };
}

async function denyCatalogWrite(
  reply: FastifyReply,
  deps: CatalogRouteDeps,
  request: FastifyRequest,
  ctx: { actor: { id: string } },
  action: "catalog_create" | "catalog_retire" | "catalog_restore",
) {
  await deps.audit.append({
    identity: ctx.actor.id,
    action,
    target: "forbidden",
    origin: request.ip,
    outcome: "denied",
  });
  void reply.code(403);
  return authError("forbidden");
}

export interface CatalogRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  catalog: CatalogService;
}

export async function registerCatalogRoutes(
  app: FastifyInstance,
  deps: CatalogRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/catalog/sources", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const sources = (await deps.catalog.list()).map((source) =>
      projectSourceForCaller(source, ctx.has("admin:users")),
    );
    return {
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources,
    };
  });

  app.post("/api/catalog/sources", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const schemaId = presentSchemaId(request.body);
    if (schemaId !== undefined) {
      if (!ctx.has("catalog:write")) {
        return denyCatalogWrite(reply, deps, request, ctx, "catalog_create");
      }
      if (schemaId !== SOURCE_CREATE_REQUEST_SCHEMA_ID) {
        return invalid(reply);
      }
      try {
        const parsed = parseSourceCreateRequest(request.body);
        const result = await deps.catalog.applyCreate(ctx.actor, parsed, request.ip);
        void reply.code(result.replayed ? 200 : 201);
        return result;
      } catch (err) {
        return strictMutationError(reply, err);
      }
    }
    if (!ctx.has("run:strategies")) {
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
      return legacyMutationError(reply, err, "create");
    }
  });

  app.post("/api/catalog/sources/:id", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    if (presentSchemaId(request.body) !== undefined) {
      void reply.code(400);
      return { error: "invalid" };
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
      return legacyMutationError(reply, err, "update");
    }
  });

  app.post("/api/catalog/sources/:id/retire", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const schemaId = presentSchemaId(request.body);
    const id = (request.params as { id: string }).id;
    if (schemaId !== undefined) {
      if (!ctx.has("catalog:write")) {
        return denyCatalogWrite(reply, deps, request, ctx, "catalog_retire");
      }
      if (schemaId !== SOURCE_RETIRE_REQUEST_SCHEMA_ID) {
        return invalid(reply);
      }
      try {
        const parsed = parseSourceRetireRequest(request.body);
        if (parsed.sourceId !== id) return invalid(reply);
        const result = await deps.catalog.applyRetire(ctx.actor, parsed, request.ip);
        void reply.code(200);
        return result;
      } catch (err) {
        return strictMutationError(reply, err);
      }
    }
    if (!ctx.has("run:strategies")) {
      void reply.code(403);
      return authError("forbidden");
    }
    try {
      return await deps.catalog.retire(ctx.actor, id, request.ip);
    } catch (err) {
      return legacyMutationError(reply, err, "retire");
    }
  });

  app.post("/api/catalog/sources/:id/restore", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("catalog:write")) {
      return denyCatalogWrite(reply, deps, request, ctx, "catalog_restore");
    }
    const schemaId = presentSchemaId(request.body);
    if (schemaId !== SOURCE_RESTORE_REQUEST_SCHEMA_ID) {
      return invalid(reply);
    }
    const id = (request.params as { id: string }).id;
    try {
      const parsed = parseSourceRestoreRequest(request.body);
      if (parsed.sourceId !== id) return invalid(reply);
      const result = await deps.catalog.applyRestore(ctx.actor, parsed, request.ip);
      void reply.code(200);
      return result;
    } catch (err) {
      return strictMutationError(reply, err);
    }
  });
}

function strictMutationError(reply: FastifyReply, err: unknown) {
  if (err instanceof CatalogCommitOutcomeUnknownError) {
    return unknownCommit(reply);
  }
  if (err instanceof CatalogMutationRefusedError) {
    void reply.code(409);
    return err.body;
  }
  if (err instanceof ContractViolation) {
    return invalid(reply);
  }
  return internal(reply);
}

function legacyMutationError(
  reply: FastifyReply,
  err: unknown,
  kind: "create" | "update" | "retire",
) {
  if (err instanceof CatalogCommitOutcomeUnknownError) {
    return unknownCommit(reply);
  }
  if (err instanceof CatalogVersionedSourceError) {
    void reply.code(409);
    return { error: "versioned_source" };
  }
  if (err instanceof CatalogPermanentUnknownError) {
    void reply.code(409);
    return { error: "permanent_unknown_protected" };
  }
  if (kind === "create") {
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("unknown source kind:")) return invalid(reply);
    return internal(reply);
  }
  const message = err instanceof Error ? err.message : "";
  if (message === "source not found") {
    void reply.code(404);
    return { error: "not_found" };
  }
  return internal(reply);
}
