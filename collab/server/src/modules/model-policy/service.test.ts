import {
  defaultModelPurposeRules,
  MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID,
  type SnapshotV1,
  type TriageJobRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { MemoryModelPurposePolicyStore } from "./store.js";
import { ModelPurposePolicyService } from "./service.js";

const profiles = [
  {
    id: "profile:qwen",
    profileId: "profile:qwen",
    modelId: "qwen-3.6-27b",
    label: "Qwen review",
    provider: "company-gateway",
  },
  {
    id: "profile:gpt",
    profileId: "profile:gpt",
    modelId: "gpt-oss-120b",
    label: "GPT review",
    provider: "company-gateway",
  },
] as const;

const snapshot: SnapshotV1 = {
  schemaId: "cd-collab.snapshot.v1",
  id: "snapshot-policy-test",
  caseId: "case-policy-test",
  fingerprint: "f".repeat(64),
  parentSnapshotId: null,
  evidence: [{
    evidenceId: "evidence-policy-test",
    ordinal: 0,
    contentHash: "h".repeat(64),
    expectedHash: null,
    verificationStatus: "verified",
    privacyClass: "share_safe",
  }],
  visibility: "share_safe",
  protocolVersion: "snapshot-v1",
  fairnessClass: "same_snapshot",
  status: "frozen",
  createdAt: "2026-08-26T00:00:00.000Z",
  createdBy: "lead",
};

function request(candidates: TriageJobRequestV1["candidates"]): TriageJobRequestV1 {
  return {
    schemaId: "cd-collab.triage_job_request.v1",
    snapshotId: snapshot.id,
    mode: "gateway",
    strategyId: "contextdesk.standard",
    question: "What should we inspect next?",
    policyFingerprint: null,
    taskFingerprint: "policy-test-task",
    candidates,
  };
}

describe("ModelPurposePolicyService", () => {
  it("allows an approved comparison and returns the policy fingerprint", async () => {
    const service = new ModelPurposePolicyService({
      store: new MemoryModelPurposePolicyStore(),
      profiles: [...profiles],
    });

    const policy = await service.authorize({
      request: request([
        {
          candidateId: "qwen",
          role: "reviewer",
          provider: "company-gateway",
          profileId: "profile:qwen",
          model: "qwen-3.6-27b",
          version: null,
        },
        {
          candidateId: "gpt",
          role: "challenger",
          provider: "company-gateway",
          profileId: "profile:gpt",
          model: "gpt-oss-120b",
          version: null,
        },
      ]),
      snapshot,
      roles: ["case-lead"],
      isAdmin: false,
    });

    expect(policy.purposes.comparison.enabled).toBe(true);
    expect(policy.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed for an unapproved model, private evidence, and excessive lanes", async () => {
    const rules = defaultModelPurposeRules(profiles.map((profile) => profile.id));
    rules.comparison.allowedSubjects = ["profile:qwen"];
    rules.comparison.maxLanes = 1;
    rules.comparison.privateEvidence = "never";
    const service = new ModelPurposePolicyService({
      store: new MemoryModelPurposePolicyStore(),
      profiles: [...profiles],
    });
    await service.update({ schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID, purposes: rules }, "admin");

    await expect(service.authorize({
      request: request([
        {
          candidateId: "qwen",
          role: "reviewer",
          provider: "company-gateway",
          profileId: "profile:qwen",
          model: "qwen-3.6-27b",
          version: null,
        },
        {
          candidateId: "gpt",
          role: "challenger",
          provider: "company-gateway",
          profileId: "profile:gpt",
          model: "gpt-oss-120b",
          version: null,
        },
      ]),
      snapshot,
      roles: ["case-lead"],
      isAdmin: false,
    })).rejects.toThrow("limited to 1 model lanes");

    await expect(service.authorizePurpose({
      purpose: "comparison",
      subjects: ["profile:qwen"],
      roles: ["case-lead"],
      laneCount: 1,
      usesPrivateEvidence: true,
      isAdmin: false,
    })).rejects.toThrow("not approved for private evidence");
  });

  it("supports future purpose consumers through the same server-side gate", async () => {
    const rules = defaultModelPurposeRules(profiles.map((profile) => profile.id));
    rules.summarization = {
      enabled: true,
      allowedSubjects: ["profile:qwen"],
      allowedRoles: ["case-lead", "admin"],
      maxLanes: 1,
      privateEvidence: "host_policy",
    };
    const service = new ModelPurposePolicyService({
      store: new MemoryModelPurposePolicyStore(),
      profiles: [...profiles],
    });
    const policy = await service.update({ schemaId: MODEL_PURPOSE_POLICY_UPDATE_SCHEMA_ID, purposes: rules }, "admin");

    const authorized = await service.authorizePurpose({
      purpose: "summarization",
      subjects: ["profile:qwen"],
      roles: ["case-lead"],
      laneCount: 1,
      usesPrivateEvidence: false,
      isAdmin: false,
    });
    expect(authorized.fingerprint).toBe(policy.fingerprint);
    await expect(service.authorizePurpose({
      purpose: "investigation_chat",
      subjects: ["profile:qwen"],
      roles: ["case-lead"],
      laneCount: 1,
      usesPrivateEvidence: false,
      isAdmin: false,
    })).rejects.toThrow("investigation_chat is disabled");
  });
});
