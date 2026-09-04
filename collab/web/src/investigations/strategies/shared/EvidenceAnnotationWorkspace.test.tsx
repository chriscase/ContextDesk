import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceAnnotationWorkspace,
  type EvidenceAnnotationWorkspaceProps,
} from "./EvidenceAnnotationWorkspace.js";
import type { ArtifactAnnotationV1, ArtifactAnnotationBulkResultV1, ArtifactV1, CommandOutcome } from "../../runtime/public.js";

function artifact(id: string): ArtifactV1 {
  return {
    schemaId: "cd-collab.artifact.v1",
    id,
    caseId: "case-1",
    kind: "log",
    filename: `${id}.log`,
    uri: null,
    mediaType: "text/plain",
    byteLength: 128,
    contentHash: null,
    expectedHash: null,
    verificationStatus: "unverified",
    privacyClass: "share_safe",
    summaryContributionId: null,
    uploaderId: "alice",
    sourceId: "import",
  };
}

function annotation(id: string, artifactId: string): ArtifactAnnotationV1 {
  return {
    schemaId: "cd-collab.artifact_annotation.v1",
    id,
    caseId: "case-1",
    artifactId,
    body: "Recorded fact.",
    contentHash: `sha256:${id}`,
    privacyClass: "owner_only",
    authorId: "alice",
    authorUsername: "alice",
    createdAt: "2026-09-04T09:00:00.000Z",
    sourceId: "test",
  };
}

function mount(overrides: Partial<EvidenceAnnotationWorkspaceProps> = {}) {
  const bulkCommand = vi.fn(async () => ({
    status: "succeeded" as const,
    value: {
      schemaId: "cd-collab.artifact_annotation_bulk_result.v1" as const,
      caseId: "case-1",
      items: [],
    },
  }));
  const props: EvidenceAnnotationWorkspaceProps = {
    scopeKey: "case-1\u0000alice",
    evidence: [artifact("artifact-a"), artifact("artifact-b"), artifact("artifact-c")],
    selectedArtifactIds: [],
    annotations: { availability: "available", value: [], refresh: "settled" },
    canAnnotate: true,
    canReadPrivate: true,
    readOnly: false,
    bulkCommand,
    bulkMutation: { status: "idle" },
    bulkErrorCopy: null,
    onRefresh: vi.fn(async () => undefined),
    onClearSelection: vi.fn(),
    ...overrides,
  };
  render(<EvidenceAnnotationWorkspace {...props} />);
  return { props, bulkCommand };
}

afterEach(() => cleanup());

describe("shared evidence annotation workspace", () => {
  it("explains the single-file path and does not invent a bulk write", () => {
    const { bulkCommand } = mount({ selectedArtifactIds: ["artifact-a"] });

    expect(screen.getByText(/Use “Show notes”/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save one note to selected evidence" })).toBeNull();
    expect(bulkCommand).not.toHaveBeenCalled();
  });

  it("submits one trimmed bulk command for the selected set", async () => {
    const { bulkCommand } = mount({ selectedArtifactIds: ["artifact-a", "artifact-b"] });

    fireEvent.change(screen.getByRole("textbox", { name: "Durable note for these files" }), {
      target: { value: "  Both files show the same request ID.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save one note to selected evidence" }));

    await waitFor(() => expect(bulkCommand).toHaveBeenCalledTimes(1));
    expect(bulkCommand).toHaveBeenCalledWith({
      artifactIds: ["artifact-a", "artifact-b"],
      body: "Both files show the same request ID.",
      privacyClass: "owner_only",
      idempotencyKey: expect.stringMatching(/^annotation-bulk-/),
    });
  });

  it("never submits an oversized selection", () => {
    const ids = Array.from({ length: 65 }, (_, index) => `artifact-${index}`);
    const bulkCommand = vi.fn();
    mount({ selectedArtifactIds: ids, bulkCommand });

    expect(screen.getByText(/Select at most 64 files/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save one note to selected evidence" })).toBeNull();
    expect(bulkCommand).not.toHaveBeenCalled();
  });

  it("renders mixed server outcomes without fabricating a note for not_found", async () => {
    const result: ArtifactAnnotationBulkResultV1 = {
      schemaId: "cd-collab.artifact_annotation_bulk_result.v1" as const,
      caseId: "case-1",
      items: [
        { artifactId: "artifact-a", outcome: "created", annotation: annotation("annotation-a", "artifact-a") },
        { artifactId: "artifact-b", outcome: "replayed", annotation: annotation("annotation-b", "artifact-b") },
        { artifactId: "artifact-c", outcome: "not_found" },
      ],
    };
    const bulkCommand = vi.fn(async (): Promise<CommandOutcome<ArtifactAnnotationBulkResultV1>> => ({ status: "succeeded", value: result }));
    mount({ selectedArtifactIds: ["artifact-a", "artifact-b", "artifact-c"], bulkCommand });
    fireEvent.change(screen.getByRole("textbox", { name: "Durable note for these files" }), { target: { value: "Recorded fact." } });
    fireEvent.click(screen.getByRole("button", { name: "Save one note to selected evidence" }));

    await waitFor(() => expect(screen.getByText("Bulk annotation result")).toBeTruthy());
    expect(screen.getByText("created")).toBeTruthy();
    expect(screen.getByText("replayed")).toBeTruthy();
    expect(screen.getByText("not_found")).toBeTruthy();
    expect(screen.getByText("No note was written for this item.")).toBeTruthy();
  });

  it("blocks an unknown outcome until history is refreshed", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const bulkCommand = vi.fn(async () => ({
      status: "failed" as const,
      error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
    }));
    mount({ selectedArtifactIds: ["artifact-a", "artifact-b"], bulkCommand, onRefresh });
    fireEvent.change(screen.getByRole("textbox", { name: "Durable note for these files" }), { target: { value: "Review before retry." } });
    fireEvent.click(screen.getByRole("button", { name: "Save one note to selected evidence" }));

    await waitFor(() => expect(screen.getByText(/Refresh annotation history before submitting/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Save one note to selected evidence" }).getAttribute("disabled")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh annotation history" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it("keeps the workspace read-only when the Runtime removes write capability", () => {
    const { bulkCommand } = mount({ selectedArtifactIds: ["artifact-a", "artifact-b"], canAnnotate: false, readOnly: true });

    expect(screen.getByText(/Notes are read-only in this view/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Durable note for these files" })).toBeNull();
    expect(bulkCommand).not.toHaveBeenCalled();
  });
});
