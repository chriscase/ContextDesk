import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import {
  DuplicateEntityError,
  DuplicateInvolvementError,
  EntityNotFoundError,
  InvestigationNotVisibleError,
  RetiredEntityError,
  type EntityService,
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

/**
 * Domain failures map to codes a caller can act on. A contract violation is a
 * 400 with the offending path, because "the server said no" without saying
 * which field is what makes a form unusable.
 */
function domainError(
  reply: { code: (status: number) => unknown },
  error: unknown,
): { error: string; detail?: string; existingId?: string } {
  if (error instanceof InvestigationNotVisibleError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof EntityNotFoundError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof RetiredEntityError) {
    void reply.code(409);
    return { error: "entity_retired" };
  }
  if (error instanceof DuplicateEntityError) {
    void reply.code(409);
    return { error: "entity_exists", existingId: error.existingId };
  }
  if (error instanceof DuplicateInvolvementError) {
    void reply.code(409);
    return { error: "already_involved", existingId: error.existingId };
  }
  if (error instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${error.path}: ${error.detail}` };
  }
  void reply.code(400);
  return { error: "invalid", detail: error instanceof Error ? error.message : "invalid" };
}

export interface EntityRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  entities: EntityService;
  /** Investigation ids this reader may see, for the list-filter index. */
  visibleInvestigationIds: (actor: { id: string; username: string }, isAdmin: boolean)
    => Promise<string[]>;
}

export async function registerEntityRoutes(
  app: FastifyInstance,
  deps: EntityRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/entities", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const query = request.query as Record<string, unknown>;
    const filter: { kind?: string; lifecycle?: string; query?: string } = {};
    const kind = str(query.kind);
    if (kind !== undefined) filter.kind = kind;
    const lifecycle = str(query.lifecycle);
    if (lifecycle !== undefined) filter.lifecycle = lifecycle;
    const needle = str(query.q);
    if (needle !== undefined) filter.query = needle;
    try {
      return await deps.entities.listEntities(filter);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/entities", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "entity_create",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const body = asRecord(request.body);
    const kind = str(body.kind);
    if (kind === undefined) {
      void reply.code(400);
      return { error: "invalid", detail: "$.kind: missing required key" };
    }
    const input: {
      kind: string;
      label: unknown;
      profile?: unknown;
      privacyClass?: string;
    } = { kind, label: body.label };
    if (body.profile !== undefined) input.profile = body.profile;
    const privacyClass = str(body.privacyClass);
    if (privacyClass !== undefined) input.privacyClass = privacyClass;
    try {
      const reuse = body.reuseExisting === true;
      const created = reuse
        ? await deps.entities.resolveOrCreateEntity(ctx.actor, input, request.ip)
        : await deps.entities.createEntity(ctx.actor, input, request.ip);
      void reply.code(201);
      return created;
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/entities/:id", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    const patch: { label?: unknown; profile?: unknown; privacyClass?: string } = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.profile !== undefined) patch.profile = body.profile;
    const privacyClass = str(body.privacyClass);
    if (privacyClass !== undefined) patch.privacyClass = privacyClass;
    try {
      return await deps.entities.updateEntity(ctx.actor, id, patch, request.ip);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/entities/:id/retire", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    // Retiring changes what the whole installation can choose from, so it
    // needs the same standing as other catalog administration.
    if (!ctx.has("run:strategies")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "entity_retire",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const { id } = request.params as { id: string };
    try {
      return await deps.entities.retireEntity(ctx.actor, id, request.ip);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.get("/api/involvement/index", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const visible = await deps.visibleInvestigationIds(ctx.actor, ctx.isAdmin);
    return deps.entities.involvementIndex(ctx.actor, ctx.isAdmin, visible);
  });

  app.get("/api/cases/:caseId/involvement", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    try {
      return await deps.entities.listInvolvements(caseId, ctx.actor, ctx.isAdmin);
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/involvement", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "entity_involve",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    const body = asRecord(request.body);
    const entityId = str(body.entityId);
    const relationship = str(body.relationship);
    if (!entityId || !relationship) {
      void reply.code(400);
      return { error: "invalid", detail: "entityId and relationship are required" };
    }
    const input: {
      entityId: string;
      relationship: string;
      note?: unknown;
      occurredAt?: unknown;
      occurredAtPrecision?: unknown;
      occurredAtZone?: unknown;
    } = { entityId, relationship };
    if (body.note !== undefined) input.note = body.note;
    if (body.occurredAt !== undefined) input.occurredAt = body.occurredAt;
    if (body.occurredAtPrecision !== undefined) {
      input.occurredAtPrecision = body.occurredAtPrecision;
    }
    if (body.occurredAtZone !== undefined) input.occurredAtZone = body.occurredAtZone;
    try {
      const created = await deps.entities.recordInvolvement(
        caseId,
        ctx.actor,
        ctx.isAdmin,
        input,
        request.ip,
      );
      void reply.code(201);
      return created;
    } catch (error) {
      return domainError(reply, error);
    }
  });

  app.post("/api/cases/:caseId/involvement/:involvementId/release", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:write")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId, involvementId } = request.params as {
      caseId: string;
      involvementId: string;
    };
    try {
      return await deps.entities.releaseInvolvement(
        caseId,
        involvementId,
        ctx.actor,
        ctx.isAdmin,
        request.ip,
      );
    } catch (error) {
      return domainError(reply, error);
    }
  });
}
