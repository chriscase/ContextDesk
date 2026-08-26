import { ContractViolation, privacySafeNotFound } from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  capabilityForbidden,
  requireSessionCapability,
  type AuthorizedSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { AuditStore } from "../audit/index.js";
import type { CaseService } from "../cases/index.js";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  type WorkbenchService,
} from "./service.js";

function publicError(err: unknown): string {
  if (
    err instanceof ContractViolation
    || err instanceof WorkbenchConflictError
    || err instanceof WorkbenchNotFoundError
  ) {
    return err.message.length > 240 ? "invalid" : err.message;
  }
  return "invalid";
}

function statusFor(err: unknown): number {
  if (err instanceof WorkbenchConflictError) return 409;
  if (err instanceof WorkbenchNotFoundError) return 404;
  if (err instanceof ContractViolation) return 400;
  return 400;
}

export interface WorkbenchRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  workbench: WorkbenchService;
  cases: Pick<CaseService, "getCase">;
}

export async function registerWorkbenchRoutes(
  app: FastifyInstance,
  deps: WorkbenchRouteDeps,
): Promise<void> {
  const sessionOf = async (
    request: FastifyRequest,
    reply: { code: (status: number) => unknown },
  ) => requireSessionCapability(request, reply, deps.sessionAuth);

  const requireRead = async (
    ctx: AuthorizedSession,
    caseId: string,
    reply: { code: (status: number) => unknown },
    action: string,
    origin: string,
  ): Promise<boolean> => {
    if (!ctx.has("investigation:read")) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action,
        target: caseId,
        origin,
        outcome: "denied",
      });
      void reply.code(403);
      return false;
    }
    if (!(await deps.cases.getCase(caseId, ctx.actor, ctx.isAdmin))) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action,
        target: caseId,
        origin,
        outcome: "denied",
      });
      void reply.code(404);
      return false;
    }
    return true;
  };

  app.get("/api/cases/:id/workbench", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_read", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.inventory(id, loaded.ctx.actor, loaded.ctx.isAdmin);
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/search", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_search", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.search(id, loaded.ctx.actor, loaded.ctx.isAdmin, request.body);
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.get("/api/cases/:id/workbench/page", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as Record<string, string | undefined>;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_page", request.ip))) {
      return { error: "not_found" };
    }
    try {
      const startLine = Number.parseInt(query.startLine ?? "1", 10);
      const limit = Number.parseInt(query.limit ?? "80", 10);
      return await deps.workbench.page(
        id,
        loaded.ctx.actor,
        loaded.ctx.isAdmin,
        query.evidenceId ?? "",
        Number.isFinite(startLine) ? startLine : 1,
        Number.isFinite(limit) ? limit : 80,
      );
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/chronology", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_chronology", request.ip))) {
      return { error: "not_found" };
    }
    const body = (request.body ?? {}) as { grouping?: string; evidenceIds?: string[] };
    try {
      return await deps.workbench.chronology(
        id,
        loaded.ctx.actor,
        loaded.ctx.isAdmin,
        (body.grouping as "file") ?? "file",
        Array.isArray(body.evidenceIds) ? body.evidenceIds : [],
      );
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/anchors", { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!loaded.ctx.has("investigation:write")) return capabilityForbidden(reply);
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_anchor_pin", request.ip))) {
      return { error: "not_found" };
    }
    const body = (request.body ?? {}) as {
      evidenceId?: string;
      lineNumber?: number;
      status?: "pinned" | "human_ground_truth";
      note?: string;
      idempotencyKey?: string;
    };
    try {
      return await deps.workbench.pinChronologyAnchor(
        id,
        loaded.ctx.actor,
        loaded.ctx.isAdmin,
        {
          evidenceId: body.evidenceId ?? "",
          lineNumber: body.lineNumber ?? 0,
          status: body.status ?? "pinned",
          note: body.note ?? "",
          idempotencyKey: body.idempotencyKey ?? `anchor-${body.evidenceId}-${body.lineNumber}`,
        },
      );
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.get("/api/cases/:id/workbench/review-queue", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_review_queue", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.reviewQueue(id, loaded.ctx.actor, loaded.ctx.isAdmin);
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/review-preview", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!loaded.ctx.has("investigation:write")) return capabilityForbidden(reply);
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_review_preview", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.previewRule(id, loaded.ctx.actor, loaded.ctx.isAdmin, request.body);
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.get("/api/cases/:id/workbench/views", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_views", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return { views: await deps.workbench.listViews(id, loaded.ctx.actor, loaded.ctx.isAdmin) };
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/views", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!loaded.ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: loaded.ctx.actor.id,
        action: "log_workbench_view_save",
        target: id,
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_view_save", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.saveView(id, loaded.ctx.actor, loaded.ctx.isAdmin, request.body);
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.get("/api/cases/:id/workbench/bookmarks", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_bookmarks", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return {
        bookmarks: await deps.workbench.listBookmarks(id, loaded.ctx.actor, loaded.ctx.isAdmin),
      };
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/cases/:id/workbench/bookmarks", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    if (!loaded.ctx.has("investigation:write")) {
      await deps.audit.append({
        identity: loaded.ctx.actor.id,
        action: "log_workbench_bookmark_save",
        target: id,
        origin: request.ip,
        outcome: "denied",
      });
      return capabilityForbidden(reply);
    }
    if (!(await requireRead(loaded.ctx, id, reply, "log_workbench_bookmark_save", request.ip))) {
      return { error: "not_found" };
    }
    try {
      return await deps.workbench.saveBookmark(
        id,
        loaded.ctx.actor,
        loaded.ctx.isAdmin,
        request.body,
      );
    } catch (err) {
      void reply.code(statusFor(err));
      return { error: publicError(err) };
    }
  });

  app.post("/api/workbench/locators/resolve", { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    // Capability, membership, and unknown tokens share one body so a
    // share-safe locator never discloses that a file or investigation exists.
    if (!loaded.ctx.has("investigation:read")) {
      return privacySafeNotFound();
    }
    return deps.workbench.resolveLocator(request.body, loaded.ctx.actor, loaded.ctx.isAdmin);
  });
}
