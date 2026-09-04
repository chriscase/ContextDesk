import { describe, expect, it } from "vitest";
import {
  INVESTIGATION_ACTIVITY_KINDS as SERVER_ACTIVITY_KINDS,
  INVESTIGATION_ACTIVITY_NOTICES as SERVER_ACTIVITY_NOTICES,
  INVESTIGATION_RESOURCE_KINDS as SERVER_RESOURCE_KINDS,
  parseInvestigationActivityPage as parseServerPage,
} from "./investigation-activity.js";
import {
  INVESTIGATION_ACTIVITY_KINDS,
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_RESOURCE_KINDS,
  INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
  compactInvestigationLocator,
  parseInvestigationActivityPage,
} from "./investigation-activity-browser.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type MutablePage = {
  items: Array<{
    actorLabel: string;
    resolvedRoute: string;
    secondaryContext?: { label: string; value: string };
    locator: { kind: string; resourceId: string; pathname: string };
  }>;
};

function page(nextCursor: string | null = null): unknown {
  const pathname = `/investigations/${CASE_ID}/analyze?section=triage-evidence-board&item=${ARTIFACT_ID}&kind=evidence#triage-evidence-board`;
  return {
    schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
    items: [{
      schemaId: INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
      activityId: "ab".repeat(32),
      occurredAt: "2026-09-03T12:00:00.000Z",
      orderTieBreak: 3,
      actorId: "actor-public-1",
      actorLabel: "Avery",
      investigationId: CASE_ID,
      investigationTitle: "Intermittent gateway resets",
      activityKind: "evidence_added",
      summary: "added evidence",
      locator: {
        schemaId: INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
        version: 1,
        installationId: "inst-syntheticnorth",
        investigationId: CASE_ID,
        kind: "evidence_item",
        resourceId: ARTIFACT_ID,
        pathname,
      },
      resolvedRoute: pathname,
      provenanceClass: "human",
      privacyVisibility: "member",
      revision: null,
      sourceEventId: `${CASE_ID}:3`,
      humanFinding: true,
    }],
    nextCursor,
    notices: [...INVESTIGATION_ACTIVITY_NOTICES],
  };
}

describe("browser investigation activity contract", () => {
  it("keeps browser enums and notices identical to the server contract", () => {
    expect(INVESTIGATION_ACTIVITY_KINDS).toEqual(SERVER_ACTIVITY_KINDS);
    expect(INVESTIGATION_RESOURCE_KINDS).toEqual(SERVER_RESOURCE_KINDS);
    expect(INVESTIGATION_ACTIVITY_NOTICES).toEqual(SERVER_ACTIVITY_NOTICES);
  });
  it("parses canonical activity while keeping the server cursor opaque", () => {
    const parsed = parseInvestigationActivityPage(page("eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0"));
    expect(parsed.items[0]?.activityKind).toBe("evidence_added");
    expect(parsed.nextCursor).toBe("eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0");
    expect(compactInvestigationLocator(parsed.items[0]!.locator)).toBe(
      `cdl.v1/inst-syntheticnorth/${CASE_ID}/evidence_item/${ARTIFACT_ID}`,
    );
  });

  it("fails closed for malformed cursors, routes, and envelopes", () => {
    expect(() => parseInvestigationActivityPage(page("not/a/cursor"))).toThrow(/opaque cursor/);
    const wrongRoute = page() as { items: Array<{ resolvedRoute: string }> };
    wrongRoute.items[0]!.resolvedRoute = "/administration";
    expect(() => parseInvestigationActivityPage(wrongRoute)).toThrow(/same route/);
    const unknown = page() as Record<string, unknown>;
    unknown.extra = true;
    expect(() => parseInvestigationActivityPage(unknown)).toThrow();
  });

  it("matches server rejection of malformed locator identities and presentation text", () => {
    const mutations: Array<(candidate: MutablePage) => void> = [
      (candidate) => { candidate.items[0].locator.pathname = `/investigations/${CASE_ID}evil`; candidate.items[0].resolvedRoute = candidate.items[0].locator.pathname; },
      (candidate) => { candidate.items[0].locator.pathname = `/investigations/${CASE_ID}/../administration`; candidate.items[0].resolvedRoute = candidate.items[0].locator.pathname; },
      (candidate) => { candidate.items[0].locator.kind = "investigation"; candidate.items[0].locator.resourceId = ARTIFACT_ID; },
      (candidate) => { candidate.items[0].locator.kind = "decision_revision"; },
      (candidate) => { candidate.items[0].actorLabel = "Participant\u200bhidden"; },
      (candidate) => { candidate.items[0].secondaryContext = { label: "stage\u202e", value: "capture" }; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(page()) as MutablePage;
      mutate(candidate);
      expect(() => parseServerPage(candidate)).toThrow();
      expect(() => parseInvestigationActivityPage(candidate)).toThrow();
    }
  });
});
