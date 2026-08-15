import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportedRun } from "./ImportedRun.js";

const INJECT = '<script>alert("xss")</script>';

describe("imported run rendering", () => {
  it("shows the unverified banner and renders script text inertly", () => {
    render(
      <ImportedRun
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
  });

  it("renders contradicted runs distinctly", () => {
    const { container } = render(
      <ImportedRun
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
});
