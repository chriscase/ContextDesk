/**
 * Investigation coordination is the recorded answer to one narrow question:
 * who is currently coordinating this investigation?
 *
 * This contract deliberately owns no queue priority, due date, SLA, lease,
 * presence lock, automatic membership, investigation status, or transport.
 * Authorization, participant eligibility, atomic persistence, audit, and
 * timeline writes remain server responsibilities. The pure evaluator below
 * only reasons over a subject the future server has already loaded.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { isIsoInstant } from "./temporal.js";

export const INVESTIGATION_COORDINATION_SCHEMA_ID =
  "cd-collab.investigation_coordination.v1" as const;
export const INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID =
  "cd-collab.investigation_coordination_action_request.v1" as const;
export const INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID =
  "cd-collab.investigation_coordination_action_success.v1" as const;
export const INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID =
  "cd-collab.investigation_coordination_changed.v1" as const;
export const INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID =
  "cd-collab.investigation_coordination_action_refused.v1" as const;

export const INVESTIGATION_COORDINATION_ACTIONS = [
  "claim_self",
  "release_self",
  "assign_participant",
  "release_participant",
] as const;
export type InvestigationCoordinationAction =
  (typeof INVESTIGATION_COORDINATION_ACTIONS)[number];

/**
 * Authorization split reserved for the future route implementation.
 * Self-service remains available to an eligible current participant with the
 * existing write capability; changing somebody else's assignment is the
 * privileged operation protected by capability model v2.
 */
export const INVESTIGATION_COORDINATION_ACTION_AUTHORITY = Object.freeze({
  claim_self: "investigation:write",
  release_self: "investigation:write",
  assign_participant: "investigation:coordinate",
  release_participant: "investigation:coordinate",
} as const);

export const INVESTIGATION_COORDINATION_REFUSALS = [
  "investigation_archived",
  "occupied",
  "already_coordinator",
  "not_coordinator",
  "target_not_coordinator",
  "target_not_eligible",
  "actor_not_eligible",
  "idempotency_intent_mismatch",
] as const;
export type InvestigationCoordinationRefusal =
  (typeof INVESTIGATION_COORDINATION_REFUSALS)[number];

export const INVESTIGATION_COORDINATION_REFUSAL_DETAIL_MAX_LENGTH = 600;
export const INVESTIGATION_COORDINATION_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const INVESTIGATION_COORDINATION_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

export interface InvestigationCoordinatorIdentityV1 {
  identityId: string;
  username: string;
}

export interface InvestigationCoordinationV1 {
  schemaId: typeof INVESTIGATION_COORDINATION_SCHEMA_ID;
  investigationId: string;
  /**
   * Recorded assignment, not a live eligibility assertion. A later account or
   * membership change leaves this value visible until privileged cleanup.
   */
  coordinator: InvestigationCoordinatorIdentityV1 | null;
  revision: number;
  updatedAt: string | null;
  updatedBy: InvestigationCoordinatorIdentityV1 | null;
  archived: boolean;
}

export interface InvestigationCoordinationActionRequestV1 {
  schemaId: typeof INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID;
  investigationId: string;
  action: InvestigationCoordinationAction;
  targetIdentityId?: string;
  expectedRevision: number;
  idempotencyKey: string;
  clientTime?: string;
}

export interface InvestigationCoordinationActionSuccessV1 {
  schemaId: typeof INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID;
  investigationId: string;
  action: InvestigationCoordinationAction;
  previousRevision: number;
  previousCoordinator: InvestigationCoordinatorIdentityV1 | null;
  /** The projection produced by this action, not a claim of later freshness. */
  applied: InvestigationCoordinationV1;
}

export interface InvestigationCoordinationChangedV1 {
  schemaId: typeof INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID;
  error: "coordination_changed";
  investigationId: string;
  action: InvestigationCoordinationAction;
  current: InvestigationCoordinationV1;
}

export interface InvestigationCoordinationActionRefusedV1 {
  schemaId: typeof INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID;
  error: "coordination_refused";
  investigationId: string;
  action: InvestigationCoordinationAction;
  reason: InvestigationCoordinationRefusal;
  detail: string;
  current: InvestigationCoordinationV1;
}

