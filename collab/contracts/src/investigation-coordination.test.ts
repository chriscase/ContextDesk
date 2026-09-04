import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capability.js";
import { parseSessionResponse, SESSION_SCHEMA_ID } from "./auth.js";
import { ContractViolation } from "./parse.js";
import {
  INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_AUTHORITY,
  INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_IDEMPOTENCY,
  INVESTIGATION_COORDINATION_REFUSALS,
  INVESTIGATION_COORDINATION_SCHEMA_ID,
  evaluateInvestigationCoordination,
  parseInvestigationCoordination,
  parseInvestigationCoordinationActionRefused,
  parseInvestigationCoordinationActionRequest,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationCoordinationChanged,
  type InvestigationCoordinationAction,
  type InvestigationCoordinationEvaluationSubject,
  type InvestigationCoordinationV1,
  type InvestigationCoordinatorIdentityV1,
} from "./investigation-coordination.js";
import {
  INVESTIGATION_COORDINATION_SCHEMA_ID as browserSchemaId,
  parseInvestigationCoordination as browserParseCoordination,
  parseInvestigationCoordinationActionRefused as browserParseRefused,
  parseInvestigationCoordinationActionRequest as browserParseRequest,
  parseInvestigationCoordinationActionSuccess as browserParseSuccess,
  parseInvestigationCoordinationChanged as browserParseChanged,
} from "./investigation-runtime-browser.js";

const here = dirname(fileURLToPath(import.meta.url));
const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;

const ALICE: InvestigationCoordinatorIdentityV1 = {
  identityId: "identity-alice",
  username: "alice",
};
const BOB: InvestigationCoordinatorIdentityV1 = {
  identityId: "identity-bob",
  username: "bob",
};

function coordination(
  overrides: Partial<InvestigationCoordinationV1> = {},
): InvestigationCoordinationV1 {
  return {
    schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
    investigationId: "case-1",
    coordinator: null,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    archived: false,
    ...overrides,
  };
}

function recorded(
  coordinator: InvestigationCoordinatorIdentityV1 | null = ALICE,
  overrides: Partial<InvestigationCoordinationV1> = {},
): InvestigationCoordinationV1 {
  return coordination({
    coordinator,
    revision: 3,
    updatedAt: "2026-09-04T08:30:00-05:00",
    updatedBy: BOB,
    ...overrides,
  });
}

function success(
  action: InvestigationCoordinationAction,
  previousCoordinator: InvestigationCoordinatorIdentityV1 | null,
  appliedCoordinator: InvestigationCoordinatorIdentityV1 | null,
  updatedBy: InvestigationCoordinatorIdentityV1,
) {
  const targetIdentityId = action === "assign_participant"
    ? appliedCoordinator?.identityId ?? null
    : action === "release_participant"
      ? previousCoordinator?.identityId ?? null
      : null;
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
    investigationId: "case-1",
    action,
    targetIdentityId,
    previousRevision: 2,
    previousCoordinator,
    applied: recorded(appliedCoordinator, { revision: 3, updatedBy }),
  };
}

