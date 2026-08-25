import {
  AUTH_ERROR_SCHEMA_ID,
  ContractViolation,
  USER_PROFILE_ERROR_SCHEMA_ID,
  assertProfileUpdateAllowed,
  parseUserProfileUpdateRequest,
  redactProfileForSelfView,
  type AuthErrorV1,
  type UserProfileErrorCode,
} from "@cd-collab/contracts";
import type { FastifyInstance } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  authorizeSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import { hasCsrfHeader } from "./csrf.js";
import type { UserProfileStore } from "./store.js";

export interface SelfProfileRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  profiles: UserProfileStore;
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function profileError(error: UserProfileErrorCode) {
  return { schemaId: USER_PROFILE_ERROR_SCHEMA_ID, error };
}

export async function registerSelfProfileRoutes(
  app: FastifyInstance,
  deps: SelfProfileRouteDeps,
): Promise<void> {
  app.get("/api/profile/me", async (request, reply) => {
    const resolved = await authorizeSession(request, deps.sessionAuth);
    if (resolved.kind === "unavailable") {
      void reply.code(503);
      return profileError("unavailable");
    }
    if (resolved.kind !== "ok") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    const profile = await deps.profiles.getById(resolved.ctx.identity.id);
    if (!profile) {
      // Login always touches the profile store first (see auth/routes.ts
      // wiring), so a missing profile behind a valid session is an
      // inconsistent-state condition, not an ordinary not_found.
      void reply.code(503);
      return profileError("unavailable");
    }
    // The owner never needs the raw LDAP DN / OIDC subject; only an admin does.
    return redactProfileForSelfView(profile);
  });

  app.patch("/api/profile/me", async (request, reply) => {
    const resolved = await authorizeSession(request, deps.sessionAuth);
    if (resolved.kind === "unavailable") {
      void reply.code(503);
      return profileError("unavailable");
    }
    if (resolved.kind !== "ok") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (!hasCsrfHeader(request)) {
      void reply.code(403);
      return profileError("forbidden");
    }
    let update: ReturnType<typeof parseUserProfileUpdateRequest>;
    try {
      update = parseUserProfileUpdateRequest(request.body);
    } catch {
      void reply.code(400);
      return profileError("invalid_request");
    }
    const current = await deps.profiles.getById(resolved.ctx.identity.id);
    if (!current) {
      void reply.code(503);
      return profileError("unavailable");
    }
    try {
      assertProfileUpdateAllowed(current, update);
    } catch (error) {
      await recordAudit(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "profile_self_update",
        target: error instanceof ContractViolation ? error.path : "field_not_editable",
        origin: request.ip,
        outcome: "denied",
      });
      void reply.code(403);
      return profileError("field_not_editable");
    }
    const result = await deps.profiles.updateFields(
      resolved.ctx.identity.id,
      {
        ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
        ...(update.roleTitle !== undefined ? { roleTitle: update.roleTitle } : {}),
        ...(update.team !== undefined ? { team: update.team } : {}),
        ...(update.contactEmail !== undefined ? { contactEmail: update.contactEmail } : {}),
        ...(update.contactOther !== undefined ? { contactOther: update.contactOther } : {}),
        ...(update.avatar !== undefined ? { avatar: update.avatar } : {}),
        ...(update.customAttributes !== undefined ? { customAttributes: update.customAttributes } : {}),
      },
      update.expectedRevision,
    );
    if (result.outcome === "ok") {
      await recordAudit(deps.audit, {
        identity: resolved.ctx.identity.id,
        action: "profile_self_update",
        target: resolved.ctx.identity.id,
        origin: request.ip,
        outcome: "success",
      });
      return redactProfileForSelfView(result.profile);
    }
    await recordAudit(deps.audit, {
      identity: resolved.ctx.identity.id,
      action: "profile_self_update",
      target: resolved.ctx.identity.id,
      origin: request.ip,
      outcome: "failure",
    });
    if (result.outcome === "not_found") {
      void reply.code(503);
      return profileError("unavailable");
    }
    if (result.outcome === "suspended") {
      void reply.code(403);
      return profileError("suspended");
    }
    void reply.code(409);
    return profileError("stale_revision");
  });
}

async function recordAudit(
  audit: AuditStore,
  record: Parameters<AuditStore["append"]>[0],
): Promise<void> {
  try {
    await audit.append(record);
  } catch {
    // Best-effort, matching the rest of the module's audit-append calls.
  }
}
