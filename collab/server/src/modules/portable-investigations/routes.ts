import {
  AUTH_ERROR_SCHEMA_ID,
  COLLISION_POLICIES,
  type ArchiveBlobInventoryEntryV1,
  type AuthErrorV1,
  type CollisionPolicy,
  type IdentityMapEntryV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { resolveActiveSession, type ActiveSessionDeps } from "../auth/index.js";
import { canPerform, type MutableGroupRoleMap } from "../authz/index.js";
import {
  MAX_PORTABLE_ARCHIVE_BYTES,
  PortableInvestigationService,
  PortableServerError,
  type PortablePreflightInput,
} from "./service.js";

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePreflightBody(raw: unknown):
  | { archive: unknown; input: PortablePreflightInput }
  | null {
  const body = asRecord(raw);
  if (!body) return null;
  const allowed = new Set(["archive", "mode", "collisionPolicy", "identityMap", "suppliedBlobs"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (!("archive" in body) || body.mode !== "dry_run") return null;
  if (
    typeof body.collisionPolicy !== "string" ||
    !(COLLISION_POLICIES as readonly string[]).includes(body.collisionPolicy) ||
    !Array.isArray(body.identityMap)
  ) {
    return null;
  }
  if (body.suppliedBlobs !== undefined && !Array.isArray(body.suppliedBlobs)) return null;
  const input: PortablePreflightInput = {
    mode: "dry_run",
    collisionPolicy: body.collisionPolicy as CollisionPolicy,
    identityMap: body.identityMap as IdentityMapEntryV1[],
    ...(body.suppliedBlobs
      ? { suppliedBlobs: body.suppliedBlobs as ArchiveBlobInventoryEntryV1[] }
      : {}),
  };
  return { archive: body.archive, input };
}

export interface PortableInvestigationRouteDeps {
  auth: ActiveSessionDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
  portable: PortableInvestigationService;
}

export async function registerPortableInvestigationRoutes(
  app: FastifyInstance,
  deps: PortableInvestigationRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest) {
    const session = await resolveActiveSession(request, deps.auth);
    if (!session) return null;
    const roles = deps.roles.resolve(session.groups);
    return {
      actor: { id: session.identity.id, username: session.identity.username },
      isAdmin: canPerform(roles, "admin"),
      canRead: canPerform(roles, "read"),
      canLead: canPerform(roles, "lead"),
    };
  }

  app.get("/api/portable-investigations/capabilities", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!ctx.canRead) {
      void reply.code(403);
      return authError("forbidden");
    }
    return deps.portable.capabilities();
  });

  app.get("/api/cases/:id/portable-archive", async (request, reply) => {
    const ctx = await sessionOf(request);
    if (!ctx) {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const id = (request.params as { id: string }).id;
    if (!ctx.canLead) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "portable_archive_export",
        target: id,
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return authError("forbidden");
    }
    try {
      const archive = await deps.portable.exportArchive(id, ctx.actor, ctx.isAdmin);
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "portable_archive_export",
        target: id,
        origin: request.ip,
        outcome: "success",
      });
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "-");
      void reply.header(
        "content-disposition",
        `attachment; filename="contextdesk-investigation-${safeId}.json"`,
      );
      void reply.header("cache-control", "no-store");
      return archive;
    } catch (error) {
      await deps.audit.append({
        identity: ctx.actor.id,
        action: "portable_archive_export",
        target: id,
        origin: request.ip,
        outcome: "failure",
      });
      return portableError(reply, error);
    }
  });

  app.post(
    "/api/portable-investigations/preflight",
    { bodyLimit: MAX_PORTABLE_ARCHIVE_BYTES },
    async (request, reply) => {
      const ctx = await sessionOf(request);
      if (!ctx) {
        void reply.code(401);
        return authError("unauthenticated");
      }
      if (!ctx.canLead) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "portable_archive_preflight",
          target: null,
          origin: request.ip,
          outcome: "denied",
        });
        void reply.code(403);
        return authError("forbidden");
      }
      const parsed = parsePreflightBody(request.body);
      if (!parsed) {
        void reply.code(400);
        return { error: "portable_preflight_request_invalid" };
      }
      if (Buffer.byteLength(JSON.stringify(request.body), "utf8") > MAX_PORTABLE_ARCHIVE_BYTES) {
        void reply.code(413);
        return { error: "portable_archive_size_limit" };
      }
      try {
        const result = await deps.portable.preflight(
          parsed.archive,
          parsed.input,
          ctx.actor,
          ctx.isAdmin,
        );
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "portable_archive_preflight",
          target: result.report.bundleFingerprint,
          origin: request.ip,
          outcome: "success",
        });
        void reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        await deps.audit.append({
          identity: ctx.actor.id,
          action: "portable_archive_preflight",
          target: null,
          origin: request.ip,
          outcome: "failure",
        });
        return portableError(reply, error);
      }
    },
  );
}

function portableError(
  reply: { code: (status: number) => unknown },
  error: unknown,
): { error: string } {
  if (!(error instanceof PortableServerError)) {
    void reply.code(422);
    return { error: "portable_archive_invalid" };
  }
  if (error.code === "not_found") {
    void reply.code(404);
    return { error: "not_found" };
  }
  if (error.code === "archive_size_limit") {
    void reply.code(413);
    return { error: "portable_archive_size_limit" };
  }
  void reply.code(422);
  return { error: error.code };
}