describe("investigation coordination projection", () => {
  it("accepts pristine, assigned, and released states and preserves browser leaf parity", () => {
    expect(parseInvestigationCoordination(coordination())).toEqual(coordination());
    expect(parseInvestigationCoordination(recorded(ALICE)).coordinator).toEqual(ALICE);
    const released = recorded(null);
    expect(parseInvestigationCoordination(released).revision).toBe(3);
    expect(browserSchemaId).toBe(INVESTIGATION_COORDINATION_SCHEMA_ID);
    expect(browserParseCoordination(released)).toEqual(parseInvestigationCoordination(released));
  });

  it("remains truthful when a formerly eligible coordinator later becomes stale", () => {
    // Eligibility is intentionally absent from the projection. It is checked
    // at claim/assignment time and may later change; privileged release is the
    // cleanup path rather than rewriting recorded coordination on read.
    expect(parseInvestigationCoordination(recorded(ALICE)).coordinator).toEqual(ALICE);
    expect(coordination()).not.toHaveProperty("eligibleParticipant");
  });

  it("requires revision-zero state to be wholly pristine", () => {
    for (const patch of [
      { coordinator: ALICE },
      { updatedAt: "2026-09-04T13:30:00Z" },
      { updatedBy: ALICE },
    ]) {
      expect(() => parseInvestigationCoordination(coordination(patch))).toThrow(/revision zero/);
    }
  });

  it("requires paired update metadata after the first recorded action", () => {
    expect(() => parseInvestigationCoordination(recorded(ALICE, { updatedAt: null }))).toThrow(
      /paired/,
    );
    expect(() => parseInvestigationCoordination(recorded(ALICE, { updatedBy: null }))).toThrow(
      /paired/,
    );
  });

  it("requires explicit-offset instants", () => {
    expect(() =>
      parseInvestigationCoordination(recorded(ALICE, { updatedAt: "2026-09-04T08:30:00" })),
    ).toThrow(/explicit offset/);
    expect(parseInvestigationCoordination(recorded(ALICE)).updatedAt).toBe(
      "2026-09-04T08:30:00-05:00",
    );
  });

  it("rejects unknown keys, schema drift, invalid identities, and revisions", () => {
    expect(() => parseInvestigationCoordination({ ...coordination(), surprise: true })).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseInvestigationCoordination({ ...coordination(), schemaId: "coordination.v2" }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCoordination(recorded({ identityId: "", username: "alice" })),
    ).toThrow(/non-empty/);
    expect(() => parseInvestigationCoordination({ ...coordination(), revision: -1 })).toThrow(
      /unsigned/,
    );
    expect(() =>
      parseInvestigationCoordination({ ...coordination(), investigationId: "  " }),
    ).toThrow(/non-empty/);
    expect(() =>
      parseInvestigationCoordination(recorded({ identityId: "alice\u0007", username: "alice" })),
    ).toThrow(/control characters/);
    expect(() =>
      parseInvestigationCoordination(recorded({ identityId: "identity-alice", username: "x".repeat(129) })),
    ).toThrow(/128/);
  });
});

describe("coordination action requests", () => {
  const base = {
    schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
    investigationId: "case-1",
    expectedRevision: 0,
    idempotencyKey: "coord-key-0001",
  };

  it("reserves write authority for self-service and coordinate authority for privileged actions", () => {
    expect(INVESTIGATION_COORDINATION_ACTION_AUTHORITY).toEqual({
      claim_self: "investigation:write",
      release_self: "investigation:write",
      assign_participant: "investigation:coordinate",
      release_participant: "investigation:coordinate",
    });
  });

  it("accepts every action with exactly its target shape", () => {
    for (const action of ["claim_self", "release_self"] as const) {
      expect(parseInvestigationCoordinationActionRequest({ ...base, action }).action).toBe(action);
      expect(() =>
        parseInvestigationCoordinationActionRequest({ ...base, action, targetIdentityId: "alice" }),
      ).toThrow(/forbidden/);
    }
    for (const action of ["assign_participant", "release_participant"] as const) {
      expect(
        parseInvestigationCoordinationActionRequest({
          ...base,
          action,
          targetIdentityId: "identity-alice",
        }).targetIdentityId,
      ).toBe("identity-alice");
      expect(() => parseInvestigationCoordinationActionRequest({ ...base, action })).toThrow(
        /required/,
      );
    }
  });

  it("accepts expectedRevision zero, bounded retry keys, and explicit-offset client time", () => {
    const parsed = parseInvestigationCoordinationActionRequest({
      ...base,
      action: "claim_self",
      idempotencyKey: "a.......",
      clientTime: "2026-09-04T08:30:00-05:00",
    });
    expect(parsed.expectedRevision).toBe(0);
    expect(parsed.clientTime).toContain("-05:00");
    expect(() =>
      parseInvestigationCoordinationActionRequest({
        ...base,
        action: "claim_self",
        clientTime: "2026-09-04T08:30:00",
      }),
    ).toThrow(/explicit offset/);
  });

  it("rejects short, long, unsafe, and unknown request data", () => {
    for (const idempotencyKey of ["short", `a${"b".repeat(128)}`, "coord/key/0001"]) {
      expect(() =>
        parseInvestigationCoordinationActionRequest({
          ...base,
          action: "claim_self",
          idempotencyKey,
        }),
      ).toThrow(/8..128/);
    }
    expect(() =>
      parseInvestigationCoordinationActionRequest({ ...base, action: "claim_self", extra: true }),
    ).toThrow(/unknown key/);
  });
});