const identityShape: ObjectShape = {
  identityId: f.req(f.nstr),
  username: f.req(f.nstr),
};

const coordinationEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COORDINATION_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  coordinator: f.nul(f.str),
  revision: f.req(f.u64),
  updatedAt: f.nul(f.nstr),
  updatedBy: f.nul(f.str),
  archived: f.req(f.bool),
};

const actionRequestShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...INVESTIGATION_COORDINATION_ACTIONS)),
  targetIdentityId: f.opt(f.nstr),
  expectedRevision: f.req(f.u64),
  idempotencyKey: f.req(f.nstr),
  clientTime: f.opt(f.nstr),
};

const actionSuccessEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...INVESTIGATION_COORDINATION_ACTIONS)),
  previousRevision: f.req(f.u64),
  previousCoordinator: f.nul(f.str),
  applied: f.req(f.str),
};

const changedEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID)),
  error: f.req(f.en("coordination_changed")),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...INVESTIGATION_COORDINATION_ACTIONS)),
  current: f.req(f.str),
};

const refusedEnvelopeShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID)),
  error: f.req(f.en("coordination_refused")),
  investigationId: f.req(f.nstr),
  action: f.req(f.en(...INVESTIGATION_COORDINATION_ACTIONS)),
  reason: f.req(f.en(...INVESTIGATION_COORDINATION_REFUSALS)),
  detail: f.req(f.nstr),
  current: f.req(f.str),
};

function recordAt(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  return raw as Record<string, unknown>;
}

function checkEnvelope(
  raw: unknown,
  path: string,
  shape: ObjectShape,
  nestedFields: readonly string[],
): Record<string, unknown> {
  const record = recordAt(raw, path);
  const shallow: Record<string, unknown> = { ...record };
  for (const field of nestedFields) {
    if (Object.prototype.hasOwnProperty.call(shallow, field) && shallow[field] !== null) {
      shallow[field] = "nested";
    }
  }
  checkObject(path, shape, shallow);
  return record;
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ContractViolation(path, "expected non-empty string");
}

function actionValue(value: unknown, path: string): InvestigationCoordinationAction {
  if (
    value === "claim_self" ||
    value === "release_self" ||
    value === "assign_participant" ||
    value === "release_participant"
  ) {
    return value;
  }
  throw new ContractViolation(path, "expected investigation coordination action");
}

function refusalValue(value: unknown, path: string): InvestigationCoordinationRefusal {
  if (
    typeof value === "string" &&
    (INVESTIGATION_COORDINATION_REFUSALS as readonly string[]).includes(value)
  ) {
    return value as InvestigationCoordinationRefusal;
  }
  throw new ContractViolation(path, "expected investigation coordination refusal");
}

function parseIdentity(
  raw: unknown,
  path: string,
): InvestigationCoordinatorIdentityV1 {
  checkObject(path, identityShape, raw);
  const record = recordAt(raw, path);
  return {
    identityId: nonEmpty(record.identityId, `${path}.identityId`),
    username: nonEmpty(record.username, `${path}.username`),
  };
}

function parseNullableIdentity(
  raw: unknown,
  path: string,
): InvestigationCoordinatorIdentityV1 | null {
  return raw === null ? null : parseIdentity(raw, path);
}

function assertExplicitOffset(value: string, path: string): void {
  if (!isIsoInstant(value)) {
    throw new ContractViolation(path, "expected an ISO-8601 instant with an explicit offset");
  }
}

