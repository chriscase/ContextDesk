import { describe, expect, it } from "vitest";
import {
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
  createModelPurposePolicy,
  defaultModelPurposeRules,
  parseModelPurposePolicy,
  parseModelPurposePolicyInput,
} from "./model-purpose-policy.js";

describe("model-purpose policy contracts", () => {
  it("canonicalizes subject and role order into one fingerprint", () => {
    const left = defaultModelPurposeRules(["subject:b", "subject:a"]);
    const right = defaultModelPurposeRules(["subject:a", "subject:b"]);
    expect(createModelPurposePolicy(left, 1, "admin", "2026-08-26T00:00:00.000Z").fingerprint)
      .toBe(createModelPurposePolicy(right, 1, "admin", "2026-08-26T00:00:00.000Z").fingerprint);
  });

  it("accepts a complete policy and rejects an altered fingerprint", () => {
    const policy = createModelPurposePolicy(
      defaultModelPurposeRules(["subject:a"]),
      2,
      "uid:admin",
      "2026-08-26T00:00:00.000Z",
    );
    expect(parseModelPurposePolicy(policy)).toEqual(policy);
    expect(() => parseModelPurposePolicy({ ...policy, fingerprint: "sha256:" + "0".repeat(64) })).toThrow(
      /fingerprint does not match/,
    );
  });

  it("rejects duplicate subjects and missing purpose keys", () => {
    const rules = defaultModelPurposeRules(["subject:a"]);
    rules.triage.allowedSubjects.push("subject:a");
    expect(() => parseModelPurposePolicyInput({
      schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
      purposes: rules,
    })).toThrow(/must be unique/);
    const missing = { ...defaultModelPurposeRules(["subject:a"]) } as Record<string, unknown>;
    delete missing.redaction;
    expect(() => parseModelPurposePolicyInput({
      schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
      purposes: missing,
    })).toThrow(/exactly the supported purposes/);
  });
});
