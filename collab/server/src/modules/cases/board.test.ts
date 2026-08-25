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

  it("projects accepted decisions into the newly-concluded bucket", () => {
    const selected = "a".repeat(64);
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: "snapshot-1",
      selectedSnapshotFingerprint: selected,
      generatedAt: "2026-08-20T00:00:00.000Z",
      artifacts: [],
      contributions: [],
      acceptedDecisions: [
        {
          id: "decision-1",
          statement: "Treat inventory timeout as the benchmark investigation path.",
          evidenceRefs: ["evidence-2", "evidence-1"],
          snapshotFingerprint: selected,
        },
        {
          id: "decision-2",
          statement: "Both strategies converge on inventory timeout.",
          evidenceRefs: [],
          snapshotFingerprint: `snap-${selected}`,
        },
      ],
    });
    const concluded = board.findings.filter((finding) => finding.bucket === "newly_concluded");
    expect(concluded.map((finding) => finding.statement)).toEqual([
      "Treat inventory timeout as the benchmark investigation path.",
      "Both strategies converge on inventory timeout.",
    ]);
    expect(concluded[0]?.basis).toBe("accepted_decision");
    expect(concluded[0]?.evidenceRefs).toEqual(["evidence-1", "evidence-2"]);
    expect(concluded[0]?.agreement).toBe("unknown");
    expect(concluded[0]?.confidence).toBe("unknown");
  });

  it("fails closed when the selected snapshot fingerprint is missing or unverifiable", () => {
    const decision = {
      id: "decision-bound",
      statement: "A bound conclusion must not appear without a verifiable selected freeze.",
      evidenceRefs: [] as string[],
      snapshotFingerprint: "a".repeat(64),
    };
    for (const selectedSnapshotFingerprint of [undefined, null, "not-a-hash"]) {
      const board = deriveCaseBoard({
        caseId: "case-1",
        snapshotId: "snapshot-unknown",
        selectedSnapshotFingerprint,
        generatedAt: "2026-08-20T00:00:00.000Z",
        artifacts: [],
        contributions: [],
        acceptedDecisions: [decision],
      });
      expect(board.findings.filter((finding) => finding.bucket === "newly_concluded")).toEqual([]);
    }
  });

  it("excludes accepted decisions bound to another snapshot fingerprint", () => {
    const selected = "a".repeat(64);
    const other = "b".repeat(64);
    const board = deriveCaseBoard({
      caseId: "case-1",
      snapshotId: "snapshot-a",
      selectedSnapshotFingerprint: selected,
      generatedAt: "2026-08-20T00:00:00.000Z",
      artifacts: [],
      contributions: [],
      acceptedDecisions: [
        {
          id: "decision-selected",
          statement: "Selected freeze conclusion.",
          evidenceRefs: ["evidence-1"],
          snapshotFingerprint: `snap-${selected}`,
        },
        {
          id: "decision-other",
          statement: "Other freeze conclusion must not bleed.",
          evidenceRefs: ["evidence-2"],
          snapshotFingerprint: other,
        },
        {
          id: "decision-unknown",
          statement: "Unverifiable identity must not claim the selected freeze.",
          evidenceRefs: [],
          snapshotFingerprint: "not-a-hash",
        },
      ],
    });
    const concluded = board.findings.filter((finding) => finding.bucket === "newly_concluded");
    expect(concluded.map((finding) => finding.statement)).toEqual(["Selected freeze conclusion."]);
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
