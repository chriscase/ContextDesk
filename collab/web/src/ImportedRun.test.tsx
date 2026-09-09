import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportedRun } from "./ImportedRun.js";

const INJECT = '<script>alert("xss")</script>';

afterEach(() => {
  cleanup();
});

describe("imported run rendering", () => {
  it("shows the unverified banner and renders script text inertly", () => {
    render(
      <ImportedRun
        canCorroborate
        run={{
          id: "r1",
          outputText: INJECT,
          corroborationState: "unverified",
          evidenceVisibility: "unknown",
          snapshotBinding: null,
          importerUsername: "alice",
          operatorUsername: "operator",
          promptText: null,
          promptCompleteness: "unknown",
          redacted: false,
        }}
        onCorroborate={vi.fn()}
      />,
    );
    expect(screen.getByText("Unverified imported run")).toBeTruthy();
    expect(screen.getByText(INJECT)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    const item = screen.getByText("Unverified imported run").closest("article") as HTMLElement;
    expect(item.dataset.routeItem).toBe("r1");
    expect(item.dataset.routeKind).toBe("imported-run");
    expect(screen.getByRole("button", { name: "Save review" })).toBeTruthy();
    expect(item.textContent).toContain("Secret redactionImporter recorded that secret redaction was not applied");
  });

  it("renders contradicted runs distinctly", () => {
    const { container } = render(
      <ImportedRun
        canCorroborate
        run={{
          id: "r2",
          outputText: "no",
          corroborationState: "contradicted",
          evidenceVisibility: "importer_described",
          snapshotBinding: null,
          importerUsername: "alice",
          operatorUsername: "operator",
          promptText: null,
          promptCompleteness: "unknown",
        }}
        onCorroborate={vi.fn()}
      />,
    );
    expect(screen.getByText("Contradicted")).toBeTruthy();
    expect(container.querySelector(".imported-run--contradicted")).toBeTruthy();
  });

  it("keeps opaque source and snapshot identities behind technical details", () => {
    const { container } = render(
      <ImportedRun
        canCorroborate={false}
        run={{
          id: "r3",
          sourceId: "9d063475-e154-44f1-84ef-acde6ebbbac2",
          outputText: "Recorded synthetic finding",
          corroborationState: "unverified",
          evidenceVisibility: "share_safe",
          snapshotBinding: "snap-0123456789abcdef",
          importerUsername: "alice",
          operatorUsername: "operator",
          promptText: null,
          promptCompleteness: "unknown",
        }}
        source={{
          id: "9d063475-e154-44f1-84ef-acde6ebbbac2",
          name: "Synthetic diagnostic export",
          kind: "external-tool",
        }}
        onCorroborate={vi.fn()}
      />,
    );

    const primaryMeta = Array.from(container.querySelectorAll(":scope > article > p"))
      .map((node) => node.textContent ?? "")
      .join(" ");
    expect(primaryMeta).toContain("From Synthetic diagnostic export");
    expect(primaryMeta).not.toContain("9d063475-e154-44f1-84ef-acde6ebbbac2");
    expect(primaryMeta).not.toContain("snap-0123456789abcdef");

    const technical = container.querySelector("details.imported-run__technical") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("Snapshot binding recorded");
    expect(technical.textContent).toContain("9d063475-e154-44f1-84ef-acde6ebbbac2");
    expect(technical.textContent).toContain("snap-0123456789abcdef");
  });

  it("opens a truthful, view-first provenance inspector for a focused imported run", () => {
    const { container } = render(
      <ImportedRun
        focused
        canCorroborate={false}
        run={{
          id: "r4",
          sourceId: "source-4",
          outputText: "Recorded answer",
          corroborationState: "unverified",
          evidenceVisibility: "importer_described",
          snapshotBinding: "snapshot-4",
          importerUsername: "alice",
          operatorUsername: "operator",
          promptText: "Inspect the recorded timeout evidence.",
          promptCompleteness: "partial",
          outputCompleteness: "exact",
          workflowCompleteness: "partial",
          visibilityNote: "Only the selected snapshot was visible.",
          provider: "Recorded assistant",
          model: "Model X",
          version: "2026-09",
          claimedTraces: ["trace supplied by the importing tool"],
          evidenceArtifactIds: ["artifact-1", "artifact-2"],
          uncertainty: "The copied workflow may omit an intermediate step.",
          timing: "8 seconds",
          cost: "$0.02",
          redacted: true,
          privacyClass: "owner_only",
          createdAt: "2026-09-09T12:00:00.000Z",
        }}
        source={{ id: "source-4", name: "Recorded assistant export", kind: "external-tool" }}
        onCorroborate={vi.fn()}
      />,
    );

    const article = screen.getByRole("article", { name: "Recorded assistant export" });
    expect(article.getAttribute("data-focused")).toBe("true");
    const technical = container.querySelector("details.imported-run__technical") as HTMLDetailsElement;
    expect(technical.open).toBe(true);
    expect(technical.textContent).toContain("Prompt coveragePartial");
    expect(technical.textContent).toContain("Output coverageExact");
    expect(technical.textContent).toContain("Workflow coveragePartial");
    expect(technical.textContent).toContain("Evidence visibilityDescribed by the importer");
    expect(technical.textContent).toContain("Evidence items2 items recorded");
    expect(technical.textContent).toContain("Imported byalice");
    expect(technical.textContent).toContain("Run byoperator");
    expect(technical.textContent).toContain("Tool identityRecorded assistant · Model X · 2026-09");
    expect(technical.textContent).toContain("Run timing8 seconds");
    expect(technical.textContent).toContain("Recorded cost$0.02");
    expect(technical.textContent).toContain("PrivacyPrivate to this case");
    expect(technical.textContent).toContain(
      "Importer recorded that secrets were redacted; ContextDesk did not verify that claim",
    );
    expect(technical.textContent).toContain("Recorded visibility note: Only the selected snapshot was visible.");
    expect(technical.textContent).toContain("Recorded uncertainty: The copied workflow may omit an intermediate step.");
    expect(within(article).getByRole("heading", { name: "Claimed traces — not independently verified" })).toBeTruthy();
    expect(technical.textContent).toContain("trace supplied by the importing tool");
    expect(technical.textContent).not.toContain("Verified");
    expect(screen.getByRole("region", { name: "Imported output" }).textContent).toContain("Recorded answer");
    expect(screen.queryByRole("button", { name: "Save review" })).toBeNull();
  });

  it("keeps sparse provenance unknown instead of inferring it from imported text", () => {
    const { container } = render(
      <ImportedRun
        canCorroborate={false}
        run={{
          id: "r5",
          outputText: "Output exists, but its provenance fields do not.",
          corroborationState: "unverified",
          evidenceVisibility: "unknown",
          snapshotBinding: null,
          importerUsername: "alice",
          operatorUsername: "alice",
          promptText: null,
          promptCompleteness: "unknown",
        }}
        onCorroborate={vi.fn()}
      />,
    );

    const technical = container.querySelector("details.imported-run__technical") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("Prompt coverageUnknown");
    expect(technical.textContent).toContain("Output coverageUnknown");
    expect(technical.textContent).toContain("Workflow coverageUnknown");
    expect(technical.textContent).toContain("Evidence visibilityUnknown — not recorded");
    expect(technical.textContent).toContain("Evidence itemsNot recorded");
    expect(technical.textContent).toContain("Tool identityNot recorded");
    expect(technical.textContent).toContain("Imported atNot recorded");
    expect(technical.textContent).toContain("Run timingNot recorded");
    expect(technical.textContent).toContain("Recorded costNot recorded");
    expect(technical.textContent).toContain("PrivacyNot recorded");
    expect(technical.textContent).toContain("Secret redactionNot recorded");
    expect(technical.textContent).not.toContain("redaction was not applied");
    expect(technical.textContent).toContain("Recorded uncertainty: None recorded");
    expect(technical.textContent).toContain("No claimed traces were recorded.");
    expect(technical.textContent).toContain("Original prompt was not recorded.");
    expect(technical.textContent).not.toContain("Output coverageExact");
  });
});
