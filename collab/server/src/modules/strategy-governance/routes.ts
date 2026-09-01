import {
  UI_STRATEGY_ERROR_SCHEMA_ID,
  parseUiStrategyPolicyInput,
  parseUiStrategyPreferenceUpdate,
  type UiStrategyErrorCode,
} from "@cd-collab/contracts";
import type { FastifyInstance } from "fastify";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import {
  StrategyGovernanceService,
  StrategyPolicyDisallowedError,
  StrategyPolicyStaleError,
  StrategyPreferenceStaleError,
} from "./service.js";

export interface StrategyGovernanceRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  governance: StrategyGovernanceService;
}

function error(code: UiStrategyErrorCode) {
  return { schemaId: UI_STRATEGY_ERROR_SCHEMA_ID, error: code };
}

export async function registerStrategyGovernanceRoutes(
  app: FastifyInstance,
  deps: StrategyGovernanceRouteDeps,
): Promise<void> {
  app.get("/api/ui-strategies/effective", async (request, reply) => {
    const session = await requireSessionCapability(request, reply, deps.sessionAuth);
    if ("denied" in session) return session.denied;
    try {
      return await deps.governance.effective(session.ctx.identity.id, session.ctx.roles);
    } catch {
      void reply.code(503);
      return error("unavailable");
    }
  });

  app.put("/api/ui-strategies/preference", async (request, reply) => {
    const session = await requireSessionCapability(request, reply, deps.sessionAuth);
    if ("denied" in session) return session.denied;
    let input;
    try { input = parseUiStrategyPreferenceUpdate(request.body); }
    catch { void reply.code(400); return error("invalid_request"); }
    try {
      return await deps.governance.updatePreference(
        input, session.ctx.identity.id, session.ctx.roles, request.ip,
      );
    } catch (caught) {
      if (caught instanceof StrategyPolicyStaleError) {
        void reply.code(409); return error("stale_policy");
      }
      if (caught instanceof StrategyPreferenceStaleError) {
        void reply.code(409); return error("stale_preference");
      }
      if (caught instanceof StrategyPolicyDisallowedError) {
        void reply.code(409); return error("disallowed_strategy");
      }
      void reply.code(503); return error("unavailable");
    }
  });

  app.get("/api/admin/ui-strategies", async (request, reply) => {
    const session = await requireSessionCapability(
      request, reply, deps.sessionAuth, "admin:system_config",
    );
    if ("denied" in session) return session.denied;
    try { return await deps.governance.loadPolicy(); }
    catch { void reply.code(503); return error("unavailable"); }
  });

  app.put("/api/admin/ui-strategies", async (request, reply) => {
    const session = await requireSessionCapability(
      request, reply, deps.sessionAuth, "admin:system_config",
    );
    if ("denied" in session) return session.denied;
    let input;
    try { input = parseUiStrategyPolicyInput(request.body); }
    catch { void reply.code(400); return error("invalid_request"); }
    try {
      return await deps.governance.updatePolicy(
        input, session.ctx.identity.id, request.ip,
      );
    } catch (caught) {
      if (caught instanceof StrategyPolicyStaleError) {
        void reply.code(409); return error("stale_policy");
      }
      void reply.code(503); return error("unavailable");
    }
  });
}
