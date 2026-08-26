import { createHash } from "node:crypto";
import { APP_ROLES, type AppRole } from "./auth.js";
import { checkObject, f, type ObjectShape } from "./parse.js";
import type {
  ModelPurpose,
  ModelPurposePolicyInputV1,
  ModelPurposePolicyV1,
  ModelPurposeRuleV1,
} from "./model-purpose-policy-shared.js";
import {
  MODEL_PRIVATE_EVIDENCE_RULES,
  MODEL_PURPOSES,
  MODEL_PURPOSE_POLICY_SCHEMA_ID,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
} from "./model-purpose-policy-shared.js";

export {
  MODEL_PRIVATE_EVIDENCE_RULES,
  MODEL_PURPOSES,
  MODEL_PURPOSE_POLICY_SCHEMA_ID,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
} from "./model-purpose-policy-shared.js";
export type {
  ModelPrivateEvidenceRule,
  ModelPurpose,
  ModelPurposePolicyInputV1,
  ModelPurposePolicyV1,
  ModelPurposeRuleV1,
} from "./model-purpose-policy-shared.js";

const ruleShape: ObjectShape = {
  enabled: f.req(f.bool),
  allowedSubjects: f.req(f.arr(f.str)),
  allowedRoles: f.req(f.arr(f.en(...APP_ROLES))),
  maxLanes: f.req(f.u64),
  privateEvidence: f.req(f.en(...MODEL_PRIVATE_EVIDENCE_RULES)),
};

const updateShape: ObjectShape = {
  schemaId: f.req(f.en(MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID)),
};

const policyShape: ObjectShape = {
  schemaId: f.req(f.en(MODEL_PURPOSE_POLICY_SCHEMA_ID)),
  revision: f.req(f.u64),
  fingerprint: f.req(f.str),
  updatedAt: f.req(f.str),
  updatedBy: f.req(f.str),
};

function assertPurposeKeys(value: unknown): asserts value is Record<ModelPurpose, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("model purpose rules must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...MODEL_PURPOSES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("model purpose rules must contain exactly the supported purposes");
  }
}

function withoutPurposes(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.purposes;
  return copy;
}

function purposesOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { purposes?: unknown }).purposes
    : undefined;
}

function parseRules(value: unknown): Record<ModelPurpose, ModelPurposeRuleV1> {
  assertPurposeKeys(value);
  const rules = {} as Record<ModelPurpose, ModelPurposeRuleV1>;
  for (const purpose of MODEL_PURPOSES) {
    checkObject(`$.purposes.${purpose}`, ruleShape, value[purpose]);
    const rule = value[purpose] as ModelPurposeRuleV1;
    if (rule.maxLanes < 1 || rule.maxLanes > 16) {
      throw new Error(`$.purposes.${purpose}.maxLanes must be between 1 and 16`);
    }
    const subjects = rule.allowedSubjects.map((subject) => subject.trim());
    if (subjects.some((subject) => subject.length === 0 || subject.length > 240)) {
      throw new Error(`$.purposes.${purpose}.allowedSubjects contains an invalid subject`);
    }
    if (new Set(subjects).size !== subjects.length) {
      throw new Error(`$.purposes.${purpose}.allowedSubjects must be unique`);
    }
    rules[purpose] = {
      enabled: rule.enabled,
      allowedSubjects: subjects,
      allowedRoles: [...new Set(rule.allowedRoles)],
      maxLanes: rule.maxLanes,
      privateEvidence: rule.privateEvidence,
    };
  }
  return rules;
}

function canonicalRules(purposes: Record<ModelPurpose, ModelPurposeRuleV1>): string {
  return JSON.stringify(Object.fromEntries(MODEL_PURPOSES.map((purpose) => {
    const rule = purposes[purpose];
    return [purpose, {
      enabled: rule.enabled,
      allowedSubjects: [...rule.allowedSubjects].sort(),
      allowedRoles: [...rule.allowedRoles].sort(),
      maxLanes: rule.maxLanes,
      privateEvidence: rule.privateEvidence,
    }];
  })));
}

export function modelPurposePolicyFingerprint(
  purposes: Record<ModelPurpose, ModelPurposeRuleV1>,
): string {
  return `sha256:${createHash("sha256").update(canonicalRules(purposes), "utf8").digest("hex")}`;
}

export function parseModelPurposePolicyInput(raw: unknown): ModelPurposePolicyInputV1 {
  checkObject("$", updateShape, withoutPurposes(raw));
  assertPurposeKeys(purposesOf(raw));
  return {
    schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
    purposes: parseRules((raw as { purposes: unknown }).purposes),
  };
}

export function parseModelPurposePolicy(raw: unknown): ModelPurposePolicyV1 {
  checkObject("$", policyShape, withoutPurposes(raw));
  assertPurposeKeys(purposesOf(raw));
  const value = raw as ModelPurposePolicyV1;
  const purposes = parseRules(value.purposes);
  if (!/^sha256:[a-f0-9]{64}$/.test(value.fingerprint)) {
    throw new Error("model policy fingerprint is invalid");
  }
  if (modelPurposePolicyFingerprint(purposes) !== value.fingerprint) {
    throw new Error("model policy fingerprint does not match its rules");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error("model policy revision is invalid");
  }
  return {
    schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID,
    revision: value.revision,
    fingerprint: value.fingerprint,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
    purposes,
  };
}

export function defaultModelPurposeRules(subjects: readonly string[]): Record<ModelPurpose, ModelPurposeRuleV1> {
  const allowedSubjects = [...new Set(subjects.map((subject) => subject.trim()).filter(Boolean))].sort();
  const leadRoles: AppRole[] = ["case-lead", "admin"];
  const disabled = (): ModelPurposeRuleV1 => ({
    enabled: false,
    allowedSubjects: [],
    allowedRoles: [],
    maxLanes: 1,
    privateEvidence: "never",
  });
  return {
    triage: { enabled: true, allowedSubjects, allowedRoles: leadRoles, maxLanes: 1, privateEvidence: "host_policy" },
    comparison: { enabled: true, allowedSubjects, allowedRoles: leadRoles, maxLanes: 16, privateEvidence: "host_policy" },
    summarization: disabled(),
    investigation_chat: disabled(),
    redaction: disabled(),
  };
}

export function createModelPurposePolicy(
  purposes: Record<ModelPurpose, ModelPurposeRuleV1>,
  revision: number,
  updatedBy: string,
  updatedAt: string,
): ModelPurposePolicyV1 {
  const parsed = parseModelPurposePolicyInput({
    schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
    purposes,
  });
  return {
    schemaId: MODEL_PURPOSE_POLICY_SCHEMA_ID,
    revision,
    fingerprint: modelPurposePolicyFingerprint(parsed.purposes),
    updatedAt,
    updatedBy,
    purposes: parsed.purposes,
  };
}
