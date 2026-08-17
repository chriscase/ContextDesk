import { checkObject, f, type ObjectShape } from "./parse.js";

export const HEALTH_SCHEMA_ID = "cd-collab.health.v1" as const;

export type HealthStatus = "ok";

export interface HealthResponseV1 {
  schemaId: typeof HEALTH_SCHEMA_ID;
  status: HealthStatus;
  service: string;
}

const healthShape: ObjectShape = {
  schemaId: f.req(f.en(HEALTH_SCHEMA_ID)),
  status: f.req(f.en("ok")),
  service: f.req(f.str),
};

export function parseHealthResponse(raw: unknown): HealthResponseV1 {
  checkObject("$", healthShape, raw);
  return raw as HealthResponseV1;
}

export const READY_SCHEMA_ID = "cd-collab.ready.v1" as const;

export type ReadyStatus = "ready" | "not_ready";

export interface ReadyResponseV1 {
  schemaId: typeof READY_SCHEMA_ID;
  status: ReadyStatus;
  database: "up" | "down";
  evidenceStore: "up" | "down";
}

const readyShape: ObjectShape = {
  schemaId: f.req(f.en(READY_SCHEMA_ID)),
  status: f.req(f.en("ready", "not_ready")),
  database: f.req(f.en("up", "down")),
  evidenceStore: f.req(f.en("up", "down")),
};

export function parseReadyResponse(raw: unknown): ReadyResponseV1 {
  checkObject("$", readyShape, raw);
  return raw as ReadyResponseV1;
}
