import {
  EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
  parseEvidenceStorageStatus,
  type EvidenceStorageStatusV1,
} from "@cd-collab/contracts";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config.js";
import { requireSessionCapability, type SessionAuthorizationDeps } from "../authz/index.js";

export interface EvidenceStorageStatusRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  config: Pick<Config, "storage" | "evidence">;
  store: { ping(): void | Promise<void> };
  now?: () => string;
}

/**
 * Expose only the non-secret storage facts an administrator needs to diagnose
 * an evidence upload. Credentials, control roots, and CA paths never cross
 * this boundary. The server remains the sole storage authority.
 */
export async function registerEvidenceStorageStatusRoutes(
  app: FastifyInstance,
  deps: EvidenceStorageStatusRouteDeps,
): Promise<void> {
  app.get("/api/admin/evidence-storage", async (request, reply) => {
    const loaded = await requireSessionCapability(
      request,
      reply,
      deps.sessionAuth,
      "admin:system_config",
    );
    if ("denied" in loaded) return loaded.denied;

    const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
    let state: EvidenceStorageStatusV1["state"] = "ready";
    try {
      await deps.store.ping();
    } catch {
      state = "unavailable";
    }

    const settings = deps.config.evidence;
    const response: EvidenceStorageStatusV1 = {
      schemaId: EVIDENCE_STORAGE_STATUS_SCHEMA_ID,
      provider: settings.provider,
      database: deps.config.storage,
      state,
      checkedAt,
      endpoint: settings.provider === "s3" ? settings.s3.endpoint : null,
      region: settings.provider === "s3" ? settings.s3.region : null,
      bucket: settings.provider === "s3" ? settings.s3.bucket : null,
      prefix: settings.provider === "s3" ? settings.s3.prefix : null,
      maxUploadBytes: settings.maxUploadBytes,
      requestTimeoutMs: settings.provider === "s3" ? settings.s3.timeoutMs : null,
      credentialsMode: settings.provider === "s3" ? settings.s3.credentialsMode : null,
    };
    parseEvidenceStorageStatus(response);
    return response;
  });
}
