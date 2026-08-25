import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import { canonicalJson, sha256Text } from "./investigation-portable.js";
import {
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_AI_NOT_HUMAN_FINDING,
  INVESTIGATION_LOCATOR_NOT_AUTHORIZATION,
  INVESTIGATION_RESOURCE_KINDS,
  INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
  canonicalInvestigationActivityBytes,
  compareInvestigationActivityItems,
  formatCompactInvestigationLocator,
  formatInvestigationActivityCursor,
  canonicalRouteSection,
  formatInvestigationResourceLocator,
  investigationActivityFilterFingerprint,
  investigationActivityId,
  isDiscussionSection,
  parseCompactInvestigationLocator,
  routedInvestigationFocus,
  parseInvestigationActivityCursor,
  parseInvestigationActivityError,
  parseInvestigationActivityItem,
  parseInvestigationActivityPage,
  parseInvestigationResourceLocator,
  parseInvestigationResourceResolve,
  safeActorLabel,
  safeInvestigationTitle,
  safeResourceLabel,
} from "./investigation-activity.js";

const INSTALLATION = "inst-syntheticnorth";
const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVIDENCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTIVITY_ID = "ab".repeat(32);
const FILTER_FP = "cd".repeat(32);

function locatorOverlay(overlay: Record<string, unknown> = {}) {
  return {
    schemaId: INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
    version: 1,
    installationId: INSTALLATION,
    investigationId: CASE_A,
    kind: "evidence_item",
    resourceId: EVIDENCE,
    pathname: `/investigations/${CASE_A}/analyze?section=triage-evidence-board&item=${EVIDENCE}&kind=evidence#triage-evidence-board`,
    ...overlay,
  };
}

function itemOverlay(overlay: Record<string, unknown> = {}) {
  const locator = formatInvestigationResourceLocator({
    installationId: INSTALLATION,
    investigationId: CASE_A,
    kind: "evidence_item",
    resourceId: EVIDENCE,
  });
  return {
    schemaId: INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
    activityId: investigationActivityId({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      seq: 2,
      kind: "evidence_registered",
      targetId: EVIDENCE,
      revision: null,
    }),
    occurredAt: "2026-08-24T12:00:00.000Z",
    orderTieBreak: 2,
    actorId: "uid=alice,ou=people,dc=example,dc=test",
    actorLabel: "alice",
    investigationId: CASE_A,
    investigationTitle: "Synthetic queue investigation",
    activityKind: "evidence_added",
    summary: "added evidence",
    locator,
    resolvedRoute: locator.pathname,
    provenanceClass: "human",
    privacyVisibility: "owner_only",
    revision: null,
    sourceEventId: `${CASE_A}:2`,
    humanFinding: false,
    ...overlay,
  };
}

