import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  capabilityForbidden,
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { ExportService, PrivacyScanError, isPrivacyClass, type ExportSelection } from "./service.js";

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface ExportRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  exporter: ExportService;
}

export async function registerExportRoutes(
  app: FastifyInstance,
  deps: ExportRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth);
  }

  app.get("/api/cases/:id/export/inventory", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    if (!ctx.has("investigation:read")) {
      return capabilityForbidden(reply);
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
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    const variant = str(asRecord(request.body).variant) ?? "share_safe";
    if (!isPrivacyClass(variant)) {
      void reply.code(400);
      return { error: "variant must be owner_only or share_safe" };
    }
    if (
      !ctx.has("export:create") ||
      (variant === "owner_only" && !ctx.has("evidence:private:read"))
    ) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "export_brief",
        target: `${id}:${variant}`,
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }
    try {
      return await deps.exporter.exportBrief(
        id,
        ctx.actor,
        variant,
        request.ip,
        ctx.isAdmin,
        ctx.has("evidence:private:read"),
      );
    } catch (err) {
      return exportError(reply, err, ctx.actor.id, "export_brief", `${id}:${variant}`, request.ip);
    }
  });

  app.post("/api/cases/:id/export/package", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    const ctx = loaded.ctx;
    const id = (request.params as { id: string }).id;
    const body = asRecord(request.body);
    const variant = str(body.variant) ?? "share_safe";
    if (!isPrivacyClass(variant)) {
      void reply.code(400);
      return { error: "variant must be owner_only or share_safe" };
    }
    if (
      !ctx.has("export:create") ||
      (variant === "owner_only" && !ctx.has("evidence:private:read"))
    ) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "export_package",
        target: `${id}:${variant}`,
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
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
        ctx.has("evidence:private:read"),
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
