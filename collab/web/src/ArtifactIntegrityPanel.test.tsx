import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactIntegrityPanel,
  recordedHashState,
  type IntegrityArtifactRecord,
  type IntegritySnapshotRecord,
} from "./ArtifactIntegrityPanel.js";

afterEach(cleanup);

function openIntegrityDisclosure() {
  const summary = screen.getByText("Artifact identity & integrity");
  const disclosure = summary.closest("details");
  if (!disclosure) throw new Error("artifact integrity disclosure is missing");
  fireEvent.click(summary);
  fireEvent(disclosure, new Event("toggle"));
  return disclosure;
}

function artifact(overrides: Partial<IntegrityArtifactRecord> = {}): IntegrityArtifactRecord {
  return {
    id: "artifact-1",
    kind: "log",
    filename: "checkout.log",
    uri: null,
    mediaType: "text/plain",
    byteLength: 42,
    contentHash: "a".repeat(64),
    expectedHash: "a".repeat(64),
    verificationStatus: "verified",
    privacyClass: "share_safe",
    uploaderId: "alice-id",
    sourceId: "source-1",
    relativePath: "logs/checkout.log",
    intakeBatchId: "batch-1",
    summaryContributionId: "summary-1",
    ...overrides,
  };
}

function snapshot(
  id: string,
  fingerprint: string,
  evidence: IntegritySnapshotRecord["evidence"],
): IntegritySnapshotRecord {
  return {
    id,
    fingerprint,
    evidence,
    visibility: "share_safe",
    createdAt: "2026-09-09T12:00:00.000Z",
    createdBy: "alice-id",
  };
}

describe("ArtifactIntegrityPanel", () => {
  it("composes exact artifact identity, technical hash facts, and snapshot inclusion", () => {
    render(
      <ArtifactIntegrityPanel
        caseId="case-1"
        artifact={artifact()}
        snapshots={[
          snapshot("snapshot-0", "b".repeat(64), [{ evidenceId: "other", ordinal: 0 }]),
          snapshot("snapshot-1", "c".repeat(64), [{ evidenceId: "artifact-1", ordinal: 2 }]),
        ]}
        uploaderLabel="alice"
        snapshotCreatorLabel={() => "alice"}
      >
        <button type="button">Inspect log</button>
      </ArtifactIntegrityPanel>,
    );

    const disclosure = screen.getByText("Artifact identity & integrity").closest("details");
    expect(disclosure?.dataset.integrityScope).toBe(`case-1\u0000artifact-1\u0000${"a".repeat(64)}`);
    openIntegrityDisclosure();

    expect(screen.getByRole("region", { name: "checkout.log artifact identity and integrity" })).toBeTruthy();
    expect(screen.getByText("Recorded hashes match")).toBeTruthy();
    expect(screen.getByText("The recorded content and expected hashes match.")).toBeTruthy();
    expect(screen.getByText("source-1")).toBeTruthy();
    expect(screen.getByText("logs/checkout.log")).toBeTruthy();
    expect(screen.getByText("Snapshot S1")).toBeTruthy();
    expect(screen.getByText(/Position 3 · share_safe · frozen by alice/)).toBeTruthy();
    expect(screen.getByText("c".repeat(64))).toBeTruthy();
    expect(screen.queryByText("Snapshot S0")).toBeNull();
    expect(screen.getByRole("button", { name: "Inspect log" })).toBeTruthy();
    expect(screen.getByText(/do not establish human judgment or investigative relevance/)).toBeTruthy();
  });

  it("keeps recorded technical status distinct from hash mismatch and human judgment", () => {
    const mismatched = artifact({ expectedHash: "d".repeat(64), verificationStatus: "unverified" });
    expect(recordedHashState(mismatched)).toBe("mismatch");
    render(
      <ArtifactIntegrityPanel
        caseId="case-1"
        artifact={mismatched}
        snapshots={[]}
        uploaderLabel="alice"
        snapshotCreatorLabel={() => "Recorded participant"}
      />,
    );
    openIntegrityDisclosure();
    expect(screen.getByText("Recorded hashes differ")).toBeTruthy();
    expect(screen.getByText("The recorded content and expected hashes differ.")).toBeTruthy();
    expect(screen.getByText("unverified")).toBeTruthy();
    expect(screen.getByText("No loaded frozen snapshot includes this artifact.")).toBeTruthy();
    expect(screen.queryByText(/accepted|trusted|authentic|human reviewed/i)).toBeNull();
  });

  it("states the metadata-only and non-live boundary for a file-server reference", () => {
    render(
      <ArtifactIntegrityPanel
        caseId="case-1"
        artifact={artifact({
          kind: "file_server_ref",
          filename: null,
          uri: "file://records/checkout.log",
          contentHash: null,
          expectedHash: null,
          verificationStatus: null,
          sourceId: null,
          relativePath: null,
          intakeBatchId: null,
          summaryContributionId: null,
        })}
        snapshots={[]}
        uploaderLabel="alice"
        snapshotCreatorLabel={() => "alice"}
      />,
    );
    openIntegrityDisclosure();
    expect(screen.getByRole("region", { name: "file://records/checkout.log artifact identity and integrity" })).toBeTruthy();
    expect(screen.getByText("No stored content hash is recorded.")).toBeTruthy();
    expect(screen.getByText(/does not perform a live recheck/)).toBeTruthy();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThanOrEqual(5);
  });
});
