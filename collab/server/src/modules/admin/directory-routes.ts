import {
  ADMIN_DIRECTORY_ERROR_SCHEMA_ID,
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_DIRECTORY_MAX_RESULTS,
  AUTH_ERROR_SCHEMA_ID,
  parseAdminDirectoryGroupSearchResponse,
  parseAdminDirectoryIdentitySearchResponse,
  parseAdminDirectorySearchRequest,
  type AdminDirectoryErrorCode,
  type AdminDirectoryErrorV1,
  type AuthErrorV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import {
  authorizeSession,
  type SessionAuthorizationDeps,
} from "../authz/index.js";

const DIRECTORY_SEARCH_TIMEOUT_MS = 3_000;

export interface AdminDirectoryRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
}

function authError(error: AuthErrorV1["error"]): AuthErrorV1 {
  return { schemaId: AUTH_ERROR_SCHEMA_ID, error };
}

function directoryError(error: AdminDirectoryErrorCode): AdminDirectoryErrorV1 {
  return { schemaId: ADMIN_DIRECTORY_ERROR_SCHEMA_ID, error };
}

export async function registerAdminDirectoryRoutes(
  app: FastifyInstance,
  deps: AdminDirectoryRouteDeps,
): Promise<void> {
  app.post("/api/admin/directory/identities/search", async (request, reply) => {
    const authorized = await authorizeAdminSearch(request, deps, "identities");
    if (authorized === "unauthenticated") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (authorized === "forbidden") {
      void reply.code(403);
      return authError("forbidden");
    }
    if (authorized === "unavailable") {
      void reply.code(503);
      return directoryError("directory_unavailable");
    }

    let term: string;
    try {
      term = parseAdminDirectorySearchRequest(request.body).term;
    } catch {
      void reply.code(400);
      return directoryError("invalid_request");
    }

    try {
      const results = await withDeadline(
        deps.sessionAuth.auth.adapter.searchIdentities(term, {
          limit: ADMIN_DIRECTORY_MAX_RESULTS,
          timeoutMs: DIRECTORY_SEARCH_TIMEOUT_MS,
        }),
        DIRECTORY_SEARCH_TIMEOUT_MS,
      );
      const response = {
        schemaId: ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
        results: results.slice(0, ADMIN_DIRECTORY_MAX_RESULTS).map((item) => ({
          id: item.id,
          username: item.username,
          displayName: item.displayName,
          source: item.source,
        })),
      };
      parseAdminDirectoryIdentitySearchResponse(response);
      await recordSearch(deps.audit, authorized.identityId, "identities", "success");
      return response;
    } catch {
      await recordSearchBestEffort(
        deps.audit,
        authorized.identityId,
        "identities",
        "failure",
      );
      void reply.code(503);
      return directoryError("directory_unavailable");
    }
  });

  app.post("/api/admin/directory/groups/search", async (request, reply) => {
    const authorized = await authorizeAdminSearch(request, deps, "groups");
    if (authorized === "unauthenticated") {
      void reply.code(401);
      return authError("unauthenticated");
    }
    if (authorized === "forbidden") {
      void reply.code(403);
      return authError("forbidden");
    }
    if (authorized === "unavailable") {
      void reply.code(503);
      return directoryError("directory_unavailable");
    }

    let term: string;
    try {
      term = parseAdminDirectorySearchRequest(request.body).term;
    } catch {
      void reply.code(400);
      return directoryError("invalid_request");
    }

    try {
      const results = await withDeadline(
        deps.sessionAuth.auth.adapter.searchDirectoryGroups(term, {
          limit: ADMIN_DIRECTORY_MAX_RESULTS,
          timeoutMs: DIRECTORY_SEARCH_TIMEOUT_MS,
        }),
        DIRECTORY_SEARCH_TIMEOUT_MS,
      );
      const response = {
        schemaId: ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
        results: results.slice(0, ADMIN_DIRECTORY_MAX_RESULTS).map((item) => ({
          dn: item.dn,
          name: item.name,
          source: item.source,
        })),
      };
      parseAdminDirectoryGroupSearchResponse(response);
      await recordSearch(deps.audit, authorized.identityId, "groups", "success");
      return response;
    } catch {
      await recordSearchBestEffort(
        deps.audit,
        authorized.identityId,
        "groups",
        "failure",
      );
      void reply.code(503);
      return directoryError("directory_unavailable");
    }
  });
}

async function authorizeAdminSearch(
  request: FastifyRequest,
  deps: AdminDirectoryRouteDeps,
  target: "identities" | "groups",
): Promise<
  { identityId: string } | "unauthenticated" | "forbidden" | "unavailable"
> {
  const resolved = await authorizeSession(request, deps.sessionAuth);
  if (resolved.kind === "unavailable") return "unavailable";
  if (resolved.kind !== "ok") return "unauthenticated";
  if (!resolved.ctx.has("admin:users")) {
    await recordSearchBestEffort(
      deps.audit,
      resolved.ctx.identity.id,
      target,
      "denied",
    );
    return "forbidden";
  }
  return { identityId: resolved.ctx.identity.id };
}

async function recordSearch(
  audit: AuditStore,
  identity: string,
  target: "identities" | "groups",
  outcome: "success" | "failure" | "denied",
): Promise<void> {
  await audit.append({
    identity,
    action: "admin_directory_search",
    target,
    origin: "server",
    outcome,
  });
}

async function recordSearchBestEffort(
  audit: AuditStore,
  identity: string,
  target: "identities" | "groups",
  outcome: "failure" | "denied",
): Promise<void> {
  try {
    await recordSearch(audit, identity, target, outcome);
  } catch {
    // No directory data is returned on these paths. A successful query uses
    // the required writer above and therefore fails closed if audit is down.
  }
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("directory search deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
