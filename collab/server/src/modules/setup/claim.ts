import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  SETUP_STATE_SCHEMA_ID,
  assertHighEntropyOwnerToken,
  isValidSetupTransition,
  parsePersistedSetupState,
  parseSetupClaimRequest,
  parseSetupTransitionRequest,
  projectSetupStatus,
  type PersistedSetupStateV1,
  type SetupClaimRequestV1,
  type SetupStateEntryV1,
  type SetupStatusV1,
  type SetupTransitionRequestV1,
} from "@cd-collab/contracts/setup";
import type { SetupStateStore } from "./state-store.js";

export type SetupClaimErrorCode =
  | "invalid_owner_token"
  | "claim_unavailable"
  | "setup_complete"
  | "invalid_transition";

export class SetupClaimError extends Error {
  constructor(readonly code: SetupClaimErrorCode) {
    super(code);
    this.name = "SetupClaimError";
  }
}

export interface SetupClaimDependencies {
  nowUnixMs?: () => number;
  randomId?: () => string;
}

function dependencies(
  input: SetupClaimDependencies,
): Required<SetupClaimDependencies> {
  return {
    nowUnixMs: input.nowUnixMs ?? Date.now,
    randomId: input.randomId ?? randomUUID,
  };
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(tokenDigest(token), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return (
    actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  );
}

function currentEntry(state: PersistedSetupStateV1): SetupStateEntryV1 {
  const entry = state.history.at(-1);
  if (!entry) throw new SetupClaimError("invalid_transition");
  return entry;
}

function nextOpaqueId(
  prefix: "deployment" | "state" | "claim",
  randomId: () => string,
): string {
  return `${prefix}:${randomId()}`;
}

function appendEntry(
  state: PersistedSetupStateV1,
  entry: SetupStateEntryV1,
): PersistedSetupStateV1 {
  return parsePersistedSetupState({
    ...state,
    history: [...state.history, entry],
  });
}

export async function initializeSetupState(
  store: SetupStateStore,
  ownerToken: string,
  inputDependencies: SetupClaimDependencies = {},
): Promise<SetupStatusV1> {
  assertHighEntropyOwnerToken(ownerToken);
  const deps = dependencies(inputDependencies);
  const initial = parsePersistedSetupState({
    schemaId: SETUP_STATE_SCHEMA_ID,
    deploymentId: nextOpaqueId("deployment", deps.randomId),
    ownerTokenDigest: tokenDigest(ownerToken),
    history: [
      {
        stateId: nextOpaqueId("state", deps.randomId),
        revision: 0,
        phase: "awaiting_owner",
        occurredAtUnixMs: deps.nowUnixMs(),
        claimId: null,
        claimantLabel: null,
        failureCode: null,
      },
    ],
  });
  return projectSetupStatus(await store.initialize(initial));
}

export async function claimSetupOwner(
  store: SetupStateStore,
  rawRequest: unknown,
  inputDependencies: SetupClaimDependencies = {},
): Promise<SetupStatusV1> {
  const request: SetupClaimRequestV1 = parseSetupClaimRequest(rawRequest);
  const deps = dependencies(inputDependencies);
  const next = await store.compareAndSwap(request.expectedRevision, (state) => {
    const current = currentEntry(state);
    if (current.phase === "configured") {
      throw new SetupClaimError("setup_complete");
    }
    if (current.phase !== "awaiting_owner") {
      throw new SetupClaimError("claim_unavailable");
    }
    if (!tokenMatches(request.ownerToken, state.ownerTokenDigest)) {
      throw new SetupClaimError("invalid_owner_token");
    }
    return appendEntry(state, {
      stateId: nextOpaqueId("state", deps.randomId),
      revision: current.revision + 1,
      phase: "claimed",
      occurredAtUnixMs: deps.nowUnixMs(),
      claimId: nextOpaqueId("claim", deps.randomId),
      claimantLabel: request.claimantLabel,
      failureCode: null,
    });
  });
  return projectSetupStatus(next);
}

export async function transitionSetupState(
  store: SetupStateStore,
  ownerToken: string,
  rawRequest: unknown,
  inputDependencies: SetupClaimDependencies = {},
): Promise<SetupStatusV1> {
  assertHighEntropyOwnerToken(ownerToken);
  const request: SetupTransitionRequestV1 =
    parseSetupTransitionRequest(rawRequest);
  const deps = dependencies(inputDependencies);
  const next = await store.compareAndSwap(request.expectedRevision, (state) => {
    const current = currentEntry(state);
    if (current.phase === "configured") {
      throw new SetupClaimError("setup_complete");
    }
    if (!tokenMatches(ownerToken, state.ownerTokenDigest)) {
      throw new SetupClaimError("invalid_owner_token");
    }
    if (
      request.targetPhase === "claimed" ||
      !isValidSetupTransition(current.phase, request.targetPhase)
    ) {
      throw new SetupClaimError("invalid_transition");
    }
    if (current.claimId === null || current.claimantLabel === null) {
      throw new SetupClaimError("claim_unavailable");
    }
    return appendEntry(state, {
      stateId: nextOpaqueId("state", deps.randomId),
      revision: current.revision + 1,
      phase: request.targetPhase,
      occurredAtUnixMs: deps.nowUnixMs(),
      claimId: current.claimId,
      claimantLabel: current.claimantLabel,
      failureCode: request.failureCode,
    });
  });
  return projectSetupStatus(next);
}
