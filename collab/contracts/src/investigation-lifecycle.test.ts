import { describe, expect, it } from "vitest";
import { CASE_STATUSES } from "./case.js";
import {
  ARCHIVED_STATUS,
  DEFAULT_RESTORE_STATUS,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_REFUSAL_DETAIL_MAX_LENGTH,
  LIFECYCLE_REFUSALS,
  describeDeleteRequest,
  evaluateArchive,
  evaluateRestore,
  isLifecycleTransition,
  parseInvestigationLifecycle,
  parseInvestigationLifecycleActionRefused,
  parseInvestigationLifecycleActionRequest,
  parseInvestigationLifecycleActionSuccess,
  parseInvestigationLifecycleChanged,
  restoreTarget,
} from "./investigation-lifecycle.js";

const baseCase = {
  schemaId: "cd-collab.case.v1",
  id: "case-lifecycle-1",
  title: "Lifecycle contract fixture",
  severity: "medium",
  status: "archived",
  legalHold: false,
  retentionClass: "standard",
  participants: [],
  createdAt: "2026-08-29T12:00:00.000Z",
  createdBy: "fixture-alice",
};

function workingLifecycle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
    investigationId: "case-lifecycle-1",
    status: "open",
    legalHold: false,
    archive: { allowed: true, action: "archive", targetStatus: "archived" },
    restore: {
      allowed: false,
      action: "restore",
      reason: "not_archived",
      detail: "This investigation is not archived.",
    },
    restoreTarget: "monitoring",
    deletion: {
      supported: false,
      detail: "Investigations are archived, never deleted.",
      alternatives: ["archive"],
    },
    ...overrides,
  };
}

function archivedLifecycle(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return workingLifecycle({
    status: "archived",
    archive: {
      allowed: false,
      action: "archive",
      reason: "already_archived",
      detail: "This investigation is already archived.",
    },
    restore: { allowed: true, action: "restore", targetStatus: "monitoring" },
    ...overrides,
  });
}

