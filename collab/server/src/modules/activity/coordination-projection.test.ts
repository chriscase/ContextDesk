import { describe, expect, it } from "vitest";
import { projectTimelineSource } from "./project.js";

describe("investigation coordination activity projection", () => {
  it.each([
    ["claim_self", "claimed investigation coordination"],
    ["release_self", "released their investigation coordination"],
    ["assign_participant", "assigned investigation coordination"],
    ["release_participant", "released investigation coordination"],
  ])("maps %s to a factual investigation update", (action, summary) => {
    const projected = projectTimelineSource({
      installationId: "inst-syntheticnorth",
      source: {
        caseId: "11111111-1111-4111-8111-111111111111",
        title: "Synthetic coordination",
        event: {
          caseId: "11111111-1111-4111-8111-111111111111",
          seq: 7,
          kind: "investigation_coordination_changed",
          actorId: "local:lead",
          actorUsername: "lead",
          targetId: "11111111-1111-4111-8111-111111111111",
          clientTime: null,
          serverTime: "2026-09-04T20:00:00.000Z",
          payload: JSON.stringify({ action, revision: 2 }),
        },
      },
    });
    expect(projected?.item).toMatchObject({
      activityKind: "investigation_updated",
      summary,
      provenanceClass: "human",
      revision: 2,
    });
    expect(projected?.item.locator).toMatchObject({
      kind: "investigation",
      resourceId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
