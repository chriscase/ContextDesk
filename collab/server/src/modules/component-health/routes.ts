import {
  COMPONENT_HEALTH_SCHEMA_ID,
  parseComponentHealthResponse,
  projectComponentHealth,
  type ComponentHealthProjectorInputV1,
  type ComponentHealthResponseV1,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  requireSessionCapability,
  type SessionAuthorizationDeps,
} from "../authz/index.js";
import type { Config } from "../../config.js";
import { latestMigrationVersion } from "../../db/migrate.js";

export type ComponentHealthProvider = () =>
  | ComponentHealthProjectorInputV1
  | Promise<ComponentHealthProjectorInputV1>;

export interface ComponentHealthRouteDeps {
  sessionAuth: SessionAuthorizationDeps;
  provider: ComponentHealthProvider;
}

export function runtimeComponentHealth(
  config: Pick<Config, "serviceVersion" | "serviceCommit">,
  now: () => string = () => new Date().toISOString(),
): ComponentHealthProjectorInputV1 {
  return {
    generatedAt: now(),
    dataMode: "runtime",
    observations: [{
      id: "war_room_service",
      source: "runtime",
      version: config.serviceVersion,
      commit: config.serviceCommit,
      protocol: { name: "cd", version: "v1" },
      storageMigration: { state: "unknown", current: null, target: null },
      compatibility: {
        status: "compatible",
        scope: "component_health_contract",
        detail: "The server returned a validated component-health.v1 response; peer compatibility was not evaluated.",
      },
      update: { state: "not_configured", targetVersion: null },
    }],
  };
}

export function syntheticComponentHealth(): ComponentHealthProjectorInputV1 {
  const head = latestMigrationVersion();
  return {
    generatedAt: "2026-08-24T12:00:00.000Z",
    dataMode: "synthetic_fixture",
    observations: [
      {
        id: "war_room_service",
        source: "synthetic_fixture",
        version: "0.0.1-fixture",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        protocol: { name: "cd", version: "v1" },
        // The head is read from the migration directory rather than written
        // out here. A slice that lands a migration used to leave this literal
        // behind, and a fixture that names a superseded head is a false
        // statement about the schema, not a stale string.
        storageMigration: { state: "current", current: head, target: head },
        compatibility: {
          status: "compatible",
          scope: "component_health_contract",
          detail: "The fixture conforms to component-health.v1; no cross-component compatibility is claimed.",
        },
        update: { state: "available", targetVersion: "0.0.2-fixture" },
      },
      {
        id: "desktop",
        source: "synthetic_fixture",
        version: "0.0.1-desktop-fixture",
        commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        protocol: { name: "cd", version: "v1" },
        storageMigration: { state: "not_applicable", current: null, target: null },
        compatibility: { status: "not_evaluated", scope: "not_evaluated", detail: "Desktop identity is reported; no cross-component compatibility check was supplied." },
        update: { state: "current", targetVersion: null },
      },
      {
        id: "host_bridge",
        source: "synthetic_fixture",
        version: "0.0.1-bridge-fixture",
        commit: "cccccccccccccccccccccccccccccccccccccccc",
        protocol: { name: "triage-bridge", version: "v1" },
        storageMigration: { state: "not_applicable", current: null, target: null },
        compatibility: { status: "not_evaluated", scope: "not_evaluated", detail: "Optional bridge identity is reported; no cross-component compatibility check was supplied." },
        update: { state: "not_configured", targetVersion: null },
      },
    ],
  };
}

export async function registerComponentHealthRoutes(
  app: FastifyInstance,
  deps: ComponentHealthRouteDeps,
): Promise<void> {
  app.get("/api/admin/component-health", async (request: FastifyRequest, reply) => {
    const loaded = await requireSessionCapability(
      request,
      reply,
      deps.sessionAuth,
      "admin:system_config",
    );
    if ("denied" in loaded) return loaded.denied;
    try {
      const response: ComponentHealthResponseV1 = projectComponentHealth(await deps.provider());
      parseComponentHealthResponse(response);
      return response;
    } catch {
      void reply.code(503);
      return { schemaId: COMPONENT_HEALTH_SCHEMA_ID, error: "unavailable" };
    }
  });
}
