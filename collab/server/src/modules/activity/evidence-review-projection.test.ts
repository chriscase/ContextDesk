import { describe, expect, it } from "vitest";
import { projectTimelineSource } from "./project.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";

describe("evidence review activity projection", () => {
  it.each([
    ["evidence_attributed", "attributed existing evidence", "evidence_item", "system"],
    ["evidence_recheck", "rechecked evidence integrity", "evidence_item", "system"],
    ["run_corroboration", "reviewed imported analysis", "imported_ai_run", "human"],
  ] as const)(
    "maps %s to its recorded action without claiming a system review",
    (kind, summary, resourceKind, provenanceClass) => {
      const projected = projectTimelineSource({
        installationId: "inst-syntheticnorth",
        source: {
          caseId: CASE_ID,
          title: "Synthetic evidence review",
          event: {
            caseId: CASE_ID,
            seq: 7,
            kind,
            actorId: "local:reviewer",
            actorUsername: "reviewer",
            targetId: RESOURCE_ID,
            clientTime: null,
            serverTime: "2026-09-09T12:00:00.000Z",
            payload: "{}",
          },
        },
      });

      expect(projected?.item).toMatchObject({
        activityKind: "evidence_reviewed",
        summary,
        provenanceClass,
        humanFinding: false,
      });
      expect(projected?.item.locator).toMatchObject({
        kind: resourceKind,
        resourceId: RESOURCE_ID,
      });
    },
  );
});