describe("coordination success", () => {
  it("accepts the four real state-changing transitions", () => {
    expect(parseInvestigationCoordinationActionSuccess(success("claim_self", null, ALICE, ALICE)).applied.coordinator).toEqual(ALICE);
    expect(parseInvestigationCoordinationActionSuccess(success("release_self", ALICE, null, ALICE)).applied.coordinator).toBeNull();
    expect(parseInvestigationCoordinationActionSuccess(success("assign_participant", ALICE, BOB, ALICE)).applied.coordinator).toEqual(BOB);
    expect(parseInvestigationCoordinationActionSuccess(success("release_participant", BOB, null, ALICE)).applied.coordinator).toBeNull();
  });

  it("requires and binds the target intent for participant transitions", () => {
    const assigned = success("assign_participant", ALICE, BOB, ALICE);
    expect(parseInvestigationCoordinationActionSuccess(assigned).targetIdentityId).toBe(
      BOB.identityId,
    );
    expect(() =>
      parseInvestigationCoordinationActionSuccess({
        ...assigned,
        targetIdentityId: ALICE.identityId,
      }),
    ).toThrow(/match targetIdentityId/);

    const released = success("release_participant", BOB, null, ALICE);
    expect(parseInvestigationCoordinationActionSuccess(released).targetIdentityId).toBe(
      BOB.identityId,
    );
    expect(() =>
      parseInvestigationCoordinationActionSuccess({
        ...released,
        targetIdentityId: ALICE.identityId,
      }),
    ).toThrow(/match targetIdentityId/);

    expect(() =>
      parseInvestigationCoordinationActionSuccess({
        ...success("claim_self", null, ALICE, ALICE),
        targetIdentityId: ALICE.identityId,
      }),
    ).toThrow(/null for self/);
  });

  it("requires applied identity, next revision, and a working investigation", () => {
    const wrongId = success("claim_self", null, ALICE, ALICE);
    wrongId.applied = { ...wrongId.applied, investigationId: "case-2" };
    expect(() => parseInvestigationCoordinationActionSuccess(wrongId)).toThrow(/root/);
    const wrongRevision = success("claim_self", null, ALICE, ALICE);
    wrongRevision.applied = { ...wrongRevision.applied, revision: 4 };
    expect(() => parseInvestigationCoordinationActionSuccess(wrongRevision)).toThrow(/previousRevision/);
    const archived = success("claim_self", null, ALICE, ALICE);
    archived.applied = { ...archived.applied, archived: true };
    expect(() => parseInvestigationCoordinationActionSuccess(archived)).toThrow(/cannot archive/);
  });

  it("rejects no-op and impossible self transitions", () => {
    expect(() =>
      parseInvestigationCoordinationActionSuccess(success("claim_self", ALICE, ALICE, ALICE)),
    ).toThrow(/vacant/);
    expect(() =>
      parseInvestigationCoordinationActionSuccess(success("release_self", ALICE, null, BOB)),
    ).toThrow(/prior coordinator/);
    expect(() =>
      parseInvestigationCoordinationActionSuccess(success("assign_participant", ALICE, ALICE, BOB)),
    ).toThrow(/change/);
    expect(() =>
      parseInvestigationCoordinationActionSuccess(
        success(
          "assign_participant",
          ALICE,
          { ...ALICE, username: "renamed-alice" },
          BOB,
        ),
      ),
    ).toThrow(/change/);
    expect(() =>
      parseInvestigationCoordinationActionSuccess({
        ...success("release_participant", null, null, BOB),
        targetIdentityId: BOB.identityId,
      }),
    ).toThrow(/release/);
    expect(() =>
      parseInvestigationCoordinationActionSuccess({
        ...success("assign_participant", ALICE, BOB, ALICE),
        previousRevision: 0,
        applied: recorded(BOB, { revision: 1 }),
      }),
    ).toThrow(/revision zero/);
  });

  it("uses applied rather than a misleading current field", () => {
    const value = success("claim_self", null, ALICE, ALICE) as Record<string, unknown>;
    expect(() =>
      parseInvestigationCoordinationActionSuccess({ ...value, current: value.applied }),
    ).toThrow(/unknown key/);
  });
});

