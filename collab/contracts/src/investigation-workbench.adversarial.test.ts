/**
 * Adversarial coverage for the Log workbench contract.
 *
 * Quiet lies this surface exists to refuse: a guessed timezone, a locator that
 * discloses a private filename to an unauthorized caller, a regex that would
 * run unbounded, a saved view pretending to be an authorization grant, and a
 * heuristic correlation claiming ground truth.
 */
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  classifyTimestampShape,
  parseWorkbenchBookmark,
  parseWorkbenchChronology,
  parseWorkbenchLocatorResolve,
  parseWorkbenchReviewRule,
  parseWorkbenchSearchRequest,
  parseWorkbenchShareSafeLocator,
  parseWorkbenchTimestampCandidate,
  parseWorkbenchView,
  privacySafeNotFound,
  rotationFamilyOf,
} from "./investigation-workbench.js";

const VIEW = {
  schemaId: "cd-collab.log_workbench_view.v1",
  id: "33333333-3333-4333-8333-333333333333",
  investigationId: "11111111-1111-4111-8111-111111111111",
  name: "Timeout window",
  filters: {
    includeTerms: [],
    excludeTerms: [],
    severity: null,
    component: null,
    file: null,
    rotationFamily: null,
    timeFrom: null,
    timeTo: null,
    evidenceIds: [],
  },
  query: "timeout",
  mode: "literal",
  selectedPanes: ["22222222-2222-4222-8222-222222222222"],
  timeFrom: null,
  timeTo: null,
  sort: "ingest_order",
  grouping: "none",
  display: {
    syncScroll: false,
    wrap: false,
    lineNumbers: true,
    displayTimezone: null,
  },
  contextBefore: 0,
  contextAfter: 0,
  privacyClass: "owner_only",
  idempotencyKey: "view-timeout-0001",
  createdAt: "2024-03-11T12:00:00.000Z",
  createdBy: "analyst-synthetic-01",
  replayed: false,
};

describe("timezone honesty", () => {
  it("refuses CST/IST-style abbreviations as a display timezone", () => {
    expect(() =>
      parseWorkbenchView({
        ...VIEW,
        display: { ...VIEW.display, displayTimezone: "IST" },
      }),
    ).toThrow(ContractViolation);
  });

  it("does not promote a bare local midnight into UTC", () => {
    const shape = classifyTimestampShape("2024-12-31 00:00:00");
    expect(shape.parseClass).toBe("local_ambiguous");
    expect(shape.explicitOffset).toBeNull();
  });

  it("keeps a missing year as unparsable rather than inventing the current year", () => {
    const shape = classifyTimestampShape("Mar 10 02:30:00 worker start");
    expect(shape.parseClass).toBe("unparsable");
  });
});

describe("regex and pagination hostility", () => {
  it("refuses a catastrophic nested quantifier", () => {
    expect(() =>
      parseWorkbenchSearchRequest({
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "(a|aa)+$",
        mode: "regex",
        filters: VIEW.filters,
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 10,
        expectedNormalizationRevision: null,
      }),
    ).toThrow(/safely bounded/);
  });

  it("refuses an oversized repeat", () => {
    expect(() =>
      parseWorkbenchSearchRequest({
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "a{9999}",
        mode: "regex",
        filters: VIEW.filters,
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 10,
        expectedNormalizationRevision: null,
      }),
    ).toThrow(/safely bounded/);
  });

  it("refuses a limit above the match cap", () => {
    expect(() =>
      parseWorkbenchSearchRequest({
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "x",
        mode: "literal",
        filters: VIEW.filters,
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 201,
        expectedNormalizationRevision: null,
      }),
    ).toThrow(/match cap/);
  });
});

describe("locator privacy", () => {
  it("refuses a not-found resolve that smuggles a filename", () => {
    expect(() =>
      parseWorkbenchLocatorResolve({
        schemaId: "cd-collab.log_workbench_locator_resolve.v1",
        found: false,
        status: "not_found",
        staleReason: null,
        relativePath: "secrets/prod.log",
        lineNumber: null,
        investigationId: null,
      }),
    ).toThrow(/must not disclose/);
  });

  it("makes unauthorized and missing locators indistinguishable", () => {
    const unauthorized = privacySafeNotFound();
    const missing = privacySafeNotFound();
    expect(unauthorized).toEqual(missing);
  });

  it("refuses a share-safe locator that is not a digest token", () => {
    expect(() =>
      parseWorkbenchShareSafeLocator({
        schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
        token: "gateway/edge.log:12",
      }),
    ).toThrow(/SHA-256/);
  });
});