describe("investigation resource locator", () => {
  it("formats a derived pathname and round-trips compact form", () => {
    const locator = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "evidence_item",
      resourceId: EVIDENCE,
    });
    expect(locator.pathname).toBe(
      `/investigations/${CASE_A}/analyze?section=triage-evidence-board&item=${EVIDENCE}&kind=evidence#triage-evidence-board`,
    );
    const compact = formatCompactInvestigationLocator(locator);
    expect(compact).toBe(`cdl.v1/${INSTALLATION}/${CASE_A}/evidence_item/${EVIDENCE}`);
    expect(parseCompactInvestigationLocator(compact)).toEqual(locator);
  });

  it("uses exact shipped War Room sections and preserves a typed workstream key", () => {
    const workstream = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "workstream_attempt",
      resourceId: "run-synthetic-1:reviewer-lane",
    });
    expect(workstream.pathname).toBe(
      `/investigations/${CASE_A}/analyze?section=workstreams&item=run-synthetic-1%3Areviewer-lane&kind=workstream&lane=run-synthetic-1%3Areviewer-lane#workstreams`,
    );
    const comparison = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "comparison_conflict",
      resourceId: EVIDENCE,
    });
    expect(comparison.pathname).toContain("/compare?section=cross-exam-heading");
    const discussion = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "discussion_message",
      resourceId: "message-synthetic-1",
    });
    expect(discussion.pathname).toContain("/situation?section=discussion");
    expect(discussion.pathname).toContain("kind=comment");
    expect(discussion.pathname).not.toContain("case-discussion");
  });

  it("requires revision for decision locators and binds the decide stage", () => {
    const locator = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "decision_revision",
      resourceId: EVIDENCE,
      revision: 3,
    });
    expect(locator.pathname.startsWith(`/investigations/${CASE_A}/decide`)).toBe(true);
    expect(formatCompactInvestigationLocator(locator).endsWith(";rev=3")).toBe(true);
    expect(() =>
      formatInvestigationResourceLocator({
        installationId: INSTALLATION,
        investigationId: CASE_A,
        kind: "decision_revision",
        resourceId: EVIDENCE,
      }),
    ).toThrow(/revision/);
  });

  it("rejects unknown kinds, future versions, traversal, fragments, and malformed ids", () => {
    expect(() => parseInvestigationResourceLocator(locatorOverlay({ kind: "secret_file" }))).toThrow(
      ContractViolation,
    );
    expect(() => parseInvestigationResourceLocator(locatorOverlay({ version: 2 }))).toThrow(
      /unsupported locator version/,
    );
    expect(() =>
      parseInvestigationResourceLocator(locatorOverlay({ resourceId: "../etc/passwd" })),
    ).toThrow(/path traversal|malformed/);
    expect(() =>
      parseInvestigationResourceLocator(
        locatorOverlay({
          pathname: `/investigations/${CASE_A}/analyze?section=triage-evidence-board&item=${EVIDENCE}&kind=evidence#/etc/passwd`,
        }),
      ),
    ).toThrow(/derived resource destination/);
    expect(() =>
      parseInvestigationResourceLocator(locatorOverlay({ investigationId: "not-a-uuid" })),
    ).toThrow(/UUID/);
    expect(() =>
      parseCompactInvestigationLocator(`cdl.v1/${INSTALLATION}/${CASE_A}/evidence_item/..%2f..%2fetc`),
    ).toThrow(/path traversal|URL injection/);
    expect(() =>
      parseCompactInvestigationLocator(`cdl.v2/${INSTALLATION}/${CASE_A}/evidence_item/${EVIDENCE}`),
    ).toThrow(/malformed compact locator/);
    expect(() =>
      parseCompactInvestigationLocator(
        `cdl.v1/${INSTALLATION}/${CASE_A}/evidence_item/${EVIDENCE}?item=1#fragment`,
      ),
    ).toThrow(/path traversal|URL injection/);
  });

  it("rejects unicode and control-character identifiers", () => {
    expect(() =>
      parseInvestigationResourceLocator(locatorOverlay({ resourceId: `id\u0000sneaky` })),
    ).toThrow(/control characters|malformed/);
    expect(() =>
      parseCompactInvestigationLocator(`cdl.v1/${INSTALLATION}/${CASE_A}/evidence_item/id\u202esneaky`),
    ).toThrow(/control characters|malformed|path traversal/);
  });

  it("rejects an investigation locator that names a different resource id", () => {
    expect(() =>
      formatInvestigationResourceLocator({
        installationId: INSTALLATION,
        investigationId: CASE_A,
        kind: "investigation",
        resourceId: CASE_B,
      }),
    ).toThrow(/must match investigationId/);
  });
});

describe("human-readable presentation boundary", () => {
  it("never invents a label and uses bounded honest fallbacks", () => {
    expect(safeResourceLabel("evidence_item", null)).toBe("Evidence item");
    expect(safeResourceLabel("workstream_attempt", CASE_A)).toBe("Workstream attempt");
    expect(safeResourceLabel("evidence_item", "ab".repeat(32))).toBe("Evidence item");
    expect(safeResourceLabel("evidence_item", "case_created")).toBe("Evidence item");
    expect(safeResourceLabel("evidence_item", "Synthetic timeout log")).toBe("Synthetic timeout log");
    expect(safeResourceLabel("timeline_event", null, "12")).toBe("Timeline event 12");
    expect(safeActorLabel("alice")).toBe("alice");
    expect(safeActorLabel("historical-operator")).toBe("Historical participant");
    expect(safeActorLabel(CASE_A)).toBe("Participant");
    expect(safeActorLabel("system")).toBe("System");
    expect(safeInvestigationTitle("Synthetic queue investigation")).toBe("Synthetic queue investigation");
    expect(safeInvestigationTitle(CASE_A)).toBe("Investigation");
    expect(INVESTIGATION_AI_NOT_HUMAN_FINDING).toMatch(/never a human-authored finding/);
    expect(INVESTIGATION_LOCATOR_NOT_AUTHORIZATION).toMatch(/not an authorization token/);
  });
});