describe("archiving is refused under legal hold", () => {
  it("refuses the archive and names the hold as the blocker", () => {
    const verdict = evaluateArchive({ status: "open", legalHold: true });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("legal_hold");
    expect(verdict.detail).toMatch(/legal hold/i);
  });

  it("refuses regardless of which status the investigation is leaving", () => {
    for (const status of CASE_STATUSES) {
      if (status === ARCHIVED_STATUS) continue;
      const verdict = evaluateArchive({ status, legalHold: true });
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) throw new Error("expected a refusal");
      expect(verdict.reason).toBe("legal_hold");
    }
  });

  it("still allows a restore, so a held record is never trapped out of the list", () => {
    const verdict = evaluateRestore({ status: ARCHIVED_STATUS, legalHold: true }, [
      { status: "monitoring", recordedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error("expected an allowance");
    expect(verdict.targetStatus).toBe("monitoring");
  });
});

describe("archiving an unheld investigation", () => {
  it("is allowed and targets the archived status", () => {
    const verdict = evaluateArchive({ status: "open", legalHold: false });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error("expected an allowance");
    expect(verdict.targetStatus).toBe(ARCHIVED_STATUS);
    expect(verdict.action).toBe("archive");
  });

  it("does not require a resolution — archiving claims no conclusion", () => {
    // `resolved` is the only guarded status. Archiving a case with nothing
    // concluded must stay possible, or people invent conclusions to file work
    // away. This pins that boundary against a future well-meaning guard.
    const verdict = evaluateArchive({ status: "open", legalHold: false });
    expect(verdict.allowed).toBe(true);
  });

  it("refuses a second archive rather than writing a no-op status row", () => {
    const verdict = evaluateArchive({ status: ARCHIVED_STATUS, legalHold: false });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("already_archived");
  });
});

describe("restore lands where the investigation actually came from", () => {
  it("returns to the most recent non-archived status, not a flattened default", () => {
    expect(
      restoreTarget([
        { status: "open", recordedAt: "2026-01-01T00:00:00.000Z" },
        { status: "monitoring", recordedAt: "2026-01-02T00:00:00.000Z" },
        { status: ARCHIVED_STATUS, recordedAt: "2026-01-03T00:00:00.000Z" },
      ]),
    ).toBe("monitoring");
  });

  it("reads recency from the recorded clock, not from array order", () => {
    expect(
      restoreTarget([
        { status: ARCHIVED_STATUS, recordedAt: "2026-01-03T00:00:00.000Z" },
        { status: "monitoring", recordedAt: "2026-01-02T00:00:00.000Z" },
        { status: "open", recordedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    ).toBe("monitoring");
  });

  it("restores a resolved investigation to resolved", () => {
    expect(
      restoreTarget([
        { status: "resolved", recordedAt: "2026-02-01T00:00:00.000Z" },
        { status: ARCHIVED_STATUS, recordedAt: "2026-02-02T00:00:00.000Z" },
      ]),
    ).toBe("resolved");
  });

  it("falls back to open when history says nothing", () => {
    expect(restoreTarget([])).toBe(DEFAULT_RESTORE_STATUS);
    expect(restoreTarget([{ status: ARCHIVED_STATUS, recordedAt: "2026-01-03T00:00:00.000Z" }])).toBe(
      DEFAULT_RESTORE_STATUS,
    );
  });

  it("never resurrects a conclusion that history does not record", () => {
    // The fallback must not be `resolved`: an investigation whose earlier
    // status was lost comes back as work, never as an answer nobody wrote.
    expect(DEFAULT_RESTORE_STATUS).toBe("open");
  });

  it("skips rows whose status this build does not recognise", () => {
    expect(
      restoreTarget([
        { status: "monitoring", recordedAt: "2026-01-01T00:00:00.000Z" },
        { status: "quantum_superposition", recordedAt: "2026-01-09T00:00:00.000Z" },
        { status: ARCHIVED_STATUS, recordedAt: "2026-01-10T00:00:00.000Z" },
      ]),
    ).toBe("monitoring");
  });

  it("skips rows with an unparsable recorded clock", () => {
    expect(
      restoreTarget([
        { status: "monitoring", recordedAt: "2026-01-01T00:00:00.000Z" },
        { status: "open", recordedAt: "not a date" },
      ]),
    ).toBe("monitoring");
  });

  it("refuses to restore something that is not archived", () => {
    const verdict = evaluateRestore({ status: "open", legalHold: false }, []);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.reason).toBe("not_archived");
  });
});

describe("delete is answered, not offered", () => {
  it("reports that deletion does not exist and names what does", () => {
    const answer = describeDeleteRequest();
    expect(answer.supported).toBe(false);
    expect(answer.alternatives).toContain("archive");
    expect(answer.detail).toMatch(/never deleted/i);
  });

  it("offers no delete-shaped alternative", () => {
    for (const alternative of describeDeleteRequest().alternatives) {
      expect(LIFECYCLE_ACTIONS).toContain(alternative);
    }
  });
});

describe("ordinary status changes stay out of this module", () => {
  it("does not claim a transition between working statuses", () => {
    expect(isLifecycleTransition("open", "monitoring")).toBe(false);
    expect(isLifecycleTransition("monitoring", "resolved")).toBe(false);
  });

  it("claims both directions across the archived boundary", () => {
    expect(isLifecycleTransition("open", ARCHIVED_STATUS)).toBe(true);
    expect(isLifecycleTransition(ARCHIVED_STATUS, "open")).toBe(true);
  });
});

describe("vocabulary stays closed", () => {
  it("keeps the archived status inside the case status vocabulary", () => {
    expect(CASE_STATUSES).toContain(ARCHIVED_STATUS);
    expect(CASE_STATUSES).toContain(DEFAULT_RESTORE_STATUS);
  });

  it("emits only declared refusal reasons", () => {
    const refusals = [
      evaluateArchive({ status: "open", legalHold: true }),
      evaluateArchive({ status: ARCHIVED_STATUS, legalHold: false }),
      evaluateRestore({ status: "open", legalHold: false }, []),
    ];
    for (const verdict of refusals) {
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) throw new Error("expected a refusal");
      expect(LIFECYCLE_REFUSALS).toContain(verdict.reason);
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("authoritative lifecycle preview parser", () => {
  it("parses allowed and refused verdicts together with restore and deletion guidance", () => {
    const parsed = parseInvestigationLifecycle(workingLifecycle());
    expect(parsed).toMatchObject({
      schemaId: INVESTIGATION_LIFECYCLE_SCHEMA_ID,
      investigationId: "case-lifecycle-1",
      status: "open",
      archive: { allowed: true, action: "archive", targetStatus: "archived" },
      restore: { allowed: false, action: "restore", reason: "not_archived" },
      restoreTarget: "monitoring",
      deletion: { supported: false, alternatives: ["archive"] },
    });
  });

  it("accepts the legal-hold refusal and a held archived record that remains restorable", () => {
    expect(
      parseInvestigationLifecycle(
        workingLifecycle({
          legalHold: true,
          archive: {
            allowed: false,
            action: "archive",
            reason: "legal_hold",
            detail: "Clear the legal hold first.",
          },
        }),
      ).archive,
    ).toMatchObject({ allowed: false, reason: "legal_hold" });

    const heldArchived = parseInvestigationLifecycle(
      archivedLifecycle({
        legalHold: true,
        archive: {
          allowed: false,
          action: "archive",
          reason: "legal_hold",
          detail: "Clear the legal hold first.",
        },
      }),
    );
    expect(heldArchived.restore).toEqual({
      allowed: true,
      action: "restore",
      targetStatus: "monitoring",
    });
  });

  it("rejects malformed verdicts, wrong schemas, and unknown keys at every level", () => {
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          archive: { allowed: "yes", action: "archive", targetStatus: "archived" },
        }),
      ),
    ).toThrow(/archive\.allowed.*boolean/);
    expect(() =>
      parseInvestigationLifecycle({
        ...workingLifecycle(),
        schemaId: "cd-collab.investigation_lifecycle.v2",
      }),
    ).toThrow(/schemaId/);
    expect(() => parseInvestigationLifecycle({ ...workingLifecycle(), surprise: true })).toThrow(
      /surprise.*unknown key/,
    );
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          archive: {
            allowed: true,
            action: "archive",
            targetStatus: "archived",
            reason: "legal_hold",
          },
        }),
      ),
    ).toThrow(/archive\.reason.*unknown key/);
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          deletion: {
            supported: false,
            detail: "No deletion.",
            alternatives: ["archive"],
            purge: true,
          },
        }),
      ),
    ).toThrow(/deletion\.purge.*unknown key/);
  });

  it("rejects verdict, restore-target, and deletion alternatives that contradict the state", () => {
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          archive: { allowed: true, action: "restore", targetStatus: "archived" },
        }),
      ),
    ).toThrow(/archive\.action/);
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          restore: { allowed: true, action: "restore", targetStatus: "monitoring" },
        }),
      ),
    ).toThrow(/restore\.allowed/);
    expect(() =>
      parseInvestigationLifecycle(archivedLifecycle({ restoreTarget: "archived" })),
    ).toThrow(/restoreTarget/);
    expect(() =>
      parseInvestigationLifecycle(
        workingLifecycle({
          deletion: {
            supported: false,
            detail: "No deletion.",
            alternatives: ["restore"],
          },
        }),
      ),
    ).toThrow(/only supported alternative/);
  });
});

