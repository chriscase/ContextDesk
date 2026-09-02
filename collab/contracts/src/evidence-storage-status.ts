import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

/**
 * Secret-free administrator view of the evidence byte provider.
 *
 * This contract intentionally contains configuration useful for diagnosis,
 * but never credentials, control-root paths, CA paths, or provider metadata.
 * The database and evidence provider remain independent authorities.
 */
export const EVIDENCE_STORAGE_STATUS_SCHEMA_ID =
  "cd-collab.evidence_storage_status.v1" as const;

export const EVIDENCE_STORAGE_PROVIDERS = ["filesystem", "s3"] as const;
export type EvidenceStorageProvider = (typeof EVIDENCE_STORAGE_PROVIDERS)[number];

export const EVIDENCE_STORAGE_STATES = ["ready", "unavailable"] as const;
export type EvidenceStorageState = (typeof EVIDENCE_STORAGE_STATES)[number];

export interface EvidenceStorageStatusV1 {
  schemaId: typeof EVIDENCE_STORAGE_STATUS_SCHEMA_ID;
  provider: EvidenceStorageProvider;
  database: "postgres" | "sqlite";
  state: EvidenceStorageState;
  checkedAt: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  maxUploadBytes: number;
  requestTimeoutMs: number | null;
  credentialsMode: "default_chain" | "static" | null;
}

const statusShape: ObjectShape = {
  schemaId: f.req(f.en(EVIDENCE_STORAGE_STATUS_SCHEMA_ID)),
  provider: f.req(f.en(...EVIDENCE_STORAGE_PROVIDERS)),
  database: f.req(f.en("postgres", "sqlite")),
  state: f.req(f.en(...EVIDENCE_STORAGE_STATES)),
  checkedAt: f.req(f.nstr),
  endpoint: f.nul(f.str),
  region: f.nul(f.str),
  bucket: f.nul(f.str),
  prefix: f.nul(f.str),
  maxUploadBytes: f.req(f.u64),
  requestTimeoutMs: f.nul(f.u64),
  credentialsMode: f.nul(f.en("default_chain", "static")),
};

function assertProviderShape(status: EvidenceStorageStatusV1): void {
  if (status.provider === "filesystem") {
    if (
      status.endpoint !== null
      || status.region !== null
      || status.bucket !== null
      || status.prefix !== null
      || status.requestTimeoutMs !== null
      || status.credentialsMode !== null
    ) {
      throw new ContractViolation(
        "$.provider",
        "filesystem status cannot expose S3 configuration",
      );
    }
    return;
  }
  if (
    status.endpoint === null
    || status.region === null
    || status.bucket === null
    || status.requestTimeoutMs === null
    || status.credentialsMode === null
  ) {
    throw new ContractViolation(
      "$.provider",
      "S3 status must expose non-secret connection settings",
    );
  }
}

export function parseEvidenceStorageStatus(raw: unknown): EvidenceStorageStatusV1 {
  checkObject("$", statusShape, raw);
  const status = raw as EvidenceStorageStatusV1;
  assertProviderShape(status);
  return status;
}
