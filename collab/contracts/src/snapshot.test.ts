import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import { parseCaseBoard } from "./case-board.js";
import { parseSnapshot, snapshotFingerprint } from "./snapshot.js";

const evidence = [
  {
    evidenceId: "artifact-b",
    ordinal: 1,
    contentHash: "b".repeat(64),
    expectedHash: null,
    verificationStatus: "verified",
    privacyClass: "owner_only" as const,
  },
  {
    evidenceId: "artifact-a",
    ordinal: 0,
    contentHash: null,
    expectedHash: "a".repeat(64),
    verificationStatus: "unverified",
    privacyClass: "share_safe" as const,
  },
];

describe("snapshot and case board contracts", () => {
  it("fingerprints the evidence set deterministically regardless of input order", () => {
    const input = {
      parentSnapshotId: null,
      evidence,
      visibility: "owner_only" as const,
      protocolVersion: "triage-v1",
    };
    expect(snapshotFingerprint(input)).toBe(snapshotFingerprint({ ...input, evidence: [...evidence].reverse() }));
    expect(snapshotFingerprint(input)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes identity when visibility or evidence changes", () => {
    const input = {
      parentSnapshotId: null,
      evidence,
      visibility: "owner_only" as const,
      protocolVersion: "triage-v1",
    };
    expect(snapshotFingerprint(input)).not.toBe(
      snapshotFingerprint({ ...input, visibility: "share_safe" }),
    );
    expect(snapshotFingerprint(input)).not.toBe(
      snapshotFingerprint({ ...input, evidence: evidence.slice(0, 1) }),
    );
  });

  it("parses frozen snapshots and rejects contract drift", () => {
    const snapshot = {
      schemaId: "cd-collab.snapshot.v1",
      id: "snapshot-1",
      caseId: "case-1",
      fingerprint: "f".repeat(64),
      parentSnapshotId: null,
      evidence,
      visibility: "owner_only",
      protocolVersion: "triage-v1",
      fairnessClass: "same_snapshot",
      status: "frozen",
      createdAt: "2026-08-20T00:00:00.000Z",
      createdBy: "alice",
    } as const;
    expect(parseSnapshot(snapshot).status).toBe("frozen");
    expect(() => parseSnapshot({ ...snapshot, mutable: true })).toThrow(ContractViolation);
  });

  it("keeps board agreement separate from correctness and gold", () => {
    const board = parseCaseBoard({
      schemaId: "cd-collab.case_board.v1",
      caseId: "case-1",
      snapshotId: "snapshot-1",
      generatedAt: "2026-08-20T00:00:00.000Z",
      goldStatus: "unknown",
      findings: [
        {
          id: "finding-1",
          bucket: "agreed",
          statement: "Multiple supported hypotheses reference the same evidence.",
          evidenceRefs: ["artifact-a"],
          contributionRefs: ["hypothesis-1", "hypothesis-2"],
          agreement: "shared",
          confidence: "medium",
          basis: "evidence",
        },
      ],
      notice: "Agreement is not proof of correctness.",
    });
    expect(board.goldStatus).toBe("unknown");
    expect(board.findings[0]?.agreement).toBe("shared");
  });
});