describe("investigation activity item and page", () => {
  it("parses a canonical item and rejects unknown fields or AI-as-human claims", () => {
    const item = parseInvestigationActivityItem(itemOverlay());
    expect(item.resolvedRoute).toBe(item.locator.pathname);
    expect(item.humanFinding).toBe(false);
    expect(() => parseInvestigationActivityItem(itemOverlay({ extra: true }))).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationActivityItem(itemOverlay({ provenanceClass: "ai_generated", humanFinding: true })),
    ).toThrow(/human finding/);
    expect(() =>
      parseInvestigationActivityItem(itemOverlay({ actorLabel: CASE_A })),
    ).toThrow(/opaque identifiers/);
    expect(() =>
      parseInvestigationActivityItem(itemOverlay({ summary: CASE_A })),
    ).toThrow(/opaque identifiers/);
  });

  it("requires exact notices and rejects oversized pages", () => {
    const item = parseInvestigationActivityItem(itemOverlay());
    const page = parseInvestigationActivityPage({
      schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
      items: [item],
      nextCursor: null,
      notices: [...INVESTIGATION_ACTIVITY_NOTICES],
    });
    expect(page.items).toHaveLength(1);
    expect(() =>
      parseInvestigationActivityPage({
        schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
        items: [item],
        nextCursor: null,
        notices: INVESTIGATION_ACTIVITY_NOTICES.slice(1),
      }),
    ).toThrow(/notices/);
  });

  it("fail-closes resolve on unauthorized-shaped payloads", () => {
    const locator = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "evidence_item",
      resourceId: EVIDENCE,
    });
    expect(() =>
      parseInvestigationResourceResolve({
        schemaId: "cd-collab.investigation_resource_resolve.v1",
        locator,
        resourceKind: "evidence_item",
        resourceLabel: "Evidence item",
        investigationTitle: "Synthetic queue investigation",
        revision: null,
        authorized: false,
      }),
    ).toThrow(/fail-closed/);
  });

  it("parses bounded activity errors", () => {
    expect(
      parseInvestigationActivityError({
        schemaId: "cd-collab.investigation_activity_error.v1",
        error: "stale_cursor",
      }).error,
    ).toBe("stale_cursor");
    expect(() =>
      parseInvestigationActivityError({
        schemaId: "cd-collab.investigation_activity_error.v1",
        error: "unauthorized_private",
      }),
    ).toThrow(ContractViolation);
  });
});

describe("deterministic identity, ordering, and cursors", () => {
  it("produces byte-identical activity ids for the same authoritative tuple", () => {
    const first = investigationActivityId({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      seq: 4,
      kind: "evidence_registered",
      targetId: EVIDENCE,
      revision: null,
    });
    const second = investigationActivityId({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      seq: 4,
      kind: "evidence_registered",
      targetId: EVIDENCE,
      revision: null,
    });
    expect(first).toBe(second);
    expect(first).toBe(
      sha256Text(
        canonicalJson({
          installationId: INSTALLATION,
          investigationId: CASE_A,
          kind: "evidence_registered",
          revision: null,
          seq: 4,
          targetId: EVIDENCE,
        }),
      ),
    );
  });

  it("orders same timestamps by investigation then seq then activity id", () => {
    const stamp = "2026-08-24T12:00:00.000Z";
    const left = {
      occurredAt: stamp,
      investigationId: CASE_A,
      orderTieBreak: 2,
      activityId: "aa".repeat(32),
    };
    const right = {
      occurredAt: stamp,
      investigationId: CASE_A,
      orderTieBreak: 1,
      activityId: "bb".repeat(32),
    };
    expect(compareInvestigationActivityItems(left, right)).toBeLessThan(0);
  });

  it("rejects malformed and non-canonical cursors rather than restarting", () => {
    const cursor = formatInvestigationActivityCursor({
      v: 1,
      occurredAt: "2026-08-24T12:00:00.000Z",
      investigationId: CASE_A,
      seq: 2,
      activityId: ACTIVITY_ID,
      filterFingerprint: FILTER_FP,
    });
    expect(parseInvestigationActivityCursor(cursor).seq).toBe(2);
    expect(() => parseInvestigationActivityCursor("%%%")).toThrow(/malformed cursor/);
    expect(() => parseInvestigationActivityCursor(cursor.slice(0, 12))).toThrow(/malformed cursor/);
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const shuffled = Buffer.from(JSON.stringify({
      v: decoded.v,
      seq: decoded.seq,
      occurredAt: decoded.occurredAt,
      investigationId: decoded.investigationId,
      activityId: decoded.activityId,
      filterFingerprint: decoded.filterFingerprint,
    })).toString("base64url");
    expect(() => parseInvestigationActivityCursor(shuffled)).toThrow(/malformed cursor/);
  });

  it("fingerprints filters canonically so cursor reuse across filters is detectable", () => {
    expect(
      investigationActivityFilterFingerprint({ investigationId: CASE_A }),
    ).toBe(investigationActivityFilterFingerprint({ investigationId: CASE_A }));
    expect(investigationActivityFilterFingerprint({ investigationId: CASE_A })).not.toBe(
      investigationActivityFilterFingerprint({}),
    );
  });

  it("canonicalizes activity pages to stable bytes", () => {
    const item = parseInvestigationActivityItem(itemOverlay());
    const page = {
      schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
      items: [item],
      nextCursor: null,
      notices: [...INVESTIGATION_ACTIVITY_NOTICES],
    };
    expect(canonicalInvestigationActivityBytes(page)).toBe(canonicalInvestigationActivityBytes(page));
  });
});