describe("versioned lifecycle action request", () => {
  const request = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
    investigationId: "case-lifecycle-1",
    action: "archive",
    expected: { status: "open", legalHold: false, restoreTarget: "monitoring" },
  };

  it("parses the expected lifecycle tuple and optional client clock", () => {
    expect(
      parseInvestigationLifecycleActionRequest({
        ...request,
        clientTime: "2026-08-29T12:01:00.000Z",
      }),
    ).toEqual({ ...request, clientTime: "2026-08-29T12:01:00.000Z" });
    expect(
      parseInvestigationLifecycleActionRequest({
        ...request,
        action: "restore",
        expected: { status: "archived", legalHold: true, restoreTarget: "resolved" },
      }),
    ).toMatchObject({ action: "restore", expected: { legalHold: true } });
  });

  it("never accepts a caller-selected target status", () => {
    expect(() =>
      parseInvestigationLifecycleActionRequest({ ...request, targetStatus: "archived" }),
    ).toThrow(/targetStatus.*unknown key/);
    expect(() =>
      parseInvestigationLifecycleActionRequest({
        ...request,
        expected: { ...request.expected, targetStatus: "archived" },
      }),
    ).toThrow(/expected\.targetStatus.*unknown key/);
  });

  it("rejects schema drift, malformed expected state, and action/state contradictions", () => {
    expect(() =>
      parseInvestigationLifecycleActionRequest({ ...request, schemaId: "wrong" }),
    ).toThrow(/schemaId/);
    expect(() =>
      parseInvestigationLifecycleActionRequest({
        ...request,
        expected: { ...request.expected, legalHold: "no" },
      }),
    ).toThrow(/expected\.legalHold/);
    expect(() =>
      parseInvestigationLifecycleActionRequest({
        ...request,
        expected: { ...request.expected, status: "archived" },
      }),
    ).toThrow(/archive request.*working/);
    expect(() =>
      parseInvestigationLifecycleActionRequest({
        ...request,
        expected: { ...request.expected, legalHold: true },
      }),
    ).toThrow(/legal hold/);
    expect(() =>
      parseInvestigationLifecycleActionRequest({
        ...request,
        action: "restore",
      }),
    ).toThrow(/restore request.*archived/);
  });
});

