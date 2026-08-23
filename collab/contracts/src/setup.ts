import { Buffer } from "node:buffer";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const SETUP_CLAIM_REQUEST_SCHEMA_ID =
  "cd-collab.setup_claim_request.v1" as const;
export const SETUP_TRANSITION_REQUEST_SCHEMA_ID =
  "cd-collab.setup_transition_request.v1" as const;
export const SETUP_STATE_SCHEMA_ID = "cd-collab.setup_state.v1" as const;
export const SETUP_STATUS_SCHEMA_ID = "cd-collab.setup_status.v1" as const;

export const SETUP_PHASES = [
  "awaiting_owner",
  "claimed",
  "draft",
  "verifying",
  "failed",
  "ready_to_commit",
  "recovery_required",
  "restart_required",
  "configured",
] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export const MAX_SETUP_REQUEST_BYTES = 4 * 1024;
export const MAX_SETUP_STATE_FILE_BYTES = 64 * 1024;
export const MAX_SETUP_HISTORY_ENTRIES = 256;
export const MAX_SETUP_ID_CHARS = 128;
export const MAX_SETUP_LABEL_CHARS = 128;
export const MAX_SETUP_FAILURE_CODE_CHARS = 64;

export interface SetupClaimRequestV1 {
  schemaId: typeof SETUP_CLAIM_REQUEST_SCHEMA_ID;
  expectedRevision: number;
  ownerToken: string;
  claimantLabel: string;
}

export interface SetupTransitionRequestV1 {
  schemaId: typeof SETUP_TRANSITION_REQUEST_SCHEMA_ID;
  expectedRevision: number;
  targetPhase: SetupPhase;
  failureCode: string | null;
}

export interface SetupStateEntryV1 {
  stateId: string;
  revision: number;
  phase: SetupPhase;
  occurredAtUnixMs: number;
  claimId: string | null;
  claimantLabel: string | null;
  failureCode: string | null;
}

/** Owner-only persisted state. Never return this shape from an HTTP boundary. */
export interface PersistedSetupStateV1 {
  schemaId: typeof SETUP_STATE_SCHEMA_ID;
  deploymentId: string;
  ownerTokenDigest: string;
  history: SetupStateEntryV1[];
}

/** Share-safe projection. Deliberately excludes token material and filesystem paths. */
export interface SetupStatusV1 {
  schemaId: typeof SETUP_STATUS_SCHEMA_ID;
  stateId: string;
  revision: number;
  phase: SetupPhase;
  claimed: boolean;
  failureCode: string | null;
}

const claimRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_CLAIM_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  ownerToken: f.req(f.str),
  claimantLabel: f.req(f.str),
};

const transitionRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_TRANSITION_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  targetPhase: f.req(f.en(...SETUP_PHASES)),
  failureCode: f.nul(f.str),
};

const stateEntryShape: ObjectShape = {
  stateId: f.req(f.str),
  revision: f.req(f.u64),
  phase: f.req(f.en(...SETUP_PHASES)),
  occurredAtUnixMs: f.req(f.u64),
  claimId: f.nul(f.str),
  claimantLabel: f.nul(f.str),
  failureCode: f.nul(f.str),
};

const persistedStateShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_STATE_SCHEMA_ID)),
  deploymentId: f.req(f.str),
  ownerTokenDigest: f.req(f.str),
  history: f.req(f.arr(f.obj(stateEntryShape))),
};

const statusShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_STATUS_SCHEMA_ID)),
  stateId: f.req(f.str),
  revision: f.req(f.u64),
  phase: f.req(f.en(...SETUP_PHASES)),
  claimed: f.req(f.bool),
  failureCode: f.nul(f.str),
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]*$/;
const TOKEN_ENCODING = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function assertBoundedBody(raw: unknown, path: string): void {
  let bytes: number;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) throw new Error("not serializable");
    bytes = Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new ContractViolation(path, "request must be JSON serializable");
  }
  if (bytes > MAX_SETUP_REQUEST_BYTES) {
    throw new ContractViolation(path, "request exceeds the setup body limit");
  }
}

function assertBoundedId(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_ID_CHARS ||
    !SAFE_ID.test(value)
  ) {
    throw new ContractViolation(path, "expected a bounded opaque identifier");
  }
}

function assertClaimantLabel(value: string, path: string): void {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_LABEL_CHARS ||
    value.trim() !== value ||
    hasControlCharacter
  ) {
    throw new ContractViolation(path, "expected a bounded non-secret label");
  }
}

function assertFailureCode(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_FAILURE_CODE_CHARS ||
    !FAILURE_CODE.test(value)
  ) {
    throw new ContractViolation(path, "expected a bounded failure code");
  }
}

export function assertHighEntropyOwnerToken(token: string): void {
  // 32 random bytes encoded as base64url require 43 characters. Hex-encoded
  // tokens are also accepted because their alphabet is a subset of base64url.
  if (
    token.length < 43 ||
    token.length > 172 ||
    !TOKEN_ENCODING.test(token)
  ) {
    throw new ContractViolation(
      "$.ownerToken",
      "expected a high-entropy base64url token",
    );
  }
}

export function isValidSetupTransition(
  from: SetupPhase,
  to: SetupPhase,
): boolean {
  switch (from) {
    case "awaiting_owner":
      return to === "claimed";
    case "claimed":
      return to === "draft";
    case "draft":
      return to === "draft" || to === "verifying";
    case "verifying":
      return (
        to === "failed" ||
        to === "ready_to_commit" ||
        to === "recovery_required"
      );
    case "failed":
      return to === "draft";
    case "ready_to_commit":
      return to === "restart_required" || to === "recovery_required";
    case "restart_required":
      return to === "configured" || to === "recovery_required";
    case "recovery_required":
    case "configured":
      return false;
  }
}

