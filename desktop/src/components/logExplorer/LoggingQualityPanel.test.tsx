import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LoggingQualityPanel,
  LoggingQualityToolbarButton,
} from "./LoggingQualityPanel";
import type { LoggingQualityAssessmentHostDto } from "../../lib/loggingQuality/types";

const host = vi.hoisted(() => ({
  assess: vi.fn(),
  exportReport: vi.fn(),
  available: vi.fn(() => true),
}));

vi.mock("../../lib/engine/loggingQuality", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/engine/loggingQuality")>();
  return {
    ...actual,
    assessLoggingQuality: host.assess,
    exportLoggingQualityAssessment: host.exportReport,
    loggingQualityHostAvailable: host.available,
  };
});

function sampleDto(): LoggingQualityAssessmentHostDto {
  return {
    sourceKeyMap: { src_0001: "api/app.jsonl" },
    assessment: {
      schemaId: "contextdesk.logging_quality_assessment.v1",
      schemaVersion: 1,
      privacy: {
        redactionMode: "public_safe_default",
        policySummary: "public safe",
        sourcesTruncated: false,
        inventoryCapped: false,
      },
      corpus: {
        id: "c1",
        name: "demo",
        eventCount: 4,
        templateCount: 2,
        partial: false,
      },
      summary: {
        overallScore: 72,
        grade: "good",
        headline: "Deterministic headline",
        dimensions: [
          {
            id: "time",
            label: "Timestamp certainty",
            score: 80,
            weightBps: 3500,
            measuredFact: "wall share",
          },
        ],
      },
      metrics: {
        timeQuality: "mixed",
        timestampProvenanceCounts: {},
        activeTimestampBasisCounts: {},
        wallEventCount: 2,
        orderOnlyEventCount: 2,
        unresolvedLocalEventCount: 1,
        selection: {
          selectedImported: 2,
          discovered: 3,
          ignored: 1,
          unsupported: 1,
          excludedPolicy: 0,
          failed: 0,
          partial: false,
          exclusionReasonCounts: { binary: 1 },
          availabilityNote: "Buckets are distinct.",
        },
        templates: {
          templateCount: 2,
          eventCount: 4,
          reductionRatio: 2,
          topTemplateShareBps: 5000,
          concentrationHhiBps: 2500,
          topTemplateErrorOrFatalCount: 0,
          topTemplates: [{ templateId: 1, eventCount: 2 }],
          proposalNote: "review signal, not verified noise",
        },
        storedLevel: {
          levelCounts: { info: 3, error: 1 },
          knownLevelCount: 4,
          unknownLevelCount: 0,
          knownLevelShareBps: 10000,
          severityProvenanceAvailable: false,
          honestyNote: "stored level is not severity provenance",
        },
        traceId: {
          withTraceId: 0,
          traceIdShareBps: 0,
          availabilityNote: "trace_id only",
        },
        formatCounts: { json: 4 },
      },
      sources: [
        {
          sourceKey: "src_0001",
          eventCount: 4,
          wallEventCount: 2,
          orderOnlyEventCount: 2,
          unresolvedLocalEventCount: 1,
          withTraceId: 0,
          unknownLevelCount: 0,
        },
      ],
      findings: [
        {
          id: "timestamp.mixed",
          severity: "medium",
          priority: 80,
          category: "timestamp_certainty",
          title: "Mixed timestamp quality",
          measuredFact: "2 wall, 2 order-only",
          finding: "Wall and order-only events coexist.",
          improvementHint: {
            templateId: "hint.timestamp.mixed",
            change: "Emit RFC3339 with offsets on every line.",
            acceptanceCriteria: ["All major sources wall share ≥ 0.90"],
          },
          evidence: [
            {
              kind: "source_aggregate",
              key: "src_0001",
              label: "weak source",
            },
          ],
          confidence: "high",
          limitations: ["no invented UTC"],
        },
        {
          id: "selection.buckets",
          severity: "info",
          priority: 20,
          category: "selection_coverage",
          title: "Selection coverage disclosed",
          measuredFact: "ignored 1 unsupported 1",
          finding: "Buckets remain distinct.",
          improvementHint: {
            templateId: "hint.selection",
            change: "Review unsupported binaries separately.",
            acceptanceCriteria: ["Buckets stay labeled distinctly"],
          },
          evidence: [
            {
              kind: "selection_bucket",
              key: "metrics.selection.unsupported",
              value: 1,
              label: "unsupported",
            },
          ],
          confidence: "high",
          limitations: [],
        },
      ],
      confidence: {
        level: "high",
        summary: "Deterministic scores from durable corpus stats.",
        nonClaims: ["not root cause analysis"],
      },
      limitations: [
        "Stored level is not severity provenance.",
        "Noise concentration is a review signal only.",
      ],
    },
  };
}

