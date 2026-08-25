import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import {
  InvestigationNotVisibleError,
  ResolutionRequiredError,
  ResolutionRevisionConflictError,
  type ResolutionInput,
  type ResolutionService,
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
 * Translates a request body into resolution input without deciding anything:
 * every domain rule stays in the contract and the service, so the route cannot
 * become a second, laxer definition of a valid resolution.
 */
export function resolutionInputFrom(raw: unknown): ResolutionInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  const body = asRecord(raw);
  const basis = str(body.basis);
  if (basis === undefined) throw new Error("a resolution must state its basis");
  const input: ResolutionInput = { basis, rationale: body.rationale };
  if (body.unknowns !== undefined) input.unknowns = body.unknowns;
  const provenance = str(body.provenance);
  if (provenance !== undefined) input.provenance = provenance;
  if (body.experimentDecisionId !== undefined) {
    input.experimentDecisionId = str(body.experimentDecisionId) ?? null;
  }
  if (body.exceptionReason !== undefined) {
    input.exceptionReason = str(body.exceptionReason) ?? null;
  }
  if (body.citedArtifactIds !== undefined) input.citedArtifactIds = body.citedArtifactIds;
  if (body.citedContributionIds !== undefined) {
    input.citedContributionIds = body.citedContributionIds;
  }
  if (body.occurredAt !== undefined) input.occurredAt = body.occurredAt;
  if (body.occurredAtPrecision !== undefined) input.occurredAtPrecision = body.occurredAtPrecision;
  if (body.occurredAtZone !== undefined) input.occurredAtZone = body.occurredAtZone;
  if (typeof body.expectedRevision === "number") input.expectedRevision = body.expectedRevision;
  return input;
}

export function resolutionDomainError(
  reply: { code: (status: number) => unknown },
  error: unknown,
): { error: string; detail?: string; status?: string; currentRevision?: number } | null {
  if (error instanceof ResolutionRequiredError) {
    void reply.code(409);
    return { error: "resolution_required", status: error.status };
  }
  if (error instanceof ResolutionRevisionConflictError) {
    void reply.code(409);
    return { error: "resolution_conflict", currentRevision: error.currentRevision };
  }
  if (error instanceof InvestigationNotVisibleError) {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error instanceof ContractViolation) {
    void reply.code(400);
    return { error: "invalid", detail: `${error.path}: ${error.detail}` };
  }
  return null;
}

export interface ResolutionRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  resolutions: ResolutionService;
}

export async function registerResolutionRoutes(
  app: FastifyInstance,
  deps: ResolutionRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/cases/:caseId/resolutions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    try {
      return await deps.resolutions.list(caseId, ctx.actor, ctx.isAdmin);
    } catch (error) {
      const mapped = resolutionDomainError(reply, error);
      if (mapped) return mapped;
      void reply.code(400);
      return { error: "invalid" };
    }
  });

  app.post("/api/cases/:caseId/resolutions", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    // Concluding an investigation is the same standing as accepting a
    // decision: a contributor can record findings, a case lead concludes.
    if (!ctx.has("decision:accept")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "investigation_resolution_record",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const { caseId } = request.params as { caseId: string };
    try {
      const input = resolutionInputFrom(request.body);
      if (!input) {
        void reply.code(400);
        return { error: "invalid", detail: "a resolution body is required" };
      }
      const created = await deps.resolutions.recordForCase(
        caseId,
        ctx.actor,
        ctx.isAdmin,
        input,
        request.ip,
      );
      void reply.code(201);
      return created;
    } catch (error) {
      const mapped = resolutionDomainError(reply, error);
      if (mapped) return mapped;
      void reply.code(400);
      return { error: "invalid", detail: error instanceof Error ? error.message : "invalid" };
    }
  });
}
