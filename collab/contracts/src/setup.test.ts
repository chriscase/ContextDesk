import { describe, expect, it } from "vitest";
import {
  MAX_SETUP_HISTORY_ENTRIES,
  SETUP_CLAIM_REQUEST_SCHEMA_ID,
  SETUP_PHASES,
  SETUP_STATE_SCHEMA_ID,
  SETUP_STATUS_SCHEMA_ID,
  SETUP_TRANSITION_REQUEST_SCHEMA_ID,
  isValidSetupTransition,
  parsePersistedSetupState,
  parseSetupClaimRequest,
  parseSetupStatus,
  parseSetupTransitionRequest,
  projectSetupStatus,
  type PersistedSetupStateV1,
  type SetupPhase,
  type SetupStateEntryV1,
} from "./setup.js";

const TOKEN = "A".repeat(43);

function entry(
  revision: number,
  phase: SetupPhase,
  overrides: Partial<SetupStateEntryV1> = {},
): SetupStateEntryV1 {
  const claimed = phase !== "awaiting_owner";
  const failed = phase === "failed" || phase === "recovery_required";
  return {
    stateId: `state:${revision}`,
    revision,
    phase,
    occurredAtUnixMs: 1_000 + revision,
    claimId: claimed ? "claim:one" : null,
    claimantLabel: claimed ? "Local operator" : null,
    failureCode: failed ? "verification_failed" : null,
    ...overrides,
  };
}

function persisted(phases: SetupPhase[]): PersistedSetupStateV1 {
  return {
    schemaId: SETUP_STATE_SCHEMA_ID,
    deploymentId: "deployment:one",
    ownerTokenDigest: "a".repeat(64),
    history: phases.map((phase, revision) => entry(revision, phase)),
  };
}

describe("first-run setup contracts", () => {
  it("parses bounded claim requests and rejects drift without reflecting the token", () => {
    const request = {
      schemaId: SETUP_CLAIM_REQUEST_SCHEMA_ID,
      expectedRevision: 0,
      ownerToken: TOKEN,
      claimantLabel: "Local operator",
    };
    expect(parseSetupClaimRequest(request)).toEqual(request);
    expect(() =>
      parseSetupClaimRequest({ ...request, unexpected: true }),
    ).toThrow(/unknown key/);

    let message = "";
    const invalidToken = `secret value/${TOKEN}`;
    try {
      parseSetupClaimRequest({ ...request, ownerToken: invalidToken });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(invalidToken);
    expect(message).toMatch(/high-entropy base64url token/);

    expect(() =>
      parseSetupClaimRequest({ ...request, claimantLabel: "x".repeat(129) }),
    ).toThrow(/bounded non-secret label/);
    expect(() =>
      parseSetupClaimRequest({ ...request, ownerToken: "A".repeat(5_000) }),
    ).toThrow(/body limit/);
  });

  it("requires bounded machine-readable failure codes only for failure states", () => {
    const request = {
      schemaId: SETUP_TRANSITION_REQUEST_SCHEMA_ID,
      expectedRevision: 3,
      targetPhase: "failed",
      failureCode: "database_unreachable",
    } as const;
    expect(parseSetupTransitionRequest(request)).toEqual(request);
    expect(() =>
      parseSetupTransitionRequest({ ...request, unexpected: true }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseSetupTransitionRequest({ ...request, failureCode: null }),
    ).toThrow(/required for a failure state/);
    expect(() =>
      parseSetupTransitionRequest({
        ...request,
        targetPhase: "draft",
      }),
    ).toThrow(/must be null outside a failure state/);
    expect(() =>
      parseSetupTransitionRequest({ ...request, failureCode: "Contains a secret" }),
    ).toThrow(/bounded failure code/);
  });

  it("defines every valid transition and rejects all other phase pairs", () => {
    const allowed = new Set([
      "awaiting_owner->claimed",
      "claimed->draft",
      "draft->draft",
      "draft->verifying",
      "verifying->failed",
      "verifying->ready_to_commit",
      "verifying->recovery_required",
      "failed->draft",
      "ready_to_commit->restart_required",
      "ready_to_commit->recovery_required",
      "restart_required->configured",
      "restart_required->recovery_required",
    ]);
    for (const from of SETUP_PHASES) {
      for (const to of SETUP_PHASES) {
        expect(isValidSetupTransition(from, to), `${from}->${to}`).toBe(
          allowed.has(`${from}->${to}`),
        );
      }
    }
  });

  it("accepts complete success, retry, and recovery histories", () => {
    const histories: SetupPhase[][] = [
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "draft",
        "verifying",
        "failed",
        "draft",
        "verifying",
        "ready_to_commit",
        "restart_required",
        "configured",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "recovery_required",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "ready_to_commit",
        "recovery_required",
      ],
      [
        "awaiting_owner",
        "claimed",
        "draft",
        "verifying",
        "ready_to_commit",
        "restart_required",
        "recovery_required",
      ],
    ];
    for (const history of histories) {
      expect(parsePersistedSetupState(persisted(history)).history).toHaveLength(
        history.length,
      );
    }
  });

  it("rejects malformed, oversized, duplicate, and mutable persisted state", () => {
    const valid = persisted(["awaiting_owner", "claimed", "draft"]);
    expect(() =>
      parsePersistedSetupState({ ...valid, unexpected: true }),
    ).toThrow(/unknown key/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: [
          valid.history[0],
          { ...valid.history[1], unexpected: true },
        ],
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, stateId: "state:1" } : row,
        ),
      }),
    ).toThrow(/duplicate state id/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, revision: 9 } : row,
        ),
      }),
    ).toThrow(/contiguous/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, occurredAtUnixMs: 1 } : row,
        ),
      }),
    ).toThrow(/cannot move backwards/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: valid.history.map((row, index) =>
          index === 2 ? { ...row, claimId: "claim:changed" } : row,
        ),
      }),
    ).toThrow(/claim metadata is immutable/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        ownerTokenDigest: TOKEN,
      }),
    ).toThrow(/SHA-256 digest/);
    expect(() =>
      parsePersistedSetupState({
        ...valid,
        history: Array.from(
          { length: MAX_SETUP_HISTORY_ENTRIES + 1 },
          (_, index) => entry(index, index === 0 ? "awaiting_owner" : "claimed"),
        ),
      }),
    ).toThrow(/history length/);
    expect(() =>
      parsePersistedSetupState(
        persisted(["awaiting_owner", "claimed", "configured"]),
      ),
    ).toThrow(/invalid setup state transition/);
  });

  it("projects a strict public status with no private token, digest, or path", () => {
    const raw = persisted(["awaiting_owner", "claimed", "draft"]);
    raw.ownerTokenDigest = "b".repeat(64);
    const status = projectSetupStatus(raw);
    expect(status).toEqual({
      schemaId: SETUP_STATUS_SCHEMA_ID,
      stateId: "state:2",
      revision: 2,
      phase: "draft",
      claimed: true,
      failureCode: null,
    });
    expect(parseSetupStatus(status)).toEqual(status);
    expect(() => parseSetupStatus({ ...status, token: TOKEN })).toThrow(/unknown key/);

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(raw.ownerTokenDigest);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/private/");
  });
});
