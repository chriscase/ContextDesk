import {
  AUTH_ERROR_SCHEMA_ID,
  HELPFULNESS_DIMENSIONS,
  type AuthErrorV1,
  type ExpectedRelationshipV1,
  type HelpfulnessDimension,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { ImportService } from "../import/index.js";
import type { TriageRunService } from "../triage-runs/index.js";
import {
  ExperimentConflictError,
  ExperimentNotFoundError,
  ExperimentService,
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

function isDimension(value: string): value is HelpfulnessDimension {
  return (HELPFULNESS_DIMENSIONS as readonly string[]).includes(value);
}

export interface ExperimentRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  experiments: ExperimentService;
  imports?: ImportService;
  triageRuns?: TriageRunService;
}

export async function registerExperimentRoutes(
  app: FastifyInstance,
  deps: ExperimentRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
      canWrite: canPerform(roles, "mutate"),
      canLead: canPerform(roles, "lead"),
    };
  }

  function fail(
    reply: { code: (status: number) => unknown },
    err: unknown,
  ): { error: string; code?: string } {
    if (err instanceof ExperimentNotFoundError) {
      void reply.code(404);
      return { error: err.message };
    }
    if (err instanceof ExperimentConflictError) {
      void reply.code(409);
      return { error: err.message, code: err.code };
    }
    void reply.code(400);
    return { error: err instanceof Error ? err.message : "invalid" };
  }

  app.get("/api/cases/:id/experiments", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    return {
      schemaId: "cd-collab.experiment_list.v1",
      experiments: await deps.experiments.list(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/experiments", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "experiment_import",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    try {
      return await deps.experiments.importEnvelope(
        id,
        ctx.actor,
        request.body,
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/from-triage/:jid", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    if (!deps.triageRuns || !deps.imports) {
      void reply.code(503);
      return { error: "triage-to-experiment handoff is not configured" };
    }
    const params = request.params as { id: string; jid: string };
    const body = asRecord(request.body);
    const externalRunId = body.externalRunId === null ? null : str(body.externalRunId) ?? null;
    try {
      const job = await deps.triageRuns.get(params.id, params.jid, ctx.actor, ctx.isAdmin);
      if (!job) {
        void reply.code(404);
        return { error: "not_found" };
      }
      const externalRun = externalRunId
        ? await deps.imports.getRun(params.id, externalRunId, ctx.actor, ctx.isAdmin)
        : null;
      if (externalRunId && !externalRun) {
        void reply.code(404);
        return { error: "external_run_not_found" };
      }
      return await deps.experiments.importTriageJob(
        params.id,
        ctx.actor,
        job,
        externalRun,
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/cases/:id/experiments/:eid", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    const found = await deps.experiments.get(params.id, params.eid, ctx.actor, ctx.isAdmin);
    if (!found) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return found;
  });

  app.post("/api/cases/:id/experiments/:eid/helpfulness", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    const body = asRecord(request.body);
    const dimension = str(body.dimension);
    const candidateId = str(body.candidateId);
    const rationale = str(body.rationale);
    if (!candidateId || !dimension || !isDimension(dimension) || !rationale) {
      void reply.code(400);
      return { error: "candidateId, dimension, score, and rationale are required" };
    }
    const evidenceRefs = Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((item): item is string => typeof item === "string")
      : [];
    try {
      return await deps.experiments.recordHelpfulness(
        params.id,
        params.eid,
        ctx.actor,
        {
          candidateId,
          dimension,
          score: typeof body.score === "number" ? body.score : Number.NaN,
          rationale,
          evidenceRefs,
        },
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/decisions", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    const body = asRecord(request.body);
    const text = str(body.text);
    const rationale = str(body.rationale);
    if (!text || !rationale) {
      void reply.code(400);
      return { error: "text and rationale are required" };
    }
    const evidenceRefs = Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((item): item is string => typeof item === "string")
      : [];
    const remainingUnknowns = Array.isArray(body.remainingUnknowns)
      ? body.remainingUnknowns.filter((item): item is string => typeof item === "string")
      : undefined;
    if (body.remainingUnknowns !== undefined && remainingUnknowns === undefined) {
      void reply.code(400);
      return { error: "remainingUnknowns must be an array" };
    }
    const ownerAssignment = body.ownerAssignment;
    if (
      ownerAssignment !== undefined &&
      ownerAssignment !== "self" &&
      ownerAssignment !== "unassigned"
    ) {
      void reply.code(400);
      return { error: "ownerAssignment must be self or unassigned" };
    }
    const expectedRevision =
      typeof body.expectedRevision === "number" ? body.expectedRevision : null;
    try {
      return await deps.experiments.proposeDecision(
        params.id,
        params.eid,
        ctx.actor,
        {
          text,
          rationale,
          evidenceRefs,
          ...(remainingUnknowns === undefined ? {} : { remainingUnknowns }),
          ...(ownerAssignment === undefined
            ? {}
            : { owner: ownerAssignment === "self" ? ctx.actor : null }),
          expectedRevision,
        },
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/decisions/:did/accept", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    const body = asRecord(request.body);
    if (typeof body.expectedRevision !== "number") {
      void reply.code(400);
      return { error: "expectedRevision is required" };
    }
    try {
      return await deps.experiments.acceptDecision(
        params.id,
        params.eid,
        ctx.actor,
        body.expectedRevision,
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/gold", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    const body = asRecord(request.body);
    const decisionId = str(body.decisionId);
    if (!decisionId || typeof body.expectedRevision !== "number") {
      void reply.code(400);
      return { error: "decisionId and expectedRevision are required" };
    }
    const evidenceAnchors = Array.isArray(body.evidenceAnchors)
      ? body.evidenceAnchors.filter((item): item is string => typeof item === "string")
      : [];
    const expectedRelationships = Array.isArray(body.expectedRelationships)
      ? body.expectedRelationships.flatMap((item): ExpectedRelationshipV1[] => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          return typeof row.evidenceRef === "string" && typeof row.role === "string"
            ? [{ evidenceRef: row.evidenceRef, role: row.role }]
            : [];
        })
      : undefined;
    const helpfulnessDimensions = Array.isArray(body.helpfulnessDimensions)
      ? body.helpfulnessDimensions.filter(
          (item): item is HelpfulnessDimension =>
            typeof item === "string" && isDimension(item),
        )
      : undefined;
    const notes = Array.isArray(body.notes)
      ? body.notes.filter((item): item is string => typeof item === "string")
      : undefined;
    const expectedGoldVersion =
      typeof body.expectedGoldVersion === "number" ? body.expectedGoldVersion : null;
    try {
      return await deps.experiments.promoteGold(
        params.id,
        params.eid,
        ctx.actor,
        {
          decisionId,
          expectedRevision: body.expectedRevision,
          expectedGoldVersion,
          evidenceAnchors,
          ...(expectedRelationships ? { expectedRelationships } : {}),
          ...(helpfulnessDimensions ? { helpfulnessDimensions } : {}),
          ...(notes ? { notes } : {}),
        },
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/traces", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    try {
      return await deps.experiments.importTrace(
        params.id,
        params.eid,
        ctx.actor,
        request.body,
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/traces/:cid/annotations", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string; cid: string };
    const body = asRecord(request.body);
    const text = str(body.text);
    if (!text) {
      void reply.code(400);
      return { error: "text is required" };
    }
    const evidenceRefs = Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((item): item is string => typeof item === "string")
      : [];
    try {
      return await deps.experiments.annotateTrace(
        params.id,
        params.eid,
        ctx.actor,
        {
          candidateId: params.cid,
          text,
          evidenceRefs,
          parentEventId: str(body.parentEventId) ?? null,
        },
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/cases/:id/experiments/:eid/export", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canLead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; eid: string };
    try {
      const payload = await deps.experiments.exportShareSafe(
        params.id,
        params.eid,
        ctx.actor,
        ctx.isAdmin,
      );
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "experiment_review_export",
        target: params.eid,
        origin: request.ip,
        outcome: "success",
      });
      return payload;
    } catch (err) {
      return fail(reply, err);
    }
  });
}