describe("LoggingQualityToolbarButton", () => {
  it("is honestly disabled without a corpus", () => {
    render(
      <LoggingQualityToolbarButton corpusId={null} onOpen={vi.fn()} />,
    );
    const btn = screen.getByTestId("lqa-open") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/corpus/i);
  });

  it("opens when a corpus is selected", () => {
    const onOpen = vi.fn();
    render(
      <LoggingQualityToolbarButton corpusId="c1" onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByTestId("lqa-open"));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("LoggingQualityPanel", () => {
  beforeEach(() => {
    host.assess.mockReset();
    host.exportReport.mockReset();
    host.available.mockReturnValue(true);
  });

  it("shows no-corpus honesty and keeps Assess disabled", () => {
    render(
      <LoggingQualityPanel corpusId={null} open onDismiss={vi.fn()} />,
    );
    expect(screen.getByTestId("lqa-no-corpus")).toBeTruthy();
    expect((screen.getByTestId("lqa-run") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("runs assessment, renders score and distinct selection buckets", async () => {
    host.assess.mockResolvedValue(sampleDto());
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    await waitFor(() => expect(screen.getByTestId("lqa-body")).toBeTruthy());
    expect(screen.getByTestId("lqa-summary").textContent).toMatch(/72/);
    expect(screen.getByTestId("lqa-summary").textContent).toMatch(/good/i);
    expect(
      screen.getAllByText(/Deterministic assessment/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("lqa-bucket-ignored").textContent).toMatch(/1/);
    expect(screen.getByTestId("lqa-bucket-unsupported").textContent).toMatch(
      /1/,
    );
    expect(screen.getByTestId("lqa-bucket-partial").textContent).toMatch(/no/i);
    // Measured source-level metrics (opaque keys + counts).
    expect(screen.getByTestId("lqa-sources")).toBeTruthy();
    expect(screen.getByTestId("lqa-source-src_0001").textContent).toMatch(
      /src_0001/,
    );
    expect(screen.getByTestId("lqa-source-src_0001").textContent).toMatch(/4/);
    expect(
      screen.getAllByText(/review signal, not verified noise/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/stored level is not severity provenance/i).length,
    ).toBeGreaterThan(0);
  });

  it("uses a single progress path while running (no dual status panels)", async () => {
    let resolveAssess: (v: LoggingQualityAssessmentHostDto) => void = () => {};
    host.assess.mockImplementation(
      () =>
        new Promise<LoggingQualityAssessmentHostDto>((resolve) => {
          resolveAssess = resolve;
        }),
    );
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    expect(screen.getByTestId("lqa-progress")).toBeTruthy();
    expect(screen.queryByTestId("lqa-status")).toBeNull();
    resolveAssess(sampleDto());
    await waitFor(() => expect(screen.getByTestId("lqa-body")).toBeTruthy());
    expect(screen.queryByTestId("lqa-progress")).toBeNull();
  });

  it("surfaces host failure without claiming export wrote a file", async () => {
    host.assess.mockRejectedValue(new Error("corpus missing"));
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    await waitFor(() => expect(screen.getByTestId("lqa-error")).toBeTruthy());
    expect(screen.getByTestId("lqa-error").textContent).toMatch(/corpus missing/i);
  });

  it("cancels an in-flight run generation", async () => {
    let resolveAssess: (v: LoggingQualityAssessmentHostDto) => void = () => {};
    host.assess.mockImplementation(
      () =>
        new Promise<LoggingQualityAssessmentHostDto>((resolve) => {
          resolveAssess = resolve;
        }),
    );
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    expect(screen.getByTestId("lqa-progress")).toBeTruthy();
    fireEvent.click(screen.getByTestId("lqa-cancel"));
    expect(screen.getByTestId("lqa-status").textContent).toMatch(/cancelled/i);
    // Late resolve must not flip to ready after cancel.
    resolveAssess(sampleDto());
    await waitFor(() =>
      expect(screen.queryByTestId("lqa-body")).toBeNull(),
    );
  });

  it("exports only after host confirms written; no-clobber surfaces failed", async () => {
    host.assess.mockResolvedValue(sampleDto());
    host.exportReport
      .mockResolvedValueOnce({
        status: "written",
        format: "json",
        displayName: "contextdesk-logging-quality.json",
      })
      .mockResolvedValueOnce({
        status: "failed",
        reason: "output already exists or cannot be created",
      });
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    await waitFor(() => expect(screen.getByTestId("lqa-export-json")).toBeTruthy());
    fireEvent.click(screen.getByTestId("lqa-export-json"));
    await waitFor(() =>
      expect(screen.getByTestId("lqa-status").textContent).toMatch(
        /atomic publish confirmed/i,
      ),
    );
    fireEvent.click(screen.getByTestId("lqa-export-json"));
    await waitFor(() =>
      expect(screen.getByTestId("lqa-error").textContent).toMatch(
        /already exists|failed/i,
      ),
    );
  });

  it("Show in Explorer applies lanes for source evidence", async () => {
    host.assess.mockResolvedValue(sampleDto());
    const onShow = vi.fn();
    render(
      <LoggingQualityPanel
        corpusId="c1"
        open
        onDismiss={vi.fn()}
        onShowInExplorer={onShow}
      />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    await waitFor(() =>
      expect(screen.getByTestId("lqa-finding-detail")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("lqa-show-explorer"));
    expect(onShow).toHaveBeenCalled();
    const plan = onShow.mock.calls[0]![0];
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0].sources).toEqual(["api/app.jsonl"]);
  });

  it("aggregate-only finding discloses no fabricated events", async () => {
    host.assess.mockResolvedValue(sampleDto());
    render(
      <LoggingQualityPanel corpusId="c1" open onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("lqa-run"));
    await waitFor(() => expect(screen.getByTestId("lqa-body")).toBeTruthy());
    fireEvent.click(screen.getByTestId("lqa-finding-selection.buckets"));
    expect(screen.getByTestId("lqa-aggregate-only")).toBeTruthy();
  });
});