describe("coordination changed and refused envelopes", () => {
  it("binds changed action target and reachable current state to root identity", () => {
    const changed = {
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId: "case-1",
      action: "claim_self",
      targetIdentityId: null,
      current: recorded(null),
    };
    expect(parseInvestigationCoordinationChanged(changed).current.revision).toBe(3);
    expect(() =>
      parseInvestigationCoordinationChanged({
        ...changed,
        current: recorded(null, { investigationId: "case-2" }),
      }),
    ).toThrow(/root/);

    const cases = [
      { action: "release_self", targetIdentityId: null, current: recorded(ALICE) },
      {
        action: "assign_participant",
        targetIdentityId: BOB.identityId,
        current: recorded(ALICE),
      },
      {
        action: "release_participant",
        targetIdentityId: BOB.identityId,
        current: recorded(BOB),
      },
    ] as const;
    for (const value of cases) {
      expect(
        parseInvestigationCoordinationChanged({ ...changed, ...value }).action,
      ).toBe(value.action);
    }

    expect(() =>
      parseInvestigationCoordinationChanged({ ...changed, current: recorded(ALICE) }),
    ).toThrow(/before CAS/);
    expect(() =>
      parseInvestigationCoordinationChanged({
        ...changed,
        action: "assign_participant",
        targetIdentityId: BOB.identityId,
        current: recorded(BOB),
      }),
    ).toThrow(/before CAS/);
    expect(() =>
      parseInvestigationCoordinationChanged({
        ...changed,
        action: "release_participant",
        targetIdentityId: BOB.identityId,
        current: recorded(ALICE),
      }),
    ).toThrow(/target mismatch/);
    expect(() =>
      parseInvestigationCoordinationChanged({
        ...changed,
        current: recorded(null, { archived: true }),
      }),
    ).toThrow(/archive refusal/);
  });

  it("accepts every action-specific refusal pairing", () => {
    const pairs: Array<[InvestigationCoordinationAction, (typeof INVESTIGATION_COORDINATION_REFUSALS)[number]]> = [
      ["claim_self", "occupied"],
      ["claim_self", "already_coordinator"],
      ["claim_self", "actor_not_eligible"],
      ["release_self", "not_coordinator"],
      ["assign_participant", "already_coordinator"],
      ["assign_participant", "target_not_eligible"],
      ["release_participant", "target_not_coordinator"],
    ];
    for (const [action, reason] of pairs) {
      const targetIdentityId = action === "assign_participant" || action === "release_participant"
        ? BOB.identityId
        : null;
      const current = reason === "actor_not_eligible"
        ? recorded(null)
        : reason === "already_coordinator" && action === "assign_participant"
          ? recorded(BOB)
          : recorded(ALICE);
      const parsed = parseInvestigationCoordinationActionRefused({
        schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
        error: "coordination_refused",
        investigationId: "case-1",
        action,
        targetIdentityId,
        reason,
        detail: "Recorded state does not allow that action.",
        current,
      });
      expect(parsed.reason).toBe(reason);
    }
  });

  it("enforces the complete action/refusal pairing table", () => {
    const actions = [
      "claim_self",
      "release_self",
      "assign_participant",
      "release_participant",
    ] as const;
    const allowed: Record<(typeof INVESTIGATION_COORDINATION_REFUSALS)[number], readonly InvestigationCoordinationAction[]> = {
      investigation_archived: actions,
      occupied: ["claim_self"],
      already_coordinator: ["claim_self", "assign_participant"],
      not_coordinator: ["release_self"],
      target_not_coordinator: ["release_participant"],
      target_not_eligible: ["assign_participant"],
      actor_not_eligible: ["claim_self"],
      idempotency_intent_mismatch: actions,
    };
    for (const reason of INVESTIGATION_COORDINATION_REFUSALS) {
      for (const action of actions) {
        const targetIdentityId = action === "assign_participant" || action === "release_participant"
          ? BOB.identityId
          : null;
        const current = reason === "investigation_archived"
          ? recorded(ALICE, { archived: true })
          : reason === "actor_not_eligible"
            ? recorded(null)
            : reason === "already_coordinator" && action === "assign_participant"
              ? recorded(BOB)
              : reason === "target_not_coordinator" && action === "release_participant"
                ? recorded(ALICE)
                : recorded(ALICE);
        const parse = () =>
          parseInvestigationCoordinationActionRefused({
            schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
            error: "coordination_refused",
            investigationId: "case-1",
            action,
            targetIdentityId,
            reason,
            detail: "The recorded state does not allow that action.",
            current,
          });
        if (allowed[reason].includes(action)) expect(parse).not.toThrow();
        else expect(parse).toThrow(/cannot refuse/);
      }
    }
  });

  it("allows archive refusal for every action only on archived current state", () => {
    for (const action of [
      "claim_self",
      "release_self",
      "assign_participant",
      "release_participant",
    ] as const) {
      expect(
        parseInvestigationCoordinationActionRefused({
          schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
          error: "coordination_refused",
          investigationId: "case-1",
          action,
          targetIdentityId:
            action === "assign_participant" || action === "release_participant"
              ? BOB.identityId
              : null,
          reason: "investigation_archived",
          detail: "Restore the investigation before changing its coordinator.",
          current: recorded(ALICE, { archived: true }),
        }).current.archived,
      ).toBe(true);
    }
  });

  it("lets idempotency mismatch report either archive state while other fresh reasons cannot", () => {
    const refusal = (reason: string, archived: boolean) => ({
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId: "case-1",
      action: "claim_self",
      targetIdentityId: null,
      reason,
      detail: "Use a new key for a different action intent.",
      current: recorded(ALICE, { archived }),
    });
    expect(parseInvestigationCoordinationActionRefused(refusal("idempotency_intent_mismatch", true)).current.archived).toBe(true);
    expect(parseInvestigationCoordinationActionRefused(refusal("idempotency_intent_mismatch", false)).current.archived).toBe(false);
    expect(() => parseInvestigationCoordinationActionRefused(refusal("occupied", true))).toThrow(/working/);
  });

  it("rejects wrong action/reason pairs, cross-case state, and unbounded detail", () => {
    const base = {
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId: "case-1",
      action: "release_self",
      targetIdentityId: null,
      reason: "occupied",
      detail: "No.",
      current: recorded(ALICE),
    };
    expect(() => parseInvestigationCoordinationActionRefused(base)).toThrow(/cannot refuse/);
    expect(() => parseInvestigationCoordinationActionRefused({ ...base, action: "claim_self", current: recorded(ALICE, { investigationId: "case-2" }) })).toThrow(/root/);
    expect(() => parseInvestigationCoordinationActionRefused({ ...base, action: "claim_self", detail: "x".repeat(601) })).toThrow(/600/);
    expect(() => parseInvestigationCoordinationActionRefused({ ...base, action: "claim_self", detail: "   " })).toThrow(/non-empty/);
  });

  it("rejects refusal states that contradict holder-before-eligibility ordering", () => {
    const base = {
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId: "case-1",
      detail: "The current recorded assignment prevents that action.",
    };
    expect(() =>
      parseInvestigationCoordinationActionRefused({
        ...base,
        action: "claim_self",
        targetIdentityId: null,
        reason: "actor_not_eligible",
        current: recorded(ALICE),
      }),
    ).toThrow(/before eligibility/);
    expect(() =>
      parseInvestigationCoordinationActionRefused({
        ...base,
        action: "assign_participant",
        targetIdentityId: BOB.identityId,
        reason: "target_not_eligible",
        current: recorded(BOB),
      }),
    ).toThrow(/before eligibility/);
    expect(() =>
      parseInvestigationCoordinationActionRefused({
        ...base,
        action: "release_participant",
        targetIdentityId: BOB.identityId,
        reason: "target_not_coordinator",
        current: recorded(BOB),
      }),
    ).toThrow(/cannot be refused/);
  });
});

