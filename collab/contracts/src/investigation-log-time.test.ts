import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  LOG_TIME_LIMITS,
  parseLogCorpusState,
  parseLogTimeApplyRequest,
  parseLogTimeClearRequest,
  parseLogTimeOutcome,
  parseLogTimePreview,
  parseLogTimePreviewRequest,
  parseLogTimeUndoRequest,
} from "./investigation-log-time.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

const FINGERPRINT =
  "3f2a1b6c4d5e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

describe("log corpus state", () => {
  it("accepts a synthetic case-bound corpus with mixed resolution", () => {
    const state = parseLogCorpusState(fixture("log-corpus-state.valid.json"));
    expect(state.corpusRevision).toBe(3);
    expect(state.sources).toHaveLength(2);
    expect(state.reviewOutstanding).toBe(true);
  });

  it("rejects an unknown field rather than silently ignoring it", () => {
    expect(() =>
      parseLogCorpusState(fixture("log-corpus-state.unknown-field.json")),
    ).toThrow(ContractViolation);
  });

  it("preserves order-only counts as first-class evidence", () => {
    const state = parseLogCorpusState(fixture("log-corpus-state.valid.json"));
    const worker = state.sources.find((s) => s.source === "worker/batch.log");
    expect(worker?.unresolvedLocalRecords).toBe(17);
    expect(worker?.otherOrderOnlyRecords).toBe(4);
    expect(worker?.declaration).toBeNull();
  });

  it("refuses a declaration claiming a revision the corpus has not reached", () => {
    const raw = fixture("log-corpus-state.valid.json") as Record<string, unknown>;
    const sources = raw.sources as Record<string, unknown>[];
    (sources[0].declaration as Record<string, unknown>).appliedRevision = 99;
    expect(() => parseLogCorpusState(raw)).toThrow(
      /has not reached/,
    );
  });

  it("refuses a reviewOutstanding flag that contradicts the counts", () => {
    const raw = fixture("log-corpus-state.valid.json") as Record<string, unknown>;
    raw.reviewOutstanding = false;
    expect(() => parseLogCorpusState(raw)).toThrow(/undeclared local timestamps/);
  });

  it("refuses an undo target at or after the current revision", () => {
    const raw = fixture("log-corpus-state.valid.json") as Record<string, unknown>;
    raw.undoableRevision = 3;
    expect(() => parseLogCorpusState(raw)).toThrow(/must precede/);
  });

  it("refuses sources on a case that has no corpus yet", () => {
    const raw = fixture("log-corpus-state.valid.json") as Record<string, unknown>;
    raw.corpusId = null;
    raw.corpusRevision = 0;
    expect(() => parseLogCorpusState(raw)).toThrow(/no corpus has no sources/);
  });
});

describe("log time preview", () => {
  it("accepts a preview that reports a DST gap and a fold", () => {
    const preview = parseLogTimePreview(fixture("log-time-preview.valid.json"));
    expect(preview.dstGapCount).toBe(1);
    expect(preview.dstFoldCount).toBe(1);
    expect(preview.unchangedOrderOnlyRecords).toBe(4);
    expect(preview.declarationFingerprint).toBe(FINGERPRINT);
  });

  it("keeps the raw text beside the normalized instant on every sample", () => {
    const preview = parseLogTimePreview(fixture("log-time-preview.valid.json"));
    const resolved = preview.samples.find((s) => s.outcome === "resolved");
    expect(resolved?.rawTimestamp).toBe("2024-03-10 01:30:00");
    expect(resolved?.normalizedInstant).toBe("2024-03-10T07:30:00Z");
    expect(resolved?.utcOffsetSeconds).toBe(-21600);
  });

  it("requires an unresolved sample to say why it stays order-only", () => {
    const raw = fixture("log-time-preview.valid.json") as Record<string, unknown>;
    const samples = raw.samples as Record<string, unknown>[];
    samples[1].unresolvedReason = null;
    expect(() => parseLogTimePreview(raw)).toThrow(/why it stays order-only/);
  });

  it("refuses an unresolved sample that smuggles in an instant", () => {
    const raw = fixture("log-time-preview.valid.json") as Record<string, unknown>;
    const samples = raw.samples as Record<string, unknown>[];
    samples[1].normalizedInstant = "2024-03-10T08:30:00Z";
    expect(() => parseLogTimePreview(raw)).toThrow(/must not carry an instant/);
  });

  it("refuses a resolved range that is absent while records would resolve", () => {
    const raw = fixture("log-time-preview.valid.json") as Record<string, unknown>;
    raw.firstResolvedInstant = null;
    expect(() => parseLogTimePreview(raw)).toThrow(/exactly when records would resolve/);
  });

  it("refuses a backwards resolved range", () => {
    const raw = fixture("log-time-preview.valid.json") as Record<string, unknown>;
    raw.firstResolvedInstant = "2024-03-10T10:00:00Z";
    expect(() => parseLogTimePreview(raw)).toThrow(/must not end before it starts/);
  });

  it("caps the sample count", () => {
    const raw = fixture("log-time-preview.valid.json") as Record<string, unknown>;
    const one = (raw.samples as unknown[])[1];
    raw.samples = Array.from({ length: LOG_TIME_LIMITS.maxPreviewSamples + 1 }, () => ({
      ...(one as Record<string, unknown>),
    }));
    expect(() => parseLogTimePreview(raw)).toThrow(/exceeds cap/);
  });
});

