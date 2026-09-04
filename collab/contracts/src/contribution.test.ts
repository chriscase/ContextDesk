import { describe, expect, it } from "vitest";
import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SCHEMA_ID,
  isContributionIdempotencyKey,
  parseContribution,
} from "./contribution.js";
import {
  CONTRIBUTION_KINDS as browserContributionKinds,
  isContributionIdempotencyKey as browserIsContributionIdempotencyKey,
  parseContribution as browserParseContribution,
} from "./investigation-runtime-browser.js";

function contribution(kind: string) {
  return {
    schemaId: CONTRIBUTION_SCHEMA_ID,
    id: "contribution-handoff-1",
    caseId: "case-1",
    kind,
    revision: 1,
    predecessorRevision: null,
    body: "Overnight queue time remains high after the pool change.",
    contentHash: "sha256:handoff-body",
    privacyClass: "share_safe",
    tombstoned: false,
    authorId: "identity-alice",
    authorUsername: "alice",
    createdAt: "2026-09-03T08:00:00.000Z",
    hypothesisStatus: null,
    hypothesisLinks: null,
    sourceId: "source-human",
  };
}

describe("contribution kind contract", () => {
  it("accepts a handoff contribution through the parser and browser runtime surface", () => {
    expect(CONTRIBUTION_KINDS).toContain("handoff");
    expect(browserContributionKinds).toBe(CONTRIBUTION_KINDS);

    const parsed = parseContribution(contribution("handoff"));
    expect(parsed.kind).toBe("handoff");
    expect(parsed.body).toBe("Overnight queue time remains high after the pool change.");
    expect(browserParseContribution(contribution("handoff"))).toEqual(parsed);
  });

  it("rejects unknown contribution kinds", () => {
    expect(() => parseContribution(contribution("priority"))).toThrow(
      /expected one of \[message, note, hypothesis, action, upload, external_run, handoff\]/,
    );
    expect(() => parseContribution(contribution("lease"))).toThrow(/handoff/);
    expect(() => browserParseContribution(contribution("status_write"))).toThrow(
      /got string "status_write"/,
    );
  });

  it("accepts generated handoff retry keys and rejects unverifiable tokens", () => {
    expect(isContributionIdempotencyKey).toBe(browserIsContributionIdempotencyKey);
    expect(
      isContributionIdempotencyKey("handoff-11111111-1111-4111-8111-111111111111"),
    ).toBe(true);
    expect(isContributionIdempotencyKey("handoff-fallback-abc12345")).toBe(true);
    expect(isContributionIdempotencyKey("short")).toBe(false);
    expect(isContributionIdempotencyKey("handoff/not-a-key")).toBe(false);
  });
});
