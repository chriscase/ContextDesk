import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import { NoiseCandidateReview } from "./NoiseCandidateReview";

vi.mock("../../lib/host", () => ({
  hostLogProposeNoiseCandidates: vi.fn(),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

function candidate(
  overrides: Partial<host.NoiseCandidateDto> = {},
): host.NoiseCandidateDto {
  return {
    templateId: 326,
    templateFingerprint: "template-326-fingerprint",
    pattern: "probe client closed before response route=<*>",
    score: 54,
    eventCount: 12_452,
    corpusShareBps: 498,
    sourceCount: 3,
    timeQuality: "wall",
    wallTimeSpan: { from: 1_735_732_800, to: 1_735_764_039 },
    orderSpan: null,
    levelCounts: [
      { level: "ERROR", count: 12_000 },
      { level: "WARN", count: 452 },
    ],
    otherLevelCount: 0,
    levelCountsTruncated: false,
    errorOrFatalCount: 12_000,
    warnCount: 452,
    infoCount: 0,
    reasonCodes: [
      "high_frequency",
      "multi_source_repetition",
      "repetitive_error_risky",
    ],
    explanation:
      "Proposal score 54 from corpus facts only (not confirmed noise). Human preview and activation required.",
    alreadySuppressed: false,
    shareBasis: "unsuppressed_events",
    proposalKind: "suppression_candidate",
    representatives: [
      {
        seq: 125_060,
        source: "edge/access.jsonl",
        timestamp: 1_735_732_800,
        timeQuality: "wall",
        level: "ERROR",
        redactedExcerpt: "probe client closed token=[REDACTED]",
      },
    ],
    shape: "bursty",
    ...overrides,
  };
}

function report(
  overrides: Partial<host.NoiseCandidateReportDto> = {},
): host.NoiseCandidateReportDto {
  return {
    corpusId: "c1",
    unsuppressedEventCount: 250_000,
    corpusEventCount: 250_000,
    suppressionRevision: 7,
    eventRevision: 4,
    templateAnalysisRevision: 2,
    alreadySuppressedTemplateIds: [],
    timeQuality: "wall",
    rawTimeQuality: "wall",
    candidates: [candidate()],
    templatesScanned: 648,
    eligibleCandidateCount: 24,
    truncated: true,
    candidateCapTruncated: true,
    templateScanTruncated: false,
    responseBytesTruncated: false,
    metadataMissingTemplateIds: [],
    databaseQueryCount: 4,
    disclaimer: "Human review only. Nothing was auto-suppressed.",
    cancelled: false,
    ...overrides,
  };
}

describe("NoiseCandidateReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", memoryStorage());
    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(report());
  });

  it("shows bounded explainable facts without preselection or bulk acceptance", async () => {
    render(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Showing 1 of 24/)).toBeTruthy();
    expect(screen.getByText("12,452")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Bursty or uneven")).toBeTruthy();
    expect(screen.getByText("ERROR 12,000")).toBeTruthy();
    expect(screen.getByText("WARN 452")).toBeTruthy();
    expect(screen.getByText("Repetitive errors — risky to hide")).toBeTruthy();
    expect(
      screen.getByText("probe client closed token=[REDACTED]"),
    ).toBeTruthy();
    expect(screen.getByText(/Additional eligible templates/)).toBeTruthy();
    expect(screen.getByText(/rare, and novel evidence/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept all/i })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("records Not noise only for the current revision and blocks immediate reproposal", async () => {
    const props = {
      corpusId: "c1",
      currentSuppressionRevision: 7,
      onBack: vi.fn(),
      onSuppress: vi.fn(),
    };
    const first = render(<NoiseCandidateReview {...props} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Not noise…" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Record Not noise",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Why dismiss this proposal?"), {
      target: { value: "Possible incident signal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record Not noise" }));
    expect(
      await screen.findByText(/No current suggestions remain/),
    ).toBeTruthy();
    expect(screen.getByText(/Showing 0 of 24/)).toBeTruthy();

    first.unmount();
    render(<NoiseCandidateReview {...props} />);
    expect(
      await screen.findByText(/No current suggestions remain/),
    ).toBeTruthy();

    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(
      report({ eventRevision: 5 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("button", { name: "Not noise…" }),
    ).toBeTruthy();
  });

  it("marks revision drift stale and prevents actions until refreshed", async () => {
    const onSuppress = vi.fn();
    const view = render(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={onSuppress}
      />,
    );
    const suppressButton = await screen.findByRole("button", {
      name: "Suppress…",
    });
    expect((suppressButton as HTMLButtonElement).disabled).toBe(false);

    view.rerender(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={8}
        onBack={vi.fn()}
        onSuppress={onSuppress}
      />,
    );
    expect(await screen.findByText("Suggestions are stale.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Suppress…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Not noise…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(
      report({ suppressionRevision: 8 }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh suggestions" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Suggestions are stale.")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Suppress…" }));
    expect(onSuppress).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 326 }),
      expect.any(HTMLButtonElement),
    );
  });

  it("keeps load failures visible and retryable", async () => {
    vi.mocked(host.hostLogProposeNoiseCandidates)
      .mockRejectedValueOnce(new Error("bounded candidate query timed out"))
      .mockResolvedValueOnce(report({ candidates: [], eligibleCandidateCount: 0 }));
    render(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/bounded candidate query timed out/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText(/No current suggestions remain/),
    ).toBeTruthy();
  });

  it("does not overclaim eligible candidates when only the template scan was bounded", async () => {
    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(
      report({
        truncated: true,
        candidateCapTruncated: false,
        templateScanTruncated: true,
        responseBytesTruncated: false,
      }),
    );
    render(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/template scan reached its safety bound/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Additional eligible templates/)).toBeNull();
  });

  it("keeps a candidate visible when its reviewed dismissal cannot be recorded", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("storage unavailable");
    };
    vi.stubGlobal("localStorage", storage);
    render(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Not noise…" }),
    );
    fireEvent.change(screen.getByLabelText("Why dismiss this proposal?"), {
      target: { value: "Insufficient evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record Not noise" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Not noise was not recorded",
    );
    expect(
      screen.getByText("probe client closed before response route=<*>"),
    ).toBeTruthy();
  });
});