describe("versioned lifecycle action success", () => {
  it("parses archive and restore completions through the authoritative case parser", () => {
    const archived = parseInvestigationLifecycleActionSuccess({
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: "case-lifecycle-1",
      action: "archive",
      previousStatus: "monitoring",
      appliedStatus: "archived",
      case: baseCase,
    });
    expect(archived.case.problemStatement).toBe("");

    const restored = parseInvestigationLifecycleActionSuccess({
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: "case-lifecycle-1",
      action: "restore",
      previousStatus: "archived",
      appliedStatus: "monitoring",
      case: { ...baseCase, status: "monitoring" },
    });
    expect(restored).toMatchObject({
      action: "restore",
      previousStatus: "archived",
      appliedStatus: "monitoring",
      case: { id: "case-lifecycle-1", status: "monitoring" },
    });
  });

  it("rejects schema and unknown-key drift in the envelope or nested case", () => {
    const success = {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: "case-lifecycle-1",
      action: "archive",
      previousStatus: "open",
      appliedStatus: "archived",
      case: baseCase,
    };
    expect(() =>
      parseInvestigationLifecycleActionSuccess({ ...success, schemaId: "wrong" }),
    ).toThrow(/schemaId/);
    expect(() => parseInvestigationLifecycleActionSuccess({ ...success, extra: true })).toThrow(
      /extra.*unknown key/,
    );
    expect(() =>
      parseInvestigationLifecycleActionSuccess({
        ...success,
        case: { ...baseCase, unparsed: true },
      }),
    ).toThrow(/case\.unparsed.*unknown key/);
  });

  it("rejects identity, nested status, and direction mismatches", () => {
    const success = {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: "case-lifecycle-1",
      action: "archive",
      previousStatus: "open",
      appliedStatus: "archived",
      case: baseCase,
    };
    expect(() =>
      parseInvestigationLifecycleActionSuccess({
        ...success,
        investigationId: "case-other",
      }),
    ).toThrow(/case\.id.*different investigation/);
    expect(() =>
      parseInvestigationLifecycleActionSuccess({
        ...success,
        appliedStatus: "monitoring",
      }),
    ).toThrow(/case\.status/);
    expect(() =>
      parseInvestigationLifecycleActionSuccess({
        ...success,
        action: "restore",
      }),
    ).toThrow(/restore must move/);
    expect(() =>
      parseInvestigationLifecycleActionSuccess({
        ...success,
        previousStatus: "archived",
      }),
    ).toThrow(/archive must move/);
  });
});

