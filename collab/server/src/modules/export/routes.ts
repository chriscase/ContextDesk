import {
  AUTH_ERROR_SCHEMA_ID,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import { ExportService, PrivacyScanError, isPrivacyClass, type ExportSelection } from "./service.js";

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

export interface ExportRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  exporter: ExportService;
}

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: ExportRouteDeps,
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

  function canExport(
    variant: string,
    ctx: { canRead: boolean; canWrite: boolean; canLead: boolean },
  ): boolean {
    if (!ctx.canRead) return false;
    if (variant === "share_safe") return ctx.canLead;
    return ctx.canWrite;
  }

  app.get("/api/cases/:id/export/inventory", async (request, reply) => {
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
    const found = await deps.exporter.inventory(id, ctx.actor, ctx.isAdmin);
    if (!found) {
      void reply.code(404);
      return { error: "not_found" };
    }
    return found;
  });

  app.post("/api/cases/:id/export/brief", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const id = (request.params as { id: string }).id;
    const variant = str(asRecord(request.body).variant) ?? "share_safe";
    if (!isPrivacyClass(variant)) {
      void reply.code(400);
      return { error: "variant must be owner_only or share_safe" };
    }
    if (!canExport(variant, ctx)) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "export_brief",
        target: `${id}:${variant}`,
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    try {
      return await deps.exporter.exportBrief(id, ctx.actor, variant, request.ip, ctx.isAdmin);
    } catch (err) {
      return exportError(reply, err, ctx.actor.id, "export_brief", `${id}:${variant}`, request.ip);
    }
  });

  app.post("/api/cases/:id/export/package", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const id = (request.params as { id: string }).id;
    const body = asRecord(request.body);
    const variant = str(body.variant) ?? "share_safe";
    if (!isPrivacyClass(variant)) {
      void reply.code(400);
      return { error: "variant must be owner_only or share_safe" };
    }
    if (!canExport(variant, ctx)) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "export_package",
        target: `${id}:${variant}`,
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    const selection = parseSelection(body.selection);
    if (!selection) {
      void reply.code(400);
      return { error: "selection must be an array of {kind,id}" };
    }
    const promptRaw = body.promptScaffold;
    const promptScaffold = promptRaw === null || promptRaw === undefined ? null : str(promptRaw) ?? null;
    try {
      return await deps.exporter.exportPackage(
        id,
        ctx.actor,
        variant,
        selection,
        promptScaffold,
        request.ip,
        ctx.isAdmin,
      );
    } catch (err) {
      return exportError(reply, err, ctx.actor.id, "export_package", `${id}:${variant}`, request.ip);
    }
  });

  async function exportError(
    reply: { code: (status: number) => unknown },
    err: unknown,
    identity: string,
    action: string,
    target: string,
    origin: string,
  ) {
    if (err instanceof PrivacyScanError) {
      await deps.audit.append({
        identity,
        action,
        target,
        origin,
        outcome: "failure",
      });
      void reply.code(422);
      return { error: "privacy_scan_failed", findings: err.findings };
    }
    const message = err instanceof Error ? err.message : "invalid";
    if (message === "case not found") {
      void reply.code(404);
      return { error: "not_found" };
    }
    void reply.code(400);
    return { error: message };
  }
}

function parseSelection(raw: unknown): ExportSelection[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ExportSelection[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const id = rec.id;
    if ((kind !== "artifact" && kind !== "contribution") || typeof id !== "string" || !id) {
      return null;
    }
    out.push({ kind, id });
  }
  return out;
}