describe("pure coordination evaluator", () => {
  const subject = (
    overrides: Partial<InvestigationCoordinationEvaluationSubject> = {},
  ): InvestigationCoordinationEvaluationSubject => ({
    investigationId: "case-1",
    archived: false,
    revision: 3,
    coordinator: null,
    actor: { identityId: ALICE.identityId, eligibleParticipant: true },
    target: { identityId: BOB.identityId, eligibleParticipant: true },
    ...overrides,
  });
  const evaluate = (
    action: InvestigationCoordinationAction,
    current: InvestigationCoordinationEvaluationSubject,
    expectedRevision = current.revision,
  ) => evaluateInvestigationCoordination({ action, expectedRevision, subject: current });

  it("allows vacant claims and atomic vacant/replacement assignments", () => {
    expect(evaluate("claim_self", subject())).toMatchObject({ allowed: true, nextCoordinatorIdentityId: ALICE.identityId });
    expect(evaluate("assign_participant", subject())).toMatchObject({ allowed: true, nextCoordinatorIdentityId: BOB.identityId });
    expect(evaluate("assign_participant", subject({ coordinator: ALICE }))).toMatchObject({ allowed: true, nextCoordinatorIdentityId: BOB.identityId });
  });

  it("refuses occupied/self no-ops before eligibility and CAS", () => {
    expect(evaluate("claim_self", subject({ coordinator: BOB, actor: { identityId: ALICE.identityId, eligibleParticipant: false } }), 99)).toMatchObject({ kind: "refused", reason: "occupied" });
    expect(evaluate("claim_self", subject({ coordinator: ALICE }), 99)).toMatchObject({ kind: "refused", reason: "already_coordinator" });
    expect(evaluate("assign_participant", subject({ coordinator: BOB, target: { identityId: BOB.identityId, eligibleParticipant: false } }), 99)).toMatchObject({ kind: "refused", reason: "already_coordinator" });
  });

  it("checks eligibility after holder state and before CAS", () => {
    expect(evaluate("claim_self", subject({ actor: { identityId: ALICE.identityId, eligibleParticipant: false } }), 99)).toMatchObject({ kind: "refused", reason: "actor_not_eligible" });
    expect(evaluate("assign_participant", subject({ target: { identityId: BOB.identityId, eligibleParticipant: false } }), 99)).toMatchObject({ kind: "refused", reason: "target_not_eligible" });
    expect(evaluate("claim_self", subject(), 99)).toMatchObject({ kind: "changed", currentRevision: 3 });
  });

  it("allows only holders to self-release and privileged release to clean inactive holders", () => {
    expect(evaluate("release_self", subject({ coordinator: ALICE }))).toMatchObject({ allowed: true, nextCoordinatorIdentityId: null });
    expect(evaluate("release_self", subject({ coordinator: BOB }))).toMatchObject({ reason: "not_coordinator" });
    expect(evaluate("release_participant", subject({ coordinator: BOB, target: { identityId: BOB.identityId, eligibleParticipant: false } }))).toMatchObject({ allowed: true, nextCoordinatorIdentityId: null });
    expect(evaluate("release_participant", subject({ coordinator: ALICE }))).toMatchObject({ reason: "target_not_coordinator" });
  });

  it("lets archive refusal win over holder, eligibility, and CAS", () => {
    expect(evaluate("claim_self", subject({ archived: true, coordinator: BOB, actor: { identityId: ALICE.identityId, eligibleParticipant: false } }), 99)).toMatchObject({ kind: "refused", reason: "investigation_archived" });
  });
});