describe("versioned changed-state conflict", () => {
  it("parses a bounded conflict carrying the current authoritative lifecycle", () => {
    const parsed = parseInvestigationLifecycleChanged({
      schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
      error: "lifecycle_changed",
      investigationId: "case-lifecycle-1",
      action: "restore",
      current: archivedLifecycle(),
    });
    expect(parsed).toMatchObject({
      error: "lifecycle_changed",
      investigationId: "case-lifecycle-1",
      action: "restore",
      current: { status: "archived", restore: { allowed: true } },
    });
  });

  it("rejects schema, error, unknown-key, identity, and action inconsistency", () => {
    const conflict = {
      schemaId: INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
      error: "lifecycle_changed",
      investigationId: "case-lifecycle-1",
      action: "archive",
      current: workingLifecycle(),
    };
    expect(() => parseInvestigationLifecycleChanged({ ...conflict, schemaId: "wrong" })).toThrow(
      /schemaId/,
    );
    expect(() => parseInvestigationLifecycleChanged({ ...conflict, error: "conflict" })).toThrow(
      /error/,
    );
    expect(() => parseInvestigationLifecycleChanged({ ...conflict, extra: true })).toThrow(
      /extra.*unknown key/,
    );
    expect(() =>
      parseInvestigationLifecycleChanged({
        ...conflict,
        current: workingLifecycle({ investigationId: "case-other" }),
      }),
    ).toThrow(/current\.investigationId.*different investigation/);
    expect(() =>
      parseInvestigationLifecycleChanged({
        ...conflict,
        current: workingLifecycle({
          archive: { allowed: true, action: "restore", targetStatus: "archived" },
        }),
      }),
    ).toThrow(/current\.archive\.action/);
  });
});

describe("versioned lifecycle action refusal", () => {
  const refusal = {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
    error: "lifecycle_refused",
    investigationId: "case-lifecycle-1",
    action: "archive",
    reason: "legal_hold",
    detail: "Clear the legal hold before archiving this investigation.",
  };

  it("parses a bounded refusal and preserves its identity and action", () => {
    expect(parseInvestigationLifecycleActionRefused(refusal)).toEqual(refusal);
    expect(
      parseInvestigationLifecycleActionRefused({
        ...refusal,
        action: "restore",
        reason: "not_archived",
        detail: "Archive the investigation before trying to restore it.",
      }),
    ).toMatchObject({
      investigationId: "case-lifecycle-1",
      action: "restore",
      reason: "not_archived",
    });
  });

  it("rejects schema, error, and unknown-key drift", () => {
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, schemaId: "wrong" }),
    ).toThrow(/schemaId/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, error: "lifecycle_changed" }),
    ).toThrow(/error/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, retryable: true }),
    ).toThrow(/retryable.*unknown key/);
  });

  it("rejects malformed identity, action, and refusal reason", () => {
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, investigationId: "" }),
    ).toThrow(/investigationId/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, action: "delete" }),
    ).toThrow(/action/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, reason: "permission_denied" }),
    ).toThrow(/reason/);
  });

  it("rejects blank or oversized detail instead of exposing an arbitrary error body", () => {
    expect(() =>
      parseInvestigationLifecycleActionRefused({ ...refusal, detail: "  \n\t " }),
    ).toThrow(/detail.*non-empty/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({
        ...refusal,
        detail: "x".repeat(LIFECYCLE_REFUSAL_DETAIL_MAX_LENGTH + 1),
      }),
    ).toThrow(/detail.*exceeds/);
  });

  it("rejects action and reason combinations the lifecycle model cannot produce", () => {
    expect(() =>
      parseInvestigationLifecycleActionRefused({
        ...refusal,
        action: "restore",
        reason: "legal_hold",
      }),
    ).toThrow(/legal_hold.*archive/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({
        ...refusal,
        reason: "already_archived",
        action: "restore",
      }),
    ).toThrow(/already_archived.*archive/);
    expect(() =>
      parseInvestigationLifecycleActionRefused({
        ...refusal,
        reason: "not_archived",
        action: "archive",
      }),
    ).toThrow(/not_archived.*restore/);
  });

  it("permits unknown-status refusals in either direction", () => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(
        parseInvestigationLifecycleActionRefused({
          ...refusal,
          action,
          reason: "unknown_status",
          detail: "Refresh the investigation before trying this action again.",
        }),
      ).toMatchObject({ action, reason: "unknown_status" });
    }
  });
});
