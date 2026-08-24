import {
  SETUP_SECRET_PURPOSES,
  type SetupSecretPurpose,
} from "@cd-collab/contracts/setup";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MAX_SETUP_LABEL_BYTES,
  MAX_SETUP_SECRET_BYTES,
  SetupHttpError,
  type SetupService,
  type SetupStageInput,
} from "./service.js";

const SETUP_TOKEN_HEADER = "x-contextdesk-setup-token";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownerToken(request: FastifyRequest): string {
  const value = request.headers[SETUP_TOKEN_HEADER];
  if (typeof value !== "string") throw new SetupHttpError("invalid_owner_token", 403);
  return value;
}

function parseSecretBody(raw: unknown): { purpose: SetupSecretPurpose; value: string } {
  const body = asRecord(raw);
  if (
    !body ||
    Object.keys(body).some((key) => key !== "purpose" && key !== "value") ||
    typeof body.purpose !== "string" ||
    !(SETUP_SECRET_PURPOSES as readonly string[]).includes(body.purpose) ||
    typeof body.value !== "string"
  ) {
    throw new SetupHttpError("invalid_request", 400);
  }
  return { purpose: body.purpose as SetupSecretPurpose, value: body.value };
}

function parseStageBody(raw: unknown): SetupStageInput {
  const body = asRecord(raw);
  if (
    !body ||
    Object.keys(body).some(
      (key) => !["expectedRevision", "deploymentLabel", "draft"].includes(key),
    ) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    typeof body.deploymentLabel !== "string" ||
    Buffer.byteLength(body.deploymentLabel, "utf8") > MAX_SETUP_LABEL_BYTES ||
    !body.draft
  ) {
    throw new SetupHttpError("invalid_request", 400);
  }
  return {
    expectedRevision: body.expectedRevision as number,
    deploymentLabel: body.deploymentLabel,
    draft: body.draft as SetupStageInput["draft"],
  };
}

function parseVerifyBody(raw: unknown): number {
  const body = asRecord(raw);
  if (
    !body ||
    Object.keys(body).some((key) => key !== "expectedRevision") ||
    !Number.isSafeInteger(body.expectedRevision)
  ) {
    throw new SetupHttpError("invalid_request", 400);
  }
  return body.expectedRevision as number;
}

export interface SetupRouteDeps {
  setup: SetupService;
}

export async function registerSetupRoutes(
  app: FastifyInstance,
  deps: SetupRouteDeps,
): Promise<void> {
  app.get("/api/setup/status", async (_request, reply) => {
    try {
      void reply.header("cache-control", "no-store");
      return await deps.setup.status();
    } catch (error) {
      return setupError(reply, error);
    }
  });

  app.post("/api/setup/claim", { bodyLimit: 4 * 1024 }, async (request, reply) => {
    try {
      void reply.header("cache-control", "no-store");
      return await deps.setup.claim(request.body);
    } catch (error) {
      return setupError(reply, error);
    }
  });

  app.post(
    "/api/setup/secrets",
    { bodyLimit: MAX_SETUP_SECRET_BYTES + 1024 },
    async (request, reply) => {
      try {
        const input = parseSecretBody(request.body);
        const result = await deps.setup.issueSecret(
          ownerToken(request),
          input.purpose,
          input.value,
        );
        void reply.header("cache-control", "no-store");
        return result;
      } catch (error) {
        return setupError(reply, error);
      }
    },
  );

  app.put("/api/setup/draft", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    try {
      const result = await deps.setup.stage(ownerToken(request), parseStageBody(request.body));
      void reply.header("cache-control", "no-store");
      return result;
    } catch (error) {
      return setupError(reply, error);
    }
  });

  app.post("/api/setup/verify", { bodyLimit: 1024 }, async (request, reply) => {
    try {
      const result = await deps.setup.verify(
        ownerToken(request),
        parseVerifyBody(request.body),
      );
      void reply.header("cache-control", "no-store");
      return result;
    } catch (error) {
      return setupError(reply, error);
    }
  });

  app.get("/api/setup/capabilities", async (_request, reply) => {
    try {
      await deps.setup.status();
      void reply.header("cache-control", "no-store");
      return {
        schemaId: "cd-collab.setup_capabilities.v1",
        draft: true,
        boundedVerification: true,
        externalConnectivityVerification: false,
        commit: false,
        restart: false,
        installationComplete: false,
        unavailableReason: "atomic_commit_and_restart_unavailable",
      };
    } catch (error) {
      return setupError(reply, error);
    }
  });
}

function setupError(
  reply: { code: (statusCode: number) => unknown; header: (name: string, value: string) => unknown },
  error: unknown,
): { error: string } {
  void reply.header("cache-control", "no-store");
  if (error instanceof SetupHttpError) {
    void reply.code(error.statusCode);
    return { error: error.code };
  }
  void reply.code(400);
  return { error: "invalid_request" };
}
