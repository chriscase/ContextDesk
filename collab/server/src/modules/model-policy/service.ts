import {
  createModelPurposePolicy,
  defaultModelPurposeRules,
  parseModelPurposePolicyInput,
  type AppRole,
  type ModelPurpose,
  type ModelPurposePolicyInputV1,
  type ModelPurposePolicyV1,
} from "@cd-collab/contracts";
import type { SnapshotV1, TriageCandidateSpecV1, TriageJobRequestV1 } from "@cd-collab/contracts";
import type { TriageProfileOption } from "../triage-runs/index.js";
import type { ModelPurposePolicyStore } from "./store.js";

export class ModelPurposePolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPurposePolicyConflictError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function subjectForCandidate(
  candidate: TriageCandidateSpecV1,
  profiles: readonly TriageProfileOption[],
): string | null {
  const profile = profiles.find((item) =>
    (item.profileId ?? item.id) === candidate.profileId
    && (!item.modelId || item.modelId === candidate.model || item.alias === candidate.model),
  );
  return profile?.id ?? null;
}

export function purposeForRequest(request: TriageJobRequestV1): ModelPurpose {
  return request.mode === "gateway" && request.candidates.length > 1 ? "comparison" : "triage";
}

export interface ModelPurposeAuthorizationInput {
  purpose: ModelPurpose;
  subjects: readonly string[];
  roles: readonly AppRole[];
  laneCount: number;
  usesPrivateEvidence: boolean;
  isAdmin: boolean;
}

export class ModelPurposePolicyService {
  constructor(
    private readonly deps: {
      store: ModelPurposePolicyStore;
      profiles: readonly TriageProfileOption[];
    },
  ) {}

  availableSubjects(): TriageProfileOption[] {
    return this.deps.profiles.map((profile) => ({ ...profile }));
  }

  async load(): Promise<ModelPurposePolicyV1> {
    const stored = await this.deps.store.load();
    if (stored) return stored;
    return createModelPurposePolicy(
      defaultModelPurposeRules(this.deps.profiles.map((profile) => profile.id)),
      1,
      "system-default",
      "1970-01-01T00:00:00.000Z",
    );
  }

  async update(input: ModelPurposePolicyInputV1, updatedBy: string): Promise<ModelPurposePolicyV1> {
    const parsed = parseModelPurposePolicyInput(input);
    const available = new Set(this.deps.profiles.map((profile) => profile.id));
    for (const [purpose, rule] of Object.entries(parsed.purposes)) {
      for (const subject of rule.allowedSubjects) {
        if (!available.has(subject)) {
          throw new ModelPurposePolicyConflictError(
            `purpose ${purpose} names a model that is not in the current host catalog`,
          );
        }
      }
    }
    const current = await this.load();
    const next = createModelPurposePolicy(parsed.purposes, current.revision + 1, updatedBy, now());
    await this.deps.store.save(next);
    return next;
  }

  /**
   * Shared fail-closed gate for every future model consumer, not only triage
   * runs. A caller must name the purpose and the host-owned model subjects;
   * credentials and provider endpoints never participate in this decision.
   */
  async authorizePurpose(input: ModelPurposeAuthorizationInput): Promise<ModelPurposePolicyV1> {
    const policy = await this.load();
    const rule = policy.purposes[input.purpose];
    if (!rule.enabled) {
      throw new ModelPurposePolicyConflictError(`${input.purpose} is disabled by workspace policy`);
    }
    const effectiveRole: AppRole = input.isAdmin || input.roles.includes("admin") ? "admin" :
      input.roles.includes("case-lead") ? "case-lead" :
        input.roles.includes("contributor") ? "contributor" : "viewer";
    if (!rule.allowedRoles.includes(effectiveRole)) {
      throw new ModelPurposePolicyConflictError(`your role is not approved for ${input.purpose}`);
    }
    if (!Number.isSafeInteger(input.laneCount) || input.laneCount < 1 || input.laneCount > rule.maxLanes) {
      throw new ModelPurposePolicyConflictError(`${input.purpose} is limited to ${rule.maxLanes} model lanes`);
    }
    if (input.usesPrivateEvidence && rule.privateEvidence === "never") {
      throw new ModelPurposePolicyConflictError(`${input.purpose} is not approved for private evidence`);
    }
    for (const subject of input.subjects) {
      if (!rule.allowedSubjects.includes(subject)) {
        throw new ModelPurposePolicyConflictError(`the selected model is not approved for ${input.purpose}`);
      }
    }
    return policy;
  }

  async authorize(input: {
    request: TriageJobRequestV1;
    snapshot: SnapshotV1;
    roles: readonly AppRole[];
    isAdmin: boolean;
  }): Promise<ModelPurposePolicyV1> {
    if (input.request.mode !== "gateway") return this.load();
    const purpose = purposeForRequest(input.request);
    const subjects = input.request.candidates.map((candidate) => subjectForCandidate(candidate, this.deps.profiles));
    if (subjects.some((subject): subject is null => subject === null)) {
      throw new ModelPurposePolicyConflictError(`the selected model is not approved for ${purpose}`);
    }
    return this.authorizePurpose({
      purpose,
      subjects: subjects as string[],
      roles: input.roles,
      laneCount: input.request.candidates.length,
      usesPrivateEvidence: input.snapshot.visibility === "owner_only"
        || input.snapshot.evidence.some((item) => item.privacyClass === "owner_only"),
      isAdmin: input.isAdmin,
    });
  }
}
