/**
 * Adversarial coverage for the log-time contract.
 *
 * The threat these shapes sit in front of is not a clever exploit so much as a
 * quiet lie: a payload that looks like a reviewed timezone decision but was
 * never reviewed, or a corpus state whose numbers do not add up. Every case
 * here must be refused outright rather than normalized into something
 * plausible.
 */
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  LOG_TIME_LIMITS,
  assertIanaTimezone,
  parseLogCorpusState,
  parseLogTimeApplyRequest,
  parseLogTimeClearRequest,
  parseLogTimeOutcome,
  parseLogTimePreview,
  parseLogTimePreviewRequest,
  parseLogTimeUndoRequest,
} from "./investigation-log-time.js";

const FINGERPRINT = "3f2a1b6c4d5e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

function previewRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaId: "cd-collab.log_time_preview_request.v1",
    source: "worker/batch.log",
    ianaTimezone: "America/Chicago",
    expectedRevision: 3,
    ...overrides,
  };
}

function applyRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaId: "cd-collab.log_time_apply_request.v1",
    source: "worker/batch.log",
    ianaTimezone: "America/Chicago",
    expectedRevision: 3,
    declarationFingerprint: FINGERPRINT,
    idempotencyKey: "apply-worker-0001",
    ...overrides,
  };
}

function corpusState(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaId: "cd-collab.log_corpus_state.v1",
    caseId: "case-synthetic-0001",
    corpusId: "corpus-synthetic-0001",
    corpusRevision: 2,
    builtAt: "2024-03-09T18:00:00Z",
    privacyClass: "owner_only",
    sources: [
      {
        source: "worker/batch.log",
        unresolvedLocalRecords: 0,
        resolvedLocalRecords: 4,
        explicitWallClockRecords: 0,
        otherOrderOnlyRecords: 0,
        declaration: {
          source: "worker/batch.log",
          ianaTimezone: "America/Chicago",
          basis: "user_declared",
          declaredAt: 1710007200,
          appliedRevision: 2,
          declarationFingerprint: FINGERPRINT,
          declaredBy: "analyst-synthetic-01",
        },
      },
    ],
    reviewOutstanding: false,
    undoableRevision: 1,
    ...overrides,
  };
}

describe("timezone identifiers are refused, never repaired", () => {
  it.each([
    ["an empty string", ""],
    ["a bare abbreviation", "CST"],
    ["a POSIX offset string", "GMT+5"],
    ["a free-text guess", "probably central"],
    ["a path traversal", "../../etc/localtime"],
    ["an absolute path", "/usr/share/zoneinfo/America/Chicago"],
    ["a shell fragment", "America/Chicago; rm -rf /"],
    ["a NUL byte", "America/Chicago\u0000"],
    ["a newline", "America/Chicago\nEurope/Berlin"],
    ["a wildcard", "America/*"],
    ["too many path segments", "a/b/c/d/e"],
    ["an oversized id", `America/${"x".repeat(200)}`],
  ])("refuses %s", (_label, zone) => {
    expect(() => assertIanaTimezone("$.ianaTimezone", zone)).toThrow(ContractViolation);
    expect(() => parseLogTimePreviewRequest(previewRequest({ ianaTimezone: zone }))).toThrow(
      ContractViolation,
    );
  });

  it("accepts the ordinary shapes a reviewer actually types", () => {
    for (const zone of [
      "UTC",
      "America/Chicago",
      "Europe/London",
      "Asia/Kolkata",
      "America/Argentina/Buenos_Aires",
      "Etc/GMT+5",
    ]) {
      expect(() => assertIanaTimezone("$.ianaTimezone", zone)).not.toThrow();
    }
  });
});

describe("source identities stay corpus-relative", () => {
  it.each([
    ["an absolute POSIX path", "/var/log/worker.log"],
    ["a Windows drive path", "C:\\logs\\worker.log"],
    ["an upward traversal", "../../etc/passwd"],
    ["a mid-path traversal", "worker/../../secrets.log"],
    ["a NUL byte", "worker/batch\u0000.log"],
  ])("refuses %s", (_label, source) => {
    expect(() => parseLogTimePreviewRequest(previewRequest({ source }))).toThrow(
      ContractViolation,
    );
    expect(() => parseLogTimeApplyRequest(applyRequest({ source }))).toThrow(
      ContractViolation,
    );
  });

  it("refuses a source longer than the Rust resolver accepts", () => {
    const source = `${"a/".repeat(LOG_TIME_LIMITS.maxSourceChars)}batch.log`;
    expect(() => parseLogTimePreviewRequest(previewRequest({ source }))).toThrow(/too long/);
  });
});

