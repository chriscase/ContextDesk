import { describe, expect, it } from "vitest";
import { deriveCaseBoard } from "./board.js";
import type { ArtifactV1, ContributionV1 } from "@cd-collab/contracts";

const artifact = (id: string, verified: boolean): ArtifactV1 => ({
  schemaId: "cd-collab.artifact.v1",
  id,
  caseId: "case-1",
  kind: "log",
  filename: `${id}.log`,
  uri: null,
  mediaType: "text/plain",
  byteLength: 10,
  contentHash: verified ? "a".repeat(64) : null,
  expectedHash: null,
  verificationStatus: verified ? "verified" : "unverified",
  privacyClass: "share_safe",
  summaryContributionId: null,
  uploaderId: "alice",
  sourceId: "human",
});

const hypothesis = (id: string, status: "supported" | "contradicted"): ContributionV1 => ({
  schemaId: "cd-collab.contribution.v1",
  id,
  caseId: "case-1",
  kind: "hypothesis",
  revision: 1,
  predecessorRevision: null,
  body: `Hypothesis ${id}`,
  contentHash: "b".repeat(64),
  privacyClass: "share_safe",
  tombstoned: false,
  authorId: "alice",
  authorUsername: "alice",
  createdAt: "2026-08-20T00:00:00.000Z",
  hypothesisStatus: status,
  hypothesisLinks: [{ kind: "artifact", id: "evidence-1" }],
  sourceId: "human",
});

describe("deriveCaseBoard", () => {
  it("separates verified knowledge, unknown evidence, and disputed hypotheses", () => {
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: "snapshot-1",
      generatedAt: "2026-08-20T00:00:00.000Z",
      artifacts: [artifact("evidence-1", true), artifact("evidence-2", false)],
      contributions: [hypothesis("hypothesis-1", "contradicted")],
    });
    expect(board.findings.map((finding) => finding.bucket)).toEqual([
      "known",
      "unknown",
      "disputed",
    ]);
    expect(board.goldStatus).toBe("unknown");
    expect(board.notice).toBe("Agreement is not proof of correctness.");
  });

  it("marks shared evidence as agreement without treating it as correctness", () => {
    const first = hypothesis("hypothesis-1", "supported");
    const second = hypothesis("hypothesis-2", "supported");
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: null,
      generatedAt: "2026-08-20T00:00:00.000Z",
      artifacts: [],
      contributions: [first, second],
    });
    const agreed = board.findings.find((finding) => finding.bucket === "agreed");
    expect(agreed?.agreement).toBe("shared");
    expect(agreed?.basis).toBe("evidence");
    expect(board.goldStatus).toBe("unknown");
  });
});