describe("durable idempotency and session parity", () => {
  it("keeps every wire parser available from the browser-safe leaf", () => {
    const request = {
      schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
      investigationId: "case-1",
      action: "claim_self",
      expectedRevision: 0,
      idempotencyKey: "coord-key-browser",
    } as const;
    expect(browserParseRequest(request)).toEqual(
      parseInvestigationCoordinationActionRequest(request),
    );
    expect(browserParseSuccess(success("claim_self", null, ALICE, ALICE))).toEqual(
      parseInvestigationCoordinationActionSuccess(success("claim_self", null, ALICE, ALICE)),
    );
    const changed = {
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId: "case-1",
      action: "claim_self",
      targetIdentityId: null,
      current: recorded(null),
    } as const;
    expect(browserParseChanged(changed)).toEqual(parseInvestigationCoordinationChanged(changed));
    const refused = {
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId: "case-1",
      action: "claim_self",
      targetIdentityId: null,
      reason: "occupied",
      detail: "Another participant is coordinating this investigation.",
      current: recorded(ALICE),
    } as const;
    expect(browserParseRefused(refused)).toEqual(
      parseInvestigationCoordinationActionRefused(refused),
    );
  });

  it("freezes the future durable replay ordering and intent fields", () => {
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.lookupKey).toEqual([
      "investigationId",
      "actorIdentityId",
      "idempotencyKey",
    ]);
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.intentFields).toEqual([
      "action",
      "targetIdentityId",
    ]);
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.excludesFromIntent).toEqual([
      "expectedRevision",
      "clientTime",
    ]);
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.replayBefore).toEqual([
      "archive",
      "holder_state",
      "eligibility",
      "cas",
    ]);
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.persist).toBe("successful_actions_only");
    expect(INVESTIGATION_COORDINATION_IDEMPOTENCY.uncertainOutcome).toContain("freeze_exact");
  });

  it("keeps the runtime session parser sourced from CAPABILITIES", () => {
    for (const capability of CAPABILITIES) {
      expect(
        parseSessionResponse({
          schemaId: SESSION_SCHEMA_ID,
          identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
          roles: ["viewer"],
          capabilities: [capability],
        }).capabilities,
      ).toEqual([capability]);
    }
    expect(() =>
      parseSessionResponse({
        schemaId: SESSION_SCHEMA_ID,
        identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
        roles: ["viewer"],
        capabilities: ["investigation:prioritize"],
      }),
    ).toThrow(/expected one of/);
  });

  it("keeps the closed JSON session schema aligned with capability v2", () => {
    const schema = JSON.parse(
      readFileSync(join(here, "..", "schemas", "session.v1.json"), "utf8"),
    ) as object;
    const schemaCapabilityEnum = (
      schema as {
        properties: { capabilities: { items: { enum: string[] } } };
      }
    ).properties.capabilities.items.enum;
    expect(schemaCapabilityEnum).toEqual([...CAPABILITIES]);
    const AjvCtor = Ajv2020 as new (options?: object) => {
      compile: (value: object) => (data: unknown) => boolean;
    };
    const validate = new AjvCtor({ strict: true, allErrors: true }).compile(schema);
    const payload = {
      schemaId: SESSION_SCHEMA_ID,
      identity: { id: "identity-alice", username: "alice", displayName: "Alice" },
      roles: ["case-lead"],
      capabilities: [...CAPABILITIES],
    };
    expect(validate(payload)).toBe(true);
    expect(validate({ ...payload, capabilities: [...CAPABILITIES, "priority:set"] })).toBe(false);
  });
});
