import { describe, expect, it } from "vitest";
import { CASE_STATUSES } from "./case.js";
import {
  ARCHIVED_STATUS,
  DEFAULT_RESTORE_STATUS,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_REFUSALS,
  describeDeleteRequest,
  evaluateArchive,
  evaluateRestore,
  isLifecycleTransition,
  restoreTarget,
} from "./investigation-lifecycle.js";

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
