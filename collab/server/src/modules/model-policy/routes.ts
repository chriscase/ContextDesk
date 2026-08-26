import {
  MODEL_PURPOSE_POLICY_SCHEMA_ID,
  parseModelPurposePolicyInput,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "../audit/index.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";
import { ModelPurposePolicyConflictError, ModelPurposePolicyService } from "./service.js";

export interface ModelPurposePolicyRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  audit: AuditStore;
  policy: ModelPurposePolicyService;
}

export async function registerModelPurposePolicyRoutes(
  app: FastifyInstance,
  deps: ModelPurposePolicyRouteDeps,
): Promise<void> {
  async function sessionOf(request: FastifyRequest, reply: { code: (status: number) => unknown }) {
    return requireSessionCapability(request, reply, deps.sessionAuth, "admin:system_config");
  }

  app.get("/api/admin/model-policy", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    try {
      const policy = await deps.policy.load();
      await deps.audit.append({
        identity: loaded.ctx.identity.id,
        action: "model_policy_read",
        target: `revision:${policy.revision}`,
        origin: request.ip,
        outcome: "success",
      });
      return {
        schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID,
        policy,
        availableSubjects: deps.policy.availableSubjects(),
      };
    } catch {
      void reply.code(503);
      return { error: "model_policy_unavailable" };
    }
  });

  app.put("/api/admin/model-policy", async (request, reply) => {
    const loaded = await sessionOf(request, reply);
    if ("denied" in loaded) return loaded.denied;
    try {
      const input = parseModelPurposePolicyInput(request.body);
      const policy = await deps.policy.update(input, loaded.ctx.identity.id);
      await deps.audit.append({
        identity: loaded.ctx.identity.id,
        action: "model_policy_update",
        target: `revision:${policy.revision}`,
        origin: request.ip,
        outcome: "success",
      });
      return { schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID, policy };
    } catch (error) {
      await deps.audit.append({
        identity: loaded.ctx.identity.id,
        action: "model_policy_update",
        target: "rejected",
        origin: request.ip,
        outcome: "failure",
      });
      if (error instanceof ModelPurposePolicyConflictError) {
        void reply.code(409);
        return { error: error.message };
      }
      void reply.code(400);
      return { error: "invalid_model_policy" };
    }
  });
}
