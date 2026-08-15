import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import {
  HEALTH_SCHEMA_ID,
  READY_SCHEMA_ID,
  type HealthResponseV1,
  type ReadyResponseV1,
} from "@cd-collab/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import type { EvidenceStore } from "./evidence/store.js";
import { registerAuthRoutes, type AuthRouteDeps } from "./modules/auth/index.js";
import { registerAuthzRoutes } from "./modules/authz/index.js";
import type { MutableGroupRoleMap } from "./modules/authz/index.js";
import type { AuditStore } from "./modules/audit/index.js";

export interface SecurityDeps {
  auth: AuthRouteDeps;
  roles: MutableGroupRoleMap;
  audit: AuditStore;
}

export interface AppDeps {
  config: Config;
  pool: Pick<Pool, "query"> | null;
  store: Pick<EvidenceStore, "ping">;
  security?: SecurityDeps;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/health", async (): Promise<HealthResponseV1> => {
    return {
      schemaId: HEALTH_SCHEMA_ID,
      status: "ok",
      service: deps.config.serviceName,
    };
  });

  app.get("/ready", async (_request, reply): Promise<ReadyResponseV1> => {
    let database: "up" | "down" = "down";
    let evidenceStore: "up" | "down" = "down";
    if (deps.pool) {
      try {
        await deps.pool.query("SELECT 1");
        database = "up";
      } catch {
        database = "down";
      }
    }
    try {
      await deps.store.ping();
      evidenceStore = "up";
    } catch {
      evidenceStore = "down";
    }
    const status = database === "up" && evidenceStore === "up" ? "ready" : "not_ready";
    const body: ReadyResponseV1 = {
      schemaId: READY_SCHEMA_ID,
      status,
      database,
      evidenceStore,
    };
    if (status !== "ready") {
      void reply.code(503);
    }
    return body;
  });

  if (deps.security) {
    await registerAuthRoutes(app, deps.security.auth);
    await registerAuthzRoutes(app, {
      auth: deps.security.auth,
      roles: deps.security.roles,
      audit: deps.security.audit,
    });
  }

  const staticDir =
    deps.config.staticDir ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        void reply.sendFile("index.html");
        return;
      }
      void reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
