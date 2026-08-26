import type { AppRole } from "./auth.js";

export const MODEL_PURPOSE_POLICY_SCHEMA_ID = "cd-collab.model_purpose_policy.v1" as const;
export const MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID = "cd-collab.model_purpose_policy_update.v1" as const;

export const MODEL_PURPOSES = [
  "triage",
  "comparison",
  "summarization",
  "investigation_chat",
  "redaction",
] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const MODEL_PRIVATE_EVIDENCE_RULES = ["never", "host_policy"] as const;
export type ModelPrivateEvidenceRule = (typeof MODEL_PRIVATE_EVIDENCE_RULES)[number];

export interface ModelPurposeRuleV1 {
  enabled: boolean;
  /** Stable subject identities from the host-owned, credential-free catalog. */
  allowedSubjects: string[];
  allowedRoles: AppRole[];
  maxLanes: number;
  privateEvidence: ModelPrivateEvidenceRule;
}

export interface ModelPurposePolicyInputV1 {
  schemaId: typeof MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID;
  purposes: Record<ModelPurpose, ModelPurposeRuleV1>;
}

export interface ModelPurposePolicyV1 {
  schemaId: typeof MODEL_PURPOSE_POLICY_SCHEMA_ID;
  revision: number;
  fingerprint: string;
  updatedAt: string;
  updatedBy: string;
  purposes: Record<ModelPurpose, ModelPurposeRuleV1>;
}