describe("a declaration cannot claim provenance it does not have", () => {
  it.each([
    ["uppercase hex", FINGERPRINT.toUpperCase()],
    ["a truncated digest", FINGERPRINT.slice(0, 32)],
    ["a digest with padding", ` ${FINGERPRINT} `],
    ["a non-hex string", "z".repeat(64)],
    ["an empty fingerprint", ""],
  ])("refuses %s as a preview fingerprint", (_label, fingerprint) => {
    expect(() =>
      parseLogTimeApplyRequest(applyRequest({ declarationFingerprint: fingerprint })),
    ).toThrow(ContractViolation);
  });

  it("refuses a declaration attached to a different source than it covers", () => {
    const state = corpusState() as Record<string, unknown>;
    const sources = state.sources as Record<string, unknown>[];
    (sources[0].declaration as Record<string, unknown>).source = "gateway/edge.log";
    expect(() => parseLogCorpusState(state)).toThrow(/does not belong to this source/);
  });

  it("refuses a basis outside the two the pipeline can produce", () => {
    const state = corpusState() as Record<string, unknown>;
    const sources = state.sources as Record<string, unknown>[];
    (sources[0].declaration as Record<string, unknown>).basis = "inferred";
    expect(() => parseLogCorpusState(state)).toThrow(ContractViolation);
  });
});