describe("routed locator focus against shipped War Room sections", () => {
  it("lands every resource kind on a visible stage/section/item identity", () => {
    const job = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const attempt = `${job}:reviewer-lane`;
    const expected: Record<string, { stage: string; section: string | null; itemKind: string | null; hasLane?: boolean }> = {
      investigation: { stage: "situation", section: "stage-situation", itemKind: null },
      investigation_stage: { stage: "analyze", section: null, itemKind: null },
      evidence_item: { stage: "analyze", section: "triage-evidence-board", itemKind: "evidence" },
      evidence_context: { stage: "analyze", section: "triage-evidence-board", itemKind: null },
      workstream: { stage: "analyze", section: "triage-lane-runner", itemKind: "triage-run" },
      workstream_attempt: { stage: "analyze", section: "workstreams", itemKind: "workstream", hasLane: true },
      workstream_rerun: { stage: "analyze", section: "triage-lane-runner", itemKind: "triage-run" },
      comparison_finding: { stage: "compare", section: "cross-exam-heading", itemKind: null },
      comparison_conflict: { stage: "compare", section: "cross-exam-heading", itemKind: null },
      discussion_message: { stage: "situation", section: "discussion", itemKind: "comment" },
      timeline_event: { stage: "capture", section: "triage-capture", itemKind: "timeline" },
      hypothesis: { stage: "capture", section: "triage-capture", itemKind: "contribution" },
      action: { stage: "capture", section: "triage-capture", itemKind: "contribution" },
      observation: { stage: "capture", section: "triage-capture", itemKind: "contribution" },
      decision_revision: { stage: "decide", section: "decision-heading", itemKind: null },
      export_event: { stage: "decide", section: "export-heading", itemKind: null },
      portable_archive_event: { stage: "decide", section: "export-heading", itemKind: null },
    };
    expect(Object.keys(expected).sort()).toEqual([...INVESTIGATION_RESOURCE_KINDS].sort());

    for (const [kind, want] of Object.entries(expected)) {
      const resourceId = kind === "investigation"
        ? CASE_A
        : kind === "investigation_stage"
          ? "analyze"
          : kind === "timeline_event"
            ? "12"
            : kind === "workstream_attempt"
              ? attempt
              : kind === "discussion_message"
                ? "message-synthetic-1"
                : job;
      const locator = formatInvestigationResourceLocator({
        installationId: INSTALLATION,
        investigationId: CASE_A,
        kind: kind as "evidence_item",
        resourceId,
        ...(kind === "decision_revision" ? { revision: 1 } : {}),
      });
      const routed = routedInvestigationFocus(kind as "evidence_item", resourceId);
      expect(routed.stage, kind).toBe(want.stage);
      expect(routed.section, kind).toBe(want.section);
      expect(routed.itemKind, kind).toBe(want.itemKind);
      if (want.section) {
        expect(locator.pathname).toContain(`/${want.stage}`);
        expect(locator.pathname).toContain(`section=${want.section}`);
        expect(locator.pathname).toContain(`#${want.section}`);
        expect(locator.pathname).not.toContain("case-discussion");
      } else {
        expect(locator.pathname).toBe(`/investigations/${CASE_A}/${want.stage}`);
      }
      if (want.itemKind) {
        expect(locator.pathname).toContain(`kind=${want.itemKind}`);
      }
      if (want.hasLane) {
        expect(locator.pathname).toContain("lane=");
      }
    }
  });

  it("deep-links a job-level workstream to the visible run record, not a missing workstream card", () => {
    const job = formatInvestigationResourceLocator({
      installationId: INSTALLATION,
      investigationId: CASE_A,
      kind: "workstream",
      resourceId: EVIDENCE,
    });
    expect(job.pathname).toBe(
      `/investigations/${CASE_A}/analyze?section=triage-lane-runner&item=${EVIDENCE}&kind=triage-run#triage-lane-runner`,
    );
    expect(job.pathname).not.toContain("section=workstreams");
  });

  it("treats case-discussion as a legacy alias of the Discussion section", () => {
    expect(canonicalRouteSection("case-discussion")).toBe("discussion");
    expect(isDiscussionSection("case-discussion")).toBe(true);
    expect(isDiscussionSection("discussion")).toBe(true);
  });
});