/** Parse the authoritative coordination projection and its state invariants. */
export function parseInvestigationCoordination(
  raw: unknown,
  path = "$",
): InvestigationCoordinationV1 {
  const record = checkEnvelope(raw, path, coordinationEnvelopeShape, ["coordinator", "updatedBy"]);
  const revision = record.revision as number;
  const coordinator = parseNullableIdentity(record.coordinator, `${path}.coordinator`);
  const updatedBy = parseNullableIdentity(record.updatedBy, `${path}.updatedBy`);
  const updatedAt = record.updatedAt === null
    ? null
    : nonEmpty(record.updatedAt, `${path}.updatedAt`);

  if (revision === 0) {
    if (coordinator !== null || updatedAt !== null || updatedBy !== null) {
      throw new ContractViolation(
        `${path}.revision`,
        "revision zero requires coordinator and update metadata to be null",
      );
    }
  } else {
    if (updatedAt === null || updatedBy === null) {
      throw new ContractViolation(
        `${path}.revision`,
        "a recorded revision requires paired updatedAt and updatedBy metadata",
      );
    }
    assertExplicitOffset(updatedAt, `${path}.updatedAt`);
  }

  return {
    schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
    investigationId: nonEmpty(record.investigationId, `${path}.investigationId`),
    coordinator,
    revision,
    updatedAt,
    updatedBy,
    archived: record.archived === true,
  };
}

/** Parse a structural action request. Authorization and eligibility stay server-side. */
export function parseInvestigationCoordinationActionRequest(
  raw: unknown,
): InvestigationCoordinationActionRequestV1 {
  checkObject("$", actionRequestShape, raw);
  const record = recordAt(raw, "$");
  const action = actionValue(record.action, "$.action");
  const targetIdentityId = typeof record.targetIdentityId === "string"
    ? nonEmpty(record.targetIdentityId, "$.targetIdentityId")
    : undefined;
  const requiresTarget = action === "assign_participant" || action === "release_participant";
  if (requiresTarget !== (targetIdentityId !== undefined)) {
    throw new ContractViolation(
      "$.targetIdentityId",
      requiresTarget ? "is required for participant actions" : "is forbidden for self actions",
    );
  }
  const idempotencyKey = nonEmpty(record.idempotencyKey, "$.idempotencyKey");
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new ContractViolation("$.idempotencyKey", "must be 8..128 safe characters");
  }
  const clientTime = typeof record.clientTime === "string"
    ? nonEmpty(record.clientTime, "$.clientTime")
    : undefined;
  if (clientTime !== undefined) assertExplicitOffset(clientTime, "$.clientTime");
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
    investigationId: nonEmpty(record.investigationId, "$.investigationId"),
    action,
    ...(targetIdentityId === undefined ? {} : { targetIdentityId }),
    expectedRevision: record.expectedRevision as number,
    idempotencyKey,
    ...(clientTime === undefined ? {} : { clientTime }),
  };
}

function sameIdentity(
  left: InvestigationCoordinatorIdentityV1 | null,
  right: InvestigationCoordinatorIdentityV1 | null,
): boolean {
  return left !== null && right !== null && left.identityId === right.identityId;
}

/** Parse a completed action and reject projections that describe a no-op or another case. */
export function parseInvestigationCoordinationActionSuccess(
  raw: unknown,
): InvestigationCoordinationActionSuccessV1 {
  const record = checkEnvelope(raw, "$", actionSuccessEnvelopeShape, ["previousCoordinator", "applied"]);
  const investigationId = nonEmpty(record.investigationId, "$.investigationId");
  const action = actionValue(record.action, "$.action");
  const previousRevision = record.previousRevision as number;
  const previousCoordinator = parseNullableIdentity(record.previousCoordinator, "$.previousCoordinator");
  const applied = parseInvestigationCoordination(record.applied, "$.applied");
  if (applied.investigationId !== investigationId) {
    throw new ContractViolation("$.applied.investigationId", "must match root investigationId");
  }
  if (previousRevision === 0 && previousCoordinator !== null) {
    throw new ContractViolation(
      "$.previousCoordinator",
      "revision zero cannot have a previous coordinator",
    );
  }
  if (applied.revision !== previousRevision + 1 || !Number.isSafeInteger(previousRevision + 1)) {
    throw new ContractViolation("$.applied.revision", "must be exactly previousRevision + 1");
  }
  if (applied.archived) {
    throw new ContractViolation("$.applied.archived", "an applied coordination action cannot archive a case");
  }
  if (action === "claim_self") {
    if (previousCoordinator !== null || applied.coordinator === null) {
      throw new ContractViolation("$.applied.coordinator", "claim_self must claim a vacant investigation");
    }
    if (!sameIdentity(applied.coordinator, applied.updatedBy)) {
      throw new ContractViolation("$.applied.updatedBy", "claim_self must be recorded by the coordinator");
    }
  } else if (action === "release_self") {
    if (previousCoordinator === null || applied.coordinator !== null) {
      throw new ContractViolation("$.applied.coordinator", "release_self must release an occupied investigation");
    }
    if (!sameIdentity(previousCoordinator, applied.updatedBy)) {
      throw new ContractViolation("$.applied.updatedBy", "release_self must be recorded by the prior coordinator");
    }
  } else if (action === "assign_participant") {
    if (applied.coordinator === null || sameIdentity(previousCoordinator, applied.coordinator)) {
      throw new ContractViolation("$.applied.coordinator", "assign_participant must change the coordinator");
    }
  } else if (previousCoordinator === null || applied.coordinator !== null) {
    throw new ContractViolation("$.applied.coordinator", "release_participant must release the named coordinator");
  }
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
    investigationId,
    action,
    previousRevision,
    previousCoordinator,
    applied,
  };
}