describe("numbers cannot be smuggled past the shape check", () => {
  it.each([
    ["a numeric string", "3"],
    ["a negative revision", -1],
    ["a fractional revision", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond safe integers", Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s as an expected revision", (_label, value) => {
    expect(() => parseLogTimePreviewRequest(previewRequest({ expectedRevision: value }))).toThrow(
      ContractViolation,
    );
  });

  it("refuses a UTC offset outside the range any real zone uses", () => {
    const preview = {
      schemaId: "cd-collab.log_time_preview.v1",
      caseId: "case-synthetic-0001",
      corpusId: "corpus-synthetic-0001",
      corpusRevision: 1,
      declarationFingerprint: FINGERPRINT,
      source: "worker/batch.log",
      ianaTimezone: "America/Chicago",
      affectedRecords: 1,
      existingWallClockRecords: 0,
      unchangedOrderOnlyRecords: 0,
      firstResolvedInstant: "2024-03-10T07:30:00Z",
      lastResolvedInstant: "2024-03-10T07:30:00Z",
      dstGapCount: 0,
      dstFoldCount: 0,
      unsupportedTimestampCount: 0,
      zoneAbbreviationMismatchCount: 0,
      outOfRangeCount: 0,
      samples: [
        {
          ordinal: 0,
          outcome: "resolved",
          rawTimestamp: "2024-03-10 01:30:00",
          normalizedInstant: "2024-03-10T07:30:00Z",
          utcOffsetSeconds: 999_999,
          unresolvedReason: null,
          excerpt: "synthetic line",
        },
      ],
    };
    expect(() => parseLogTimePreview(preview)).toThrow(/±18h/);
  });
});

describe("unknown keys are drift, not extras", () => {
  it("refuses an injected default timezone on a request", () => {
    expect(() =>
      parseLogTimePreviewRequest(previewRequest({ defaultTimezone: "America/Chicago" })),
    ).toThrow(/unknown key/);
  });

  it("refuses an injected confidence score on a preview", () => {
    expect(() =>
      parseLogTimeApplyRequest(applyRequest({ confidence: 0.92 })),
    ).toThrow(/unknown key/);
  });

  it("does not treat an inherited prototype key as a supplied field", () => {
    const hostile = JSON.parse(
      '{"schemaId":"cd-collab.log_time_clear_request.v1","source":"worker/batch.log",' +
        '"expectedRevision":3,"idempotencyKey":"clear-worker-0001","__proto__":{"polluted":true}}',
    ) as unknown;
    // JSON.parse puts `__proto__` on the object as an own key, so the shape
    // check must see it and refuse rather than silently accept the payload.
    expect(() => parseLogTimeClearRequest(hostile)).toThrow(ContractViolation);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "clear"],
    ["a number", 7],
  ])("refuses %s in place of a request object", (_label, body) => {
    expect(() => parseLogTimeUndoRequest(body)).toThrow(ContractViolation);
  });
});

describe("a corpus state cannot describe an impossible corpus", () => {
  it("refuses a declaration from a revision the corpus has not reached", () => {
    const state = corpusState() as Record<string, unknown>;
    const sources = state.sources as Record<string, unknown>[];
    (sources[0].declaration as Record<string, unknown>).appliedRevision = 99;
    expect(() => parseLogCorpusState(state)).toThrow(/has not reached/);
  });

  it("refuses duplicate source identities", () => {
    const state = corpusState() as Record<string, unknown>;
    const sources = state.sources as Record<string, unknown>[];
    state.sources = [sources[0], { ...sources[0] }];
    expect(() => parseLogCorpusState(state)).toThrow(/duplicate source/);
  });

  it("refuses claiming review is done while a source still waits", () => {
    const state = corpusState() as Record<string, unknown>;
    const sources = state.sources as Record<string, unknown>[];
    sources[0].unresolvedLocalRecords = 7;
    sources[0].declaration = null;
    expect(() => parseLogCorpusState(state)).toThrow(/undeclared local timestamps/);
  });

  it("refuses a revision on a case with no corpus", () => {
    expect(() =>
      parseLogCorpusState(corpusState({ corpusId: null, sources: [] })),
    ).toThrow(/must report revision 0/);
  });

  it("refuses a builtAt that is not a real UTC instant", () => {
    for (const builtAt of ["2024-03-09", "2024-13-45T00:00:00Z", "2024-03-09T18:00:00+02:00"]) {
      expect(() => parseLogCorpusState(corpusState({ builtAt }))).toThrow(ContractViolation);
    }
  });
});

describe("an outcome cannot overstate or understate what happened", () => {
  function outcome(overrides: Record<string, unknown> = {}): unknown {
    return {
      schemaId: "cd-collab.log_time_outcome.v1",
      caseId: "case-synthetic-0001",
      corpusId: "corpus-synthetic-0001",
      operation: "apply",
      source: "worker/batch.log",
      previousRevision: 3,
      appliedRevision: 4,
      restoredRevision: null,
      changedRecords: 4,
      replayed: false,
      declarations: [],
      dependents: [],
      createdAt: "2024-03-10T18:00:00Z",
      createdBy: "analyst-synthetic-01",
      ...overrides,
    };
  }

  it("refuses a durable outcome that did not advance the revision", () => {
    expect(() => parseLogTimeOutcome(outcome({ appliedRevision: 3 }))).toThrow(/must advance/);
    expect(() => parseLogTimeOutcome(outcome({ appliedRevision: 2 }))).toThrow(/must advance/);
  });

  it("refuses a preview dressed up as a durable outcome", () => {
    expect(() => parseLogTimeOutcome(outcome({ operation: "preview" }))).toThrow(
      /never produces a durable outcome/,
    );
  });

  it("refuses claiming a restored revision on an apply", () => {
    expect(() => parseLogTimeOutcome(outcome({ restoredRevision: 2 }))).toThrow(
      /only undo restores/,
    );
  });

  it("refuses an undo that names no restored revision", () => {
    expect(() =>
      parseLogTimeOutcome(outcome({ operation: "undo", source: null })),
    ).toThrow(/must name the earlier revision/);
  });

  it("refuses unknown_basis paired with a revision it claims to know", () => {
    expect(() =>
      parseLogTimeOutcome(
        outcome({
          dependents: [
            {
              kind: "snapshot",
              id: "snapshot-synthetic-0001",
              disposition: "unknown_basis",
              reason: "synthetic",
              observedRevision: 3,
            },
          ],
        }),
      ),
    ).toThrow(/no revision was recorded/);
  });

  it("refuses a disposition outside the four the service can decide", () => {
    expect(() =>
      parseLogTimeOutcome(
        outcome({
          dependents: [
            {
              kind: "snapshot",
              id: "snapshot-synthetic-0001",
              disposition: "probably_fine",
              reason: "synthetic",
              observedRevision: 3,
            },
          ],
        }),
      ),
    ).toThrow(ContractViolation);
  });
});

describe("preview samples cannot contradict their own outcome", () => {
  function preview(samples: unknown[], overrides: Record<string, unknown> = {}): unknown {
    return {
      schemaId: "cd-collab.log_time_preview.v1",
      caseId: "case-synthetic-0001",
      corpusId: "corpus-synthetic-0001",
      corpusRevision: 1,
      declarationFingerprint: FINGERPRINT,
      source: "worker/batch.log",
      ianaTimezone: "America/Chicago",
      affectedRecords: 1,
      existingWallClockRecords: 0,
      unchangedOrderOnlyRecords: 0,
      firstResolvedInstant: "2024-03-10T07:30:00Z",
      lastResolvedInstant: "2024-03-10T07:30:00Z",
      dstGapCount: 0,
      dstFoldCount: 0,
      unsupportedTimestampCount: 0,
      zoneAbbreviationMismatchCount: 0,
      outOfRangeCount: 0,
      samples,
      ...overrides,
    };
  }

  it("refuses a resolved sample with no offset", () => {
    expect(() =>
      parseLogTimePreview(
        preview([
          {
            ordinal: 0,
            outcome: "resolved",
            rawTimestamp: "2024-03-10 01:30:00",
            normalizedInstant: "2024-03-10T07:30:00Z",
            utcOffsetSeconds: null,
            unresolvedReason: null,
            excerpt: "synthetic line",
          },
        ]),
      ),
    ).toThrow(/must carry its instant and offset/);
  });

  it("refuses a resolved sample that discarded the text it resolved from", () => {
    expect(() =>
      parseLogTimePreview(
        preview([
          {
            ordinal: 0,
            outcome: "resolved",
            rawTimestamp: null,
            normalizedInstant: "2024-03-10T07:30:00Z",
            utcOffsetSeconds: -21600,
            unresolvedReason: null,
            excerpt: "synthetic line",
          },
        ]),
      ),
    ).toThrow(/must retain the text it was resolved from/);
  });

  it("refuses a resolved sample that also claims an unresolved reason", () => {
    expect(() =>
      parseLogTimePreview(
        preview([
          {
            ordinal: 0,
            outcome: "resolved",
            rawTimestamp: "2024-03-10 01:30:00",
            normalizedInstant: "2024-03-10T07:30:00Z",
            utcOffsetSeconds: -21600,
            unresolvedReason: "ambiguous_dst_fold",
            excerpt: "synthetic line",
          },
        ]),
      ),
    ).toThrow(/has no unresolved reason/);
  });

  it("refuses an excerpt beyond the bounded length", () => {
    expect(() =>
      parseLogTimePreview(
        preview([
          {
            ordinal: 0,
            outcome: "unresolved",
            rawTimestamp: "2024-03-10 02:30:00",
            normalizedInstant: null,
            utcOffsetSeconds: null,
            unresolvedReason: "nonexistent_dst_gap",
            excerpt: "x".repeat(LOG_TIME_LIMITS.maxExcerptChars + 1),
          },
        ]),
      ),
    ).toThrow(/exceeds cap/);
  });

  it("refuses an unresolved reason the Rust resolver cannot emit", () => {
    expect(() =>
      parseLogTimePreview(
        preview([
          {
            ordinal: 0,
            outcome: "unresolved",
            rawTimestamp: "2024-03-10 02:30:00",
            normalizedInstant: null,
            utcOffsetSeconds: null,
            unresolvedReason: "looked_wrong",
            excerpt: "synthetic line",
          },
        ]),
      ),
    ).toThrow(ContractViolation);
  });
});

describe("idempotency keys stay bounded tokens", () => {
  it.each([
    ["too short", "apply"],
    ["with a space", "apply worker 0001"],
    ["with a slash", "apply/worker/0001"],
    ["with a newline", "apply-worker\n0001"],
    ["oversized", `apply-${"a".repeat(200)}`],
    ["empty", ""],
  ])("refuses %s", (_label, key) => {
    expect(() => parseLogTimeApplyRequest(applyRequest({ idempotencyKey: key }))).toThrow(
      ContractViolation,
    );
  });
});
