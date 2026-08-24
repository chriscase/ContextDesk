import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportedRun } from "./ImportedRun.js";

const INJECT = '<script>alert("xss")</script>';

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
    expect(primaryMeta).toContain("bound to a frozen evidence snapshot");
    expect(primaryMeta).toContain("Source: Synthetic diagnostic export · external-tool");
    expect(primaryMeta).not.toContain("9d063475-e154-44f1-84ef-acde6ebbbac2");
    expect(primaryMeta).not.toContain("snap-0123456789abcdef");

    const technical = screen.getByText("Technical details").closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("9d063475-e154-44f1-84ef-acde6ebbbac2");
    expect(technical.textContent).toContain("snap-0123456789abcdef");
  });
});
