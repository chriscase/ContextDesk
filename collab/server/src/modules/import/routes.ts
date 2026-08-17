import {
  AUTH_ERROR_SCHEMA_ID,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import type { ImportService } from "./service.js";

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

export interface ImportRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  imports: ImportService;
}

export async function registerImportRoutes(
  app: FastifyInstance,
  deps: ImportRouteDeps,
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
    };
  }

  app.get("/api/cases/:id/imports", async (request, reply) => {
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
      schemaId: "cd-collab.external_run_list.v1",
      runs: await deps.imports.listRuns(id, ctx.actor, ctx.isAdmin),
    };
  });

  app.post("/api/cases/:id/imports", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "external_run_import",
        target: "forbidden",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const id = (request.params as { id: string }).id;
    const body = asRecord(request.body);
    const outputText = str(body.outputText);
    const sourceId = str(body.sourceId);
    const operatorId = str(body.operatorId);
    const operatorUsername = str(body.operatorUsername);
    if (!outputText || !sourceId || !operatorId || !operatorUsername) {
      void reply.code(400);
      return { error: "outputText, sourceId, operatorId, and operatorUsername are required" };
    }
    const input: Parameters<ImportService["importRun"]>[2] = {
      outputText,
      sourceId,
      operatorId,
      operatorUsername,
    };
    const promptText = str(body.promptText);
    if (promptText !== undefined) input.promptText = promptText;
    const promptCompleteness = str(body.promptCompleteness);
    if (promptCompleteness) input.promptCompleteness = promptCompleteness;
    const outputCompleteness = str(body.outputCompleteness);
    if (outputCompleteness) input.outputCompleteness = outputCompleteness;
    const workflowCompleteness = str(body.workflowCompleteness);
    if (workflowCompleteness) input.workflowCompleteness = workflowCompleteness;
    const evidenceVisibility = str(body.evidenceVisibility);
    if (evidenceVisibility) input.evidenceVisibility = evidenceVisibility;
    if (body.snapshotBinding === null) input.snapshotBinding = null;
    else {
      const snapshotBinding = str(body.snapshotBinding);
      if (snapshotBinding) input.snapshotBinding = snapshotBinding;
    }
    const visibilityNote = str(body.visibilityNote);
    if (visibilityNote !== undefined) input.visibilityNote = visibilityNote;
    const provider = str(body.provider);
    if (provider !== undefined) input.provider = provider;
    const model = str(body.model);
    if (model !== undefined) input.model = model;
    const version = str(body.version);
    if (version !== undefined) input.version = version;
    if (Array.isArray(body.claimedTraces)) {
      input.claimedTraces = body.claimedTraces.filter((item): item is string => typeof item === "string");
    }
    const uncertainty = str(body.uncertainty);
    if (uncertainty !== undefined) input.uncertainty = uncertainty;
    const timing = str(body.timing);
    if (timing !== undefined) input.timing = timing;
    const cost = str(body.cost);
    if (cost !== undefined) input.cost = cost;
    if (body.redacted === true) input.redacted = true;
    try {
      return await deps.imports.importRun(id, ctx.actor, input, request.ip, ctx.isAdmin);
    } catch (err) {
      void reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid" };
    }
  });

  app.get("/api/cases/:id/imports/:rid", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; rid: string };
    const found = await deps.imports.getRun(params.id, params.rid, ctx.actor, ctx.isAdmin);
    if (!found) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return found;
  });

  app.post("/api/cases/:id/imports/:rid/corroborate", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canWrite) {
      void reply.code(403);
      return authError("forbidden");
    }
    const params = request.params as { id: string; rid: string };
    const body = asRecord(request.body);
    const state = str(body.state);
    if (state !== "corroborated" && state !== "contradicted") {
      void reply.code(400);
      return { error: "state must be corroborated or contradicted" };
    }
    const links = Array.isArray(body.links)
      ? (body.links as { kind: "artifact" | "contribution"; id: string }[])
      : [];
    try {
      return await deps.imports.corroborate(
        params.id,
        params.rid,
        ctx.actor,
        { state, links },
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      void reply.code(400);
      return { error: err instanceof Error ? err.message : "invalid" };
    }
  });
}
