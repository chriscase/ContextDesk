/**
 * Evidence · N UI: host-only set, selection, occupied preview/cancel,
 * investigation confirm/undo, keyboard, layout markers.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceSetPanel } from "./EvidenceSetPanel";
import type { HostEvidenceCitation } from "../lib/evidenceLaneBridge";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
});

function hostCitations(): HostEvidenceCitation[] {
  return [
    {
      id: "log_event:101",
      label: "xyz-api",
      title: "XYZ timeout",
      corpusId: "corpus-xyz-demo",
      source: "xyz/api.log",
      service: "xyz-api",
      timestamp: 1_700_000_101,
      timeQuality: "wall",
    },
    {
      id: "log_event:202",
      label: "xyz-worker",
      title: "XYZ retry",
      corpusId: "corpus-xyz-demo",
      source: "xyz/worker.log",
      service: "xyz-worker",
      timestamp: 1_700_000_202,
      timeQuality: "wall",
    },
    {
      id: "docs/xyz-notes.md",
      label: "xyz-notes",
      title: "Workspace note",
    },
  ];
}

function preparedTarget(token = "prepared-token-1") {
  return {
    commitToken: token,
    investigationId: "inv-xyz-1",
    expectedRevision: 7,
    createsDraft: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EvidenceSetPanel", () => {
  it("exposes Evidence · N from host citations only", () => {
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
      />,
    );
    expect(screen.getByTestId("evidence-set-toggle").textContent).toContain(
      "Evidence · 3",
    );
    expect(screen.getByTestId("evidence-set").getAttribute("data-activity-rail-separate")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("evidence-set").getAttribute("data-customer-evidence-lanes"),
    ).toBe("true");
  });

  it("opens panel and lists only host items; workspace not lane-checkable", async () => {
    const onOpen = vi.fn();
    const onWorkspace = vi.fn();
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={onOpen}
        onOpenWorkspace={onWorkspace}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    expect(screen.getByTestId("evidence-set-panel")).toBeTruthy();
    expect(screen.getByTestId("evidence-item-log_event:101")).toBeTruthy();
    expect(screen.getByTestId("evidence-item-docs/xyz-notes.md")).toBeTruthy();
    // Workspace row has no checkbox
    expect(
      screen
        .getByTestId("evidence-item-docs/xyz-notes.md")
        .querySelector('input[type="checkbox"]'),
    ).toBeNull();

    fireEvent.click(
      screen.getByTestId("evidence-item-docs/xyz-notes.md").querySelector(
        "button.evidence-set__open",
      )!,
    );
    expect(onWorkspace).toHaveBeenCalledWith("docs/xyz-notes.md");

    fireEvent.click(
      screen.getByTestId("evidence-item-log_event:101").querySelector(
        "button.evidence-set__open",
      )!,
    );
    expect(onOpen).toHaveBeenCalledWith("log_event:101", "corpus-xyz-demo");
  });

  it("Show in Explorer persists lanes + visible count and notifies Explorer", async () => {
    const onShow = vi.fn().mockResolvedValue(undefined);
    const appliedEvents: unknown[] = [];
    const onApply = (e: Event) => {
      appliedEvents.push((e as CustomEvent).detail);
    };
    window.addEventListener("contextdesk.evidence-lanes.apply", onApply);
    try {
      render(
        <EvidenceSetPanel
          citations={hostCitations()}
          onOpenCitation={vi.fn()}
          onShowInExplorer={onShow}
          availableCorpusIds={["corpus-xyz-demo"]}
        />,
      );
      fireEvent.click(screen.getByTestId("evidence-set-toggle"));
      fireEvent.click(screen.getByTestId("evidence-mode-one_source_per_lane"));
      fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
      await waitFor(() => expect(onShow).toHaveBeenCalled());
      const plan = onShow.mock.calls[0]![0];
      expect(plan.corpusId).toBe("corpus-xyz-demo");
      expect(plan.navTarget).toEqual({ kind: "event", id: "101" });
      expect(plan.highlightSeqs).toEqual(expect.arrayContaining([101, 202]));
      // Real lane placement — not open-only
      expect(plan.lanes.length).toBeGreaterThanOrEqual(2);
      expect(plan.visibleLaneCount).toBeGreaterThanOrEqual(2);
      expect(plan.lanes.some((l: { sources: string[] }) => l.sources.includes("xyz/api.log"))).toBe(
        true,
      );
      // Persisted for cold open
      const raw = store.get(
        "contextdesk.logExplorer.lanes.v1:corpus-xyz-demo",
      );
      expect(raw).toBeTruthy();
      const savedLanes = JSON.parse(raw!);
      expect(savedLanes.length).toBeGreaterThanOrEqual(2);
      expect(
        store.get("contextdesk.logExplorer.visibleLaneCount.v1:corpus-xyz-demo"),
      ).toBe(String(plan.visibleLaneCount));
      // Live Explorer event carries the same assignment
      expect(appliedEvents.length).toBe(1);
      const detail = appliedEvents[0] as {
        visibleLaneCount: number;
        lanes: { sources: string[] }[];
      };
      expect(detail.visibleLaneCount).toBe(plan.visibleLaneCount);
      expect(detail.lanes).toEqual(plan.lanes);
    } finally {
      window.removeEventListener("contextdesk.evidence-lanes.apply", onApply);
    }
  });

  it("occupied-lane preview cancel keeps layout", async () => {
    // Seed occupied lanes in localStorage
    store.set(
      "contextdesk.logExplorer.lanes.v1:corpus-xyz-demo",
      JSON.stringify([
        { id: "lane-0", label: "Keep me", sources: ["keep/a.log"] },
        { id: "lane-1", label: "Keep two", sources: ["keep/b.log"] },
      ]),
    );
    const onShow = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        onShowInExplorer={onShow}
        availableCorpusIds={["corpus-xyz-demo"]}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-mode-one_source_per_lane"));
    fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-occupied-preview")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("evidence-occupied-cancel"));
    expect(onShow).not.toHaveBeenCalled();
    const kept = JSON.parse(
      store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo")!,
    );
    expect(kept[0].sources).toEqual(["keep/a.log"]);
    expect(screen.getByTestId("evidence-set-status").textContent).toMatch(
      /cancelled/i,
    );
  });

  it("investigation confirm then undo before write never hits host", async () => {
    const onPrepare = vi
      .fn()
      .mockResolvedValueOnce(preparedTarget("token-cancel"))
      .mockResolvedValueOnce(preparedTarget("token-undo"));
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        onPrepareInvestigation={onPrepare}
        onCommitInvestigation={onCommit}
        onCancelPreparedInvestigation={onCancel}
        availableCorpusIds={["corpus-xyz-demo"]}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-add-to-investigation"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-preview")).toBeTruthy(),
    );
    // Cancel path
    fireEvent.click(screen.getByTestId("evidence-investigation-cancel"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith("token-cancel");

    fireEvent.click(screen.getByTestId("evidence-add-to-investigation"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-confirm")).toBeTruthy(),
    );
    // Confirm alone must not host-write
    fireEvent.click(screen.getByTestId("evidence-investigation-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-undo")).toBeTruthy(),
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("evidence-investigation-write")).toBeTruthy();

    // Undo before Write — still no host
    fireEvent.click(screen.getByTestId("evidence-investigation-undo"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith("token-undo");
  });

  it("investigation write after confirm invokes host once", async () => {
    const onPrepare = vi.fn().mockResolvedValue(preparedTarget());
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        onPrepareInvestigation={onPrepare}
        onCommitInvestigation={onCommit}
        availableCorpusIds={["corpus-xyz-demo"]}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-add-to-investigation"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-confirm")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("evidence-investigation-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-write")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("evidence-investigation-write"));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith("prepared-token-1");
    const state = onPrepare.mock.calls[0]![0];
    expect(state.status).toBe("preview");
    expect(state.eventRefs.length).toBe(2);
    expect(state.eventRefs[0].source).toBe("xyz/api.log");
  });

  it("exposes pin / remove / reorder on proposed lanes", async () => {
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        availableCorpusIds={["corpus-xyz-demo"]}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-mode-one_source_per_lane"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-lane-editor")).toBeTruthy(),
    );
    const rows = screen.getAllByTestId(/evidence-lane-row-/);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const firstId = rows[0]!.getAttribute("data-testid")!.replace(
      "evidence-lane-row-",
      "",
    );
    const secondId = rows[1]!.getAttribute("data-testid")!.replace(
      "evidence-lane-row-",
      "",
    );
    fireEvent.click(screen.getByTestId(`evidence-lane-pin-${secondId}`));
    await waitFor(() => {
      const after = screen.getAllByTestId(/evidence-lane-row-/);
      expect(after[0]!.getAttribute("data-testid")).toBe(
        `evidence-lane-row-${secondId}`,
      );
    });
    fireEvent.click(screen.getByTestId(`evidence-lane-down-${secondId}`));
    fireEvent.click(screen.getByTestId(`evidence-lane-remove-${firstId}`));
    await waitFor(() => {
      expect(
        screen.queryByTestId(`evidence-lane-row-${firstId}`),
      ).toBeNull();
    });
  });

  it("Escape closes panel (keyboard focus path)", async () => {
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId("evidence-set-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("evidence-set-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("evidence-set-panel")).toBeNull(),
    );
  });

  it("renders compact class for narrow/linked layouts", () => {
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        compact
      />,
    );
    expect(
      screen.getByTestId("evidence-set").className,
    ).toContain("evidence-set--compact");
  });

  it("renders nothing when host citations empty (forged prose alone insufficient)", () => {
    const { container } = render(
      <EvidenceSetPanel citations={[]} onOpenCitation={vi.fn()} />,
    );
    expect(container.querySelector("[data-testid=evidence-set]")).toBeNull();
  });

  it("chat-shaped citations: host resolve supplies sources on Show in Explorer", async () => {
    // Real main-chat shape: id/label/corpusId only — no source until host resolve.
    const chatShaped: HostEvidenceCitation[] = [
      {
        id: "log_event:101",
        label: "xyz-api",
        title: "XYZ timeout",
        corpusId: "corpus-xyz-demo",
      },
      {
        id: "log_event:202",
        label: "xyz-worker",
        title: "XYZ retry",
        corpusId: "corpus-xyz-demo",
      },
    ];
    const resolveHostEvents = vi.fn(
      async (need: { seq?: number; corpusId?: string }[]) =>
        need.map((item) => {
          if (item.seq === 101) {
            return {
              corpusId: "corpus-xyz-demo",
              seq: 101,
              source: "xyz/api.log",
              ts: 1_700_000_101,
              timeQuality: "wall" as const,
              service: "xyz-api",
            };
          }
          return {
            corpusId: "corpus-xyz-demo",
            seq: 202,
            source: "xyz/worker.log",
            ts: 1_700_000_202,
            timeQuality: "wall" as const,
            service: "xyz-worker",
          };
        }),
    );
    const onShow = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={chatShaped}
        onOpenCitation={vi.fn()}
        onShowInExplorer={onShow}
        resolveHostEvents={resolveHostEvents}
        availableCorpusIds={["corpus-xyz-demo"]}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-mode-one_source_per_lane"));
    fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
    await waitFor(() => expect(resolveHostEvents).toHaveBeenCalled());
    await waitFor(() => expect(onShow).toHaveBeenCalled());
    const plan = onShow.mock.calls[0]![0];
    const sources = plan.lanes
      .flatMap((l: { sources: string[] }) => l.sources)
      .sort();
    // Must use host-resolved sources — not empty unresolved draft lanes.
    expect(sources).toEqual(["xyz/api.log", "xyz/worker.log"]);
    expect(plan.visibleLaneCount).toBeGreaterThanOrEqual(2);
    const raw = store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo");
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!) as { sources: string[] }[];
    expect(saved.flatMap((l) => l.sources).sort()).toEqual([
      "xyz/api.log",
      "xyz/worker.log",
    ]);
  });

  it("freezes controls during host resolution and CAS-blocks a changed occupied layout", async () => {
    store.set(
      "contextdesk.logExplorer.lanes.v1:corpus-xyz-demo",
      JSON.stringify([
        { id: "lane-0", label: "Original", sources: ["original.log"] },
      ]),
    );
    const resolution = deferred<{
      corpusId: string;
      seq: number;
      source: string;
      ts: number;
      timeQuality: "wall";
    }[]>();
    const onShow = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={[
          { id: "log_event:101", label: "event", corpusId: "corpus-xyz-demo" },
        ]}
        onOpenCitation={vi.fn()}
        resolveHostEvents={() => resolution.promise}
        onShowInExplorer={onShow}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
    expect(
      (screen.getByTestId("evidence-select-none") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("evidence-mode-one_lane") as HTMLInputElement).disabled,
    ).toBe(true);
    resolution.resolve([
      {
        corpusId: "corpus-xyz-demo",
        seq: 101,
        source: "resolved.log",
        ts: 101,
        timeQuality: "wall",
      },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("evidence-occupied-preview")).toBeTruthy(),
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("evidence-occupied-confirm"),
    );

    // Simulate another window editing the layout after this exact preview.
    store.set(
      "contextdesk.logExplorer.lanes.v1:corpus-xyz-demo",
      JSON.stringify([
        { id: "lane-0", label: "Other window", sources: ["newer.log"] },
      ]),
    );
    fireEvent.click(screen.getByTestId("evidence-occupied-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-set-status").textContent).toMatch(
        /changed after preview/i,
      ),
    );
    expect(onShow).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo")!,
      )[0].sources,
    ).toEqual(["newer.log"]);
  });

  it("does not persist or broadcast lanes when host open fails", async () => {
    const onShow = vi.fn().mockRejectedValue(new Error("open failed"));
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        onShowInExplorer={onShow}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-set-status").textContent).toMatch(
        /open failed/i,
      ),
    );
    expect(
      store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo"),
    ).toBeUndefined();
  });

  it("explicitly refuses resolved overflow without omitting evidence", async () => {
    const citations: HostEvidenceCitation[] = Array.from({ length: 5 }, (_, i) => ({
      id: `log_event:${i + 1}`,
      label: `event-${i + 1}`,
      corpusId: "corpus-xyz-demo",
      source: `xyz/source-${i + 1}.log`,
      service: `service-${i + 1}`,
      timestamp: i + 1,
      timeQuality: "wall",
    }));
    const onShow = vi.fn().mockResolvedValue(undefined);
    render(
      <EvidenceSetPanel
        citations={citations}
        onOpenCitation={vi.fn()}
        onShowInExplorer={onShow}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-mode-one_source_per_lane"));
    fireEvent.click(screen.getByTestId("evidence-show-in-explorer"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-set-status").textContent).toMatch(
        /would be omitted.*no lane was changed/i,
      ),
    );
    expect(onShow).not.toHaveBeenCalled();
    expect(
      store.get("contextdesk.logExplorer.lanes.v1:corpus-xyz-demo"),
    ).toBeUndefined();
  });

  it("consumes one prepared token once even under duplicate write clicks", async () => {
    const commit = deferred<void>();
    const onCommit = vi.fn(() => commit.promise);
    render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
        onPrepareInvestigation={() => Promise.resolve(preparedTarget("one-shot"))}
        onCommitInvestigation={onCommit}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-add-to-investigation"));
    await waitFor(() =>
      expect(screen.getByTestId("evidence-investigation-confirm")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("evidence-investigation-confirm"));
    const write = await screen.findByTestId("evidence-investigation-write");
    fireEvent.click(write);
    fireEvent.click(write);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("one-shot");
    commit.resolve();
  });

  it("preserves selection across a semantic-identical parent rerender", () => {
    const { rerender } = render(
      <EvidenceSetPanel
        citations={hostCitations()}
        onOpenCitation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("evidence-set-toggle"));
    fireEvent.click(screen.getByTestId("evidence-select-none"));
    rerender(
      <EvidenceSetPanel
        citations={hostCitations().map((citation) => ({ ...citation }))}
        onOpenCitation={vi.fn()}
      />,
    );
    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => !(checkbox as HTMLInputElement).checked),
    ).toBe(true);
  });
});