export function parseSetupClaimRequest(raw: unknown): SetupClaimRequestV1 {
  assertBoundedBody(raw, "$");
  checkObject("$", claimRequestShape, raw);
  const request = raw as SetupClaimRequestV1;
  assertHighEntropyOwnerToken(request.ownerToken);
  assertClaimantLabel(request.claimantLabel, "$.claimantLabel");
  return request;
}

export function parseSetupTransitionRequest(
  raw: unknown,
): SetupTransitionRequestV1 {
  assertBoundedBody(raw, "$");
  checkObject("$", transitionRequestShape, raw);
  const request = raw as SetupTransitionRequestV1;
  if (request.failureCode !== null) {
    assertFailureCode(request.failureCode, "$.failureCode");
  }
  const requiresFailureCode =
    request.targetPhase === "failed" ||
    request.targetPhase === "recovery_required";
  if (requiresFailureCode !== (request.failureCode !== null)) {
    throw new ContractViolation(
      "$.failureCode",
      requiresFailureCode
        ? "required for a failure state"
        : "must be null outside a failure state",
    );
  }
  return request;
}

function assertEntry(entry: SetupStateEntryV1, index: number): void {
  const path = `$.history[${index}]`;
  assertBoundedId(entry.stateId, `${path}.stateId`);
  if (entry.occurredAtUnixMs < 1) {
    throw new ContractViolation(`${path}.occurredAtUnixMs`, "must be positive");
  }
  if (entry.claimId !== null) {
    assertBoundedId(entry.claimId, `${path}.claimId`);
  }
  if (entry.claimantLabel !== null) {
    assertClaimantLabel(entry.claimantLabel, `${path}.claimantLabel`);
  }
  if (entry.failureCode !== null) {
    assertFailureCode(entry.failureCode, `${path}.failureCode`);
  }

  const isAwaiting = entry.phase === "awaiting_owner";
  if (isAwaiting !== (entry.claimId === null && entry.claimantLabel === null)) {
    throw new ContractViolation(path, "claim metadata does not match phase");
  }
  const isFailure =
    entry.phase === "failed" || entry.phase === "recovery_required";
  if (isFailure !== (entry.failureCode !== null)) {
    throw new ContractViolation(path, "failure code does not match phase");
  }
}

export function parsePersistedSetupState(raw: unknown): PersistedSetupStateV1 {
  checkObject("$", persistedStateShape, raw);
  const state = raw as PersistedSetupStateV1;
  assertBoundedId(state.deploymentId, "$.deploymentId");
  if (!SHA256_HEX.test(state.ownerTokenDigest)) {
    throw new ContractViolation(
      "$.ownerTokenDigest",
      "expected a SHA-256 digest",
    );
  }
  if (
    state.history.length < 1 ||
    state.history.length > MAX_SETUP_HISTORY_ENTRIES
  ) {
    throw new ContractViolation("$.history", "invalid setup history length");
  }

  const stateIds = new Set<string>();
  let claimId: string | null = null;
  let claimantLabel: string | null = null;
  for (const [index, entry] of state.history.entries()) {
    assertEntry(entry, index);
    if (stateIds.has(entry.stateId)) {
      throw new ContractViolation(`$.history[${index}].stateId`, "duplicate state id");
    }
    stateIds.add(entry.stateId);
    if (entry.revision !== index) {
      throw new ContractViolation(
        `$.history[${index}].revision`,
        "setup revisions must be contiguous and start at zero",
      );
    }
    if (index === 0) {
      if (entry.phase !== "awaiting_owner") {
        throw new ContractViolation("$.history[0].phase", "must await an owner");
      }
      continue;
    }
    const prior = state.history[index - 1];
    if (prior && entry.occurredAtUnixMs < prior.occurredAtUnixMs) {
      throw new ContractViolation(
        `$.history[${index}].occurredAtUnixMs`,
        "setup history timestamps cannot move backwards",
      );
    }
    if (!prior || !isValidSetupTransition(prior.phase, entry.phase)) {
      throw new ContractViolation(
        `$.history[${index}].phase`,
        "invalid setup state transition",
      );
    }
    if (index === 1) {
      claimId = entry.claimId;
      claimantLabel = entry.claimantLabel;
    } else if (
      entry.claimId !== claimId ||
      entry.claimantLabel !== claimantLabel
    ) {
      throw new ContractViolation(
        `$.history[${index}]`,
        "claim metadata is immutable",
      );
    }
  }
  return state;
}

export function parseSetupStatus(raw: unknown): SetupStatusV1 {
  checkObject("$", statusShape, raw);
  const status = raw as SetupStatusV1;
  assertBoundedId(status.stateId, "$.stateId");
  if (status.failureCode !== null) {
    assertFailureCode(status.failureCode, "$.failureCode");
  }
  const isFailure =
    status.phase === "failed" || status.phase === "recovery_required";
  if (isFailure !== (status.failureCode !== null)) {
    throw new ContractViolation("$.failureCode", "does not match setup phase");
  }
  if (status.claimed !== (status.phase !== "awaiting_owner")) {
    throw new ContractViolation("$.claimed", "does not match setup phase");
  }
  return status;
}

export function projectSetupStatus(state: PersistedSetupStateV1): SetupStatusV1 {
  const parsed = parsePersistedSetupState(state);
  const current = parsed.history.at(-1);
  if (!current) throw new Error("setup state has no current entry");
  return parseSetupStatus({
    schemaId: SETUP_STATUS_SCHEMA_ID,
    stateId: current.stateId,
    revision: current.revision,
    phase: current.phase,
    claimed: current.phase !== "awaiting_owner",
    failureCode: current.failureCode,
  });
}