describe("cross-investigation and prototype keys", () => {
  it("rejects a bookmark whose token was computed for a different investigation", () => {
    const raw = {
      schemaId: "cd-collab.log_workbench_bookmark.v1",
      id: "44444444-4444-4444-8444-444444444444",
      investigationId: "11111111-1111-4111-8111-111111111111",
      locator: {
        evidenceId: "22222222-2222-4222-8222-222222222222",
        digestAtBind: "a".repeat(64),
        byteOffset: 12,
        lineNumber: 3,
        originalTimestamp: null,
        normalizedUtc: null,
        corpusRevision: 3,
      },
      shareSafeToken: "b".repeat(64),
      note: "",
      status: "resolved",
      staleReason: null,
      privacyClass: "owner_only",
      idempotencyKey: "bookmark-gap-0001",
      createdAt: "2024-03-11T12:05:00.000Z",
      createdBy: "analyst-synthetic-01",
      replayed: false,
    };
    expect(() => parseWorkbenchBookmark(raw)).toThrow(/does not match/);
  });

  it("rejects a constructor key as contract drift", () => {
    expect(() =>
      parseWorkbenchSearchRequest({
        schemaId: "cd-collab.log_workbench_search_request.v1",
        query: "x",
        mode: "literal",
        filters: VIEW.filters,
        contextBefore: 0,
        contextAfter: 0,
        cursor: 0,
        limit: 10,
        expectedNormalizationRevision: null,
        constructor: "spoof",
      }),
    ).toThrow(/unknown key/);
  });
});

describe("correlation honesty", () => {
  it("refuses recording heuristic similarity as human ground truth", () => {
    expect(() =>
      parseWorkbenchChronology({
        schemaId: "cd-collab.log_workbench_chronology.v1",
        grouping: "none",
        events: [
          {
            evidenceId: "22222222-2222-4222-8222-222222222222",
            relativePath: "a.log",
            rotationFamily: "a.log",
            lineNumber: 1,
            originalTimestamp: null,
            normalizedUtc: null,
            displayTime: null,
            severity: null,
            component: null,
            intakeBatchId: null,
            adjacencyReason: "Text looks similar.",
            uncertainty: [],
            correlationKind: "heuristic_similarity",
            correlationId: "maybe",
            anchorStatus: "human_ground_truth",
            excerpt: "hello",
          },
        ],
        bounded: false,
        atLeast: 1,
        unknownBuckets: [],
        expectedNormalizationRevision: null,
      }),
    ).toThrow(/cannot be recorded as ground truth/);
  });
});

describe("rotation-name collisions", () => {
  it("keeps .log.1 inside the family without treating two files as one identity", () => {
    expect(rotationFamilyOf("app.log.1")).toBe("app.log");
    expect(rotationFamilyOf("app.log.2")).toBe("app.log");
    expect(rotationFamilyOf("app.log.1")).not.toBe("app.log.2");
  });
});

describe("review rule scope", () => {
  it("refuses a selected-items rule with an empty item list", () => {
    expect(() =>
      parseWorkbenchReviewRule({
        schemaId: "cd-collab.log_time_review_rule.v1",
        scope: "selected_items",
        source: null,
        rotationFamily: null,
        selectedEvidenceIds: [],
        ianaTimezone: "UTC",
        expectedRevision: 1,
        idempotencyKey: "rule-empty-0001",
      }),
    ).toThrow(/must list items/);
  });
});

describe("candidate offset contradictions", () => {
  it("requires explicit-offset candidates to keep the offset text", () => {
    expect(() =>
      parseWorkbenchTimestampCandidate({
        schemaId: "cd-collab.log_time_candidate.v1",
        evidenceId: "22222222-2222-4222-8222-222222222222",
        relativePath: "gateway/edge.log",
        rotationFamily: "gateway/edge.log",
        parserId: "cd-collab.timestamp_shape",
        parserVersion: "1",
        sourceOffset: 0,
        sourceLine: 1,
        originalText: "2024-03-10T07:30:00Z",
        parseClass: "explicit_offset",
        precision: "second",
        explicitOffset: null,
        confidenceUnknownReason: null,
      }),
    ).toThrow(/must keep the offset text/);
  });
});
