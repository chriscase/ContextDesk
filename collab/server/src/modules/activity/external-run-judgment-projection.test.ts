import { describe, expect, it } from "vitest";
import { projectTimelineSource } from "./project.js";

describe("external-run judgment activity projection", () => {
  it("projects a factual human review without leaking rationale, links, or private identities", () => {
    const projected = projectTimelineSource({
      installationId: "inst-syntheticnorth",
      source: {
        caseId: "11111111-1111-4111-8111-111111111111",
        title: "Synthetic imported analysis",
        event: {
          caseId: "11111111-1111-4111-8111-111111111111",
          seq: 8,
          kind: "external_run_judgment_recorded",
          actorId: "local:reviewer",
          actorUsername: "reviewer",
          targetId: "33333333-3333-4333-8333-333333333333",
          clientTime: null,
          serverTime: "2026-09-09T20:00:00.000Z",
          payload: JSON.stringify({
            judgment: "contradicts",
            sequence: 2,
            linkCount: 3,
            rationale: "private rationale must never be projected",
            linkedIdentity: "owner-only-record-id",
          }),
        },
      },
    });

    expect(projected?.item).toMatchObject({
      activityKind: "evidence_reviewed",
      summary: "recorded a human judgment on imported analysis",
      provenanceClass: "human",
      humanFinding: false,
      revision: null,
    });
    expect(projected?.item.locator).toMatchObject({
      kind: "imported_ai_run",
      resourceId: "33333333-3333-4333-8333-333333333333",
    });
    expect(JSON.stringify(projected)).not.toContain("private rationale");
    expect(JSON.stringify(projected)).not.toContain("owner-only-record-id");
    expect(JSON.stringify(projected)).not.toContain("contradicts");
  });
});
