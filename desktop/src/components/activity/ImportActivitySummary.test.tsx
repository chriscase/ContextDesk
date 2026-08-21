import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImportActivitySummary } from "./ImportActivitySummary";
import type { ImportRunInput } from "../../lib/activity/types";

const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);

function run(overrides: Partial<ImportRunInput> = {}): ImportRunInput {
  return {
    startedAtMs: T0,
    endedAtMs: T0 + 4_200,
    outcome: "completed",
    sourceKind: "directory",
    report: {
      corpusId: "corpus-1",
      lines: 25_000,
      templates: 10,
      reductionRatio: 4.2,
      embedded: 10,
      files: 12,
      discoveredFiles: 14,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 2,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: false,
      sourceBytes: 2_048,
      corpusBytes: 1_024,
      tsMin: T0,
      tsMax: T0 + 60_000,
      formatCounts: { syslog: 12 },
      embedding: { state: "complete", modelId: "local-embed" },
      confidence: {
        corpusTimeQuality: "order_only",
        counts: {
          wall: 0,
          orderOnly: 12,
          mixed: 0,
          matched: 12,
          ambiguous: 0,
          unknown: 0,
          unresolved: 0,
        },
        sources: [],
      },
    },
    ...overrides,
  };
}

describe("the import summary is quiet by default and honest when opened", () => {
  it("shows one compact line with the measured facts", () => {
    render(<ImportActivitySummary run={run()} />);
    const line = screen.getByTestId("activity-import-summary");
    expect(line.textContent).toMatch(/12\/14 files imported/);
    expect(line.textContent).toMatch(/25,000 events · 10 templates/);
    expect(line.textContent).toMatch(/in 4\.2 s/);
    // The ledger stays closed until asked for.
    expect(screen.queryByTestId("activity-import-ledger")).toBeNull();
  });

  it("names an order-only corpus as not calendar time, right on the line", () => {
    render(<ImportActivitySummary run={run()} />);
    expect(screen.getByTestId("activity-import-summary").textContent).toMatch(
      /order only \(not calendar time\)/i,
    );
  });

  it("opens the full ledger on request, with a labelled disclosure", () => {
    render(<ImportActivitySummary run={run()} />);
    const toggle = screen.getByTestId("activity-import-details-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const ledger = screen.getByTestId("activity-import-ledger");
    for (const section of [
      "Inclusion & exclusion",
      "Parser & format",
      "Redaction & normalization",
      "Timestamp & timezone provenance",
      "Indexing & templates",
      "Model & network hooks",
    ]) {
      expect(ledger.textContent, section).toContain(section);
    }
  });

  it("states redaction as a standing contract, not a per-run measurement", () => {
    // Claiming "we verified redaction on this run" would be a proof the app
    // did not perform; the wording has to say which it is.
    render(<ImportActivitySummary run={run()} />);
    fireEvent.click(screen.getByTestId("activity-import-details-toggle"));
    expect(screen.getByTestId("activity-import-ledger").textContent).toMatch(
      /standing import contract — not a per-run measurement/i,
    );
  });

  it("discloses the model hook's trigger and data scope when one ran", () => {
    render(<ImportActivitySummary run={run()} />);
    fireEvent.click(screen.getByTestId("activity-import-details-toggle"));
    const ledger = screen.getByTestId("activity-import-ledger");
    expect(ledger.textContent).toMatch(/Local embedding model ran/i);
    expect(ledger.textContent).toMatch(/trigger: optional embedding phase/i);
    expect(ledger.textContent).toMatch(
      /data scope: learned templates of this corpus only/i,
    );
  });

  it("says plainly when no model ran", () => {
    const noModel = run();
    noModel.report!.embedding = { state: "keyword_only", modelId: null };
    render(<ImportActivitySummary run={noModel} />);
    fireEvent.click(screen.getByTestId("activity-import-details-toggle"));
    expect(screen.getByTestId("activity-import-ledger").textContent).toMatch(
      /None ran during this import/i,
    );
  });

  it("does not record a classified partial import as completed", () => {
    render(
      <ImportActivitySummary
        run={run({
          outcome: "partial",
          report: {
            ...run().report!,
            partial: false,
            outcome: { class: "partial" },
          },
        })}
      />,
    );
    const summary = screen.getByTestId("activity-import-summary");
    expect(summary.getAttribute("data-outcome")).toBe("partial");
    expect(summary.getAttribute("data-outcome")).not.toBe("completed");
    fireEvent.click(screen.getByTestId("activity-import-details-toggle"));
    const ledger = screen.getByTestId("activity-import-ledger");
    expect(ledger.textContent).toMatch(/Coverage/);
    expect(ledger.textContent).toMatch(
      /Partial — the import finished with defects/,
    );
  });

  it("reports a failed import as publishing nothing", () => {
    render(
      <ImportActivitySummary
        run={run({
          outcome: "failed",
          report: null,
          diagnostic: {
            reasonCode: "read_failed",
            summary: "Could not read the archive",
            cancelled: false,
            evidence: {
              scanCounts: {
                binary: 0,
                empty: 0,
                hidden: 0,
                oversized: 0,
                readFailed: 3,
                parseFailed: 0,
              },
              omittedEntries: 0,
            },
          },
        })}
      />,
    );
    const summary = screen.getByTestId("activity-import-summary");
    expect(summary.getAttribute("data-outcome")).toBe("failed");
    expect(summary.textContent).toMatch(/nothing published/i);
    fireEvent.click(screen.getByTestId("activity-import-details-toggle"));
    expect(screen.getByTestId("activity-import-ledger").textContent).toMatch(
      /no corpus was created by this attempt/i,
    );
  });
});