/** Parse an optimistic-state conflict carrying the authoritative current projection. */
export function parseInvestigationCoordinationChanged(
  raw: unknown,
): InvestigationCoordinationChangedV1 {
  const record = checkEnvelope(raw, "$", changedEnvelopeShape, ["current"]);
  const investigationId = nonEmpty(record.investigationId, "$.investigationId");
  const current = parseInvestigationCoordination(record.current, "$.current");
  if (current.investigationId !== investigationId) {
    throw new ContractViolation("$.current.investigationId", "must match root investigationId");
  }
  return {
    schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
    error: "coordination_changed",
    investigationId,
    action: actionValue(record.action, "$.action"),
    current,
  };
}

const REFUSAL_ACTIONS: Readonly<Record<InvestigationCoordinationRefusal, readonly InvestigationCoordinationAction[]>> = {
  investigation_archived: INVESTIGATION_COORDINATION_ACTIONS,
  occupied: ["claim_self"],
  already_coordinator: ["claim_self", "assign_participant"],
  not_coordinator: ["release_self"],
  target_not_coordinator: ["release_participant"],
  target_not_eligible: ["assign_participant"],
  actor_not_eligible: ["claim_self"],
  idempotency_intent_mismatch: INVESTIGATION_COORDINATION_ACTIONS,
};

/** Parse a bounded, action-specific refusal carrying the current projection. */
export function parseInvestigationCoordinationActionRefused(
  raw: unknown,
): InvestigationCoordinationActionRefusedV1 {
  const record = checkEnvelope(raw, "$", refusedEnvelopeShape, ["current"]);
  const investigationId = nonEmpty(record.investigationId, "$.investigationId");
  const action = actionValue(record.action, "$.action");
  const reason = refusalValue(record.reason, "$.reason");
  const current = parseInvestigationCoordination(record.current, "$.current");
  if (current.investigationId !== investigationId) {
    throw new ContractViolation("$.current.investigationId", "must match root investigationId");
  }
  if (!REFUSAL_ACTIONS[reason].includes(action)) {
    throw new ContractViolation("$.reason", `${reason} cannot refuse ${action}`);
  }
  if (reason === "investigation_archived" && !current.archived) {
    throw new ContractViolation("$.current.archived", "archived refusal requires archived current state");
  }
  if (
    reason !== "investigation_archived" &&
    reason !== "idempotency_intent_mismatch" &&
    current.archived
  ) {
    throw new ContractViolation("$.current.archived", "fresh refusal reason requires a working investigation");
  }
  const rawDetail = nonEmpty(record.detail, "$.detail");
  const detail = rawDetail.trim();
  if (detail.length === 0) {
    throw new ContractViolation("$.detail", "expected non-empty actionable detail");
  }
  if (rawDetail.length > INVESTIGATION_COORDINATION_REFUSAL_DETAIL_MAX_LENGTH) {
    throw new ContractViolation("$.detail", "detail exceeds 600 characters");
  }
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
    error: "coordination_refused",
    investigationId,
    action,
    reason,
    detail,
    current,
  };
}