describe("log time requests", () => {
  it("accepts a well-formed preview request", () => {
    const request = parseLogTimePreviewRequest({
      schemaId: "cd-collab.log_time_preview_request.v1",
      source: "worker/batch.log",
      ianaTimezone: "America/Chicago",
      expectedRevision: 3,
    });
    expect(request.ianaTimezone).toBe("America/Chicago");
  });

  it("refuses a zone id that is not an IANA identifier", () => {
    expect(() =>
      parseLogTimePreviewRequest({
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: "worker/batch.log",
        ianaTimezone: "CST (probably)",
        expectedRevision: 3,
      }),
    ).toThrow(/IANA zone id/);
  });

  it("refuses an absolute source path", () => {
    expect(() =>
      parseLogTimePreviewRequest({
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: "/var/log/worker.log",
        ianaTimezone: "America/Chicago",
        expectedRevision: 3,
      }),
    ).toThrow(/corpus-relative/);
  });

  it("refuses an upward-traversing source path", () => {
    expect(() =>
      parseLogTimePreviewRequest({
        schemaId: "cd-collab.log_time_preview_request.v1",
        source: "worker/../../etc/passwd",
        ianaTimezone: "America/Chicago",
        expectedRevision: 3,
      }),
    ).toThrow(/traverse upward/);
  });

  it("requires the preview fingerprint on apply", () => {
    expect(() =>
      parseLogTimeApplyRequest({
        schemaId: "cd-collab.log_time_apply_request.v1",
        source: "worker/batch.log",
        ianaTimezone: "America/Chicago",
        expectedRevision: 3,
        declarationFingerprint: "not-a-digest",
        idempotencyKey: "apply-worker-0001",
      }),
    ).toThrow(/SHA-256/);
  });

  it("accepts a clear request", () => {
    const request = parseLogTimeClearRequest({
      schemaId: "cd-collab.log_time_clear_request.v1",
      source: "worker/batch.log",
      expectedRevision: 4,
      idempotencyKey: "clear-worker-0001",
    });
    expect(request.source).toBe("worker/batch.log");
  });

  it("refuses an undo at revision 0", () => {
    expect(() =>
      parseLogTimeUndoRequest({
        schemaId: "cd-collab.log_time_undo_request.v1",
        expectedRevision: 0,
        idempotencyKey: "undo-worker-0001",
      }),
    ).toThrow(/nothing to undo/);
  });
});

describe("log time outcome", () => {
  it("accepts an apply outcome that revises a snapshot and invalidates a run", () => {
    const outcome = parseLogTimeOutcome(fixture("log-time-outcome.valid.json"));
    expect(outcome.appliedRevision).toBe(4);
    expect(outcome.dependents.map((d) => d.disposition)).toEqual([
      "revised",
      "invalidated",
    ]);
  });

  it("refuses a durable outcome that did not advance the revision", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.appliedRevision = 3;
    expect(() => parseLogTimeOutcome(raw)).toThrow(/must advance/);
  });

  it("requires undo to name the earlier revision it restored", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.operation = "undo";
    expect(() => parseLogTimeOutcome(raw)).toThrow(/must name the earlier revision/);
  });

  it("accepts an undo that advances the revision while restoring an earlier one", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.operation = "undo";
    raw.source = null;
    raw.previousRevision = 4;
    raw.appliedRevision = 5;
    raw.restoredRevision = 3;
    raw.declarations = [];
    const outcome = parseLogTimeOutcome(raw);
    expect(outcome.appliedRevision).toBeGreaterThan(outcome.previousRevision);
    expect(outcome.restoredRevision).toBe(3);
  });

  it("refuses a restoredRevision on a non-undo operation", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.restoredRevision = 2;
    expect(() => parseLogTimeOutcome(raw)).toThrow(/only undo restores/);
  });

  it("refuses an undo claiming to restore a revision it did not precede", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.operation = "undo";
    raw.source = null;
    raw.restoredRevision = 3;
    raw.declarations = [];
    expect(() => parseLogTimeOutcome(raw)).toThrow(/earlier than the one it replaced/);
  });

  it("refuses a preview masquerading as a durable outcome", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    raw.operation = "preview";
    expect(() => parseLogTimeOutcome(raw)).toThrow(/never produces a durable outcome/);
  });

  it("refuses unknown_basis paired with a recorded revision", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    const dependents = raw.dependents as Record<string, unknown>[];
    dependents[0].disposition = "unknown_basis";
    expect(() => parseLogTimeOutcome(raw)).toThrow(/no revision was recorded/);
  });

  it("refuses duplicate dependent entries", () => {
    const raw = fixture("log-time-outcome.valid.json") as Record<string, unknown>;
    const dependents = raw.dependents as Record<string, unknown>[];
    raw.dependents = [dependents[0], { ...dependents[0] }];
    expect(() => parseLogTimeOutcome(raw)).toThrow(/duplicate dependent/);
  });
});