export interface InvestigationCoordinationEvaluationIdentity {
  identityId: string;
  eligibleParticipant: boolean;
}

export interface InvestigationCoordinationEvaluationSubject {
  investigationId: string;
  archived: boolean;
  revision: number;
  coordinator: InvestigationCoordinatorIdentityV1 | null;
  actor: InvestigationCoordinationEvaluationIdentity;
  target: InvestigationCoordinationEvaluationIdentity | null;
}

export type InvestigationCoordinationEvaluation =
  | {
      allowed: true;
      action: InvestigationCoordinationAction;
      previousRevision: number;
      nextCoordinatorIdentityId: string | null;
    }
  | {
      allowed: false;
      action: InvestigationCoordinationAction;
      kind: "refused";
      reason: Exclude<InvestigationCoordinationRefusal, "idempotency_intent_mismatch">;
    }
  | {
      allowed: false;
      action: InvestigationCoordinationAction;
      kind: "changed";
      currentRevision: number;
    };

export interface EvaluateInvestigationCoordinationInput {
  action: InvestigationCoordinationAction;
  expectedRevision: number;
  subject: InvestigationCoordinationEvaluationSubject;
}

/**
 * Evaluate one fresh action over an already-loaded subject.
 *
 * Ordering is intentional: archive, holder state, eligibility, then CAS.
 * A future server performs durable idempotent-success replay before calling
 * this function and performs the resulting write under the same lock.
 */
export function evaluateInvestigationCoordination(
  input: EvaluateInvestigationCoordinationInput,
): InvestigationCoordinationEvaluation {
  const { action, expectedRevision, subject } = input;
  const refuse = (
    reason: Exclude<InvestigationCoordinationRefusal, "idempotency_intent_mismatch">,
  ): InvestigationCoordinationEvaluation => ({ allowed: false, action, kind: "refused", reason });
  if (subject.archived) return refuse("investigation_archived");

  const holderId = subject.coordinator?.identityId ?? null;
  let nextCoordinatorIdentityId: string | null;
  if (action === "claim_self") {
    if (holderId === subject.actor.identityId) return refuse("already_coordinator");
    if (holderId !== null) return refuse("occupied");
    if (!subject.actor.eligibleParticipant) return refuse("actor_not_eligible");
    nextCoordinatorIdentityId = subject.actor.identityId;
  } else if (action === "assign_participant") {
    if (input.subject.target === null) return refuse("target_not_eligible");
    if (holderId === input.subject.target.identityId) return refuse("already_coordinator");
    if (!input.subject.target.eligibleParticipant) return refuse("target_not_eligible");
    nextCoordinatorIdentityId = input.subject.target.identityId;
  } else if (action === "release_self") {
    if (holderId !== subject.actor.identityId) return refuse("not_coordinator");
    nextCoordinatorIdentityId = null;
  } else {
    if (input.subject.target === null || holderId !== input.subject.target.identityId) {
      return refuse("target_not_coordinator");
    }
    // A privileged release may clean up an inactive or otherwise ineligible holder.
    nextCoordinatorIdentityId = null;
  }

  if (expectedRevision !== subject.revision) {
    return { allowed: false, action, kind: "changed", currentRevision: subject.revision };
  }
  return {
    allowed: true,
    action,
    previousRevision: subject.revision,
    nextCoordinatorIdentityId,
  };
}

/** Durable replay rules the future server/store implementation must preserve. */
export const INVESTIGATION_COORDINATION_IDEMPOTENCY = Object.freeze({
  lookupKey: ["investigationId", "actorIdentityId", "idempotencyKey"] as const,
  intentFields: ["action", "targetIdentityId"] as const,
  excludesFromIntent: ["expectedRevision", "clientTime"] as const,
  replayBefore: ["archive", "holder_state", "eligibility", "cas"] as const,
  persist: "successful_actions_only" as const,
  uncertainOutcome: "freeze_exact_payload_and_idempotency_key_before_retry" as const,
});
