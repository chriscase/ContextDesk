import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createMockEngineClient,
  EngineError,
  type ImportOutcomeReport,
  type ImportRunReport,
} from "@contextdesk/client";
import { ImportFlow } from "./ImportFlow";

const dialogMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn(
    async (): Promise<string | null> => "/incidents/checkout-outage",
  ),
  openFileDialog: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("../../lib/dialogs", () => dialogMocks);

async function toPreflight(
  client = createMockEngineClient(),
  onRunSettled = vi.fn(),
  onRunStarted = vi.fn(),
) {
  const onPublished = vi.fn();
  const utils = render(
    <ImportFlow
      engine={client}
      variant="pane"
      onPublished={onPublished}
      onRunStarted={onRunStarted}
      onRunSettled={onRunSettled}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await screen.findByRole("region", { name: "Ready to import" });
  return { client, onPublished, onRunStarted, onRunSettled, ...utils };
}

async function controlledPreviewClient() {
  const plan = await createMockEngineClient().import.preview("/fixture");
  const client = createMockEngineClient();
  let acknowledge!: () => void;
  let reject!: (error: Error) => void;
  const preview = vi
    .spyOn(client.import, "preview")
    .mockImplementation(
      () =>
        new Promise((resolve, rejectPreview) => {
          acknowledge = () => resolve(plan);
          reject = rejectPreview;
        }),
    );
  const cancel = vi.spyOn(client.import, "cancel").mockResolvedValue(true);
  return {
    client,
    preview,
    cancel,
    acknowledge: () => acknowledge(),
    reject: (error: Error) => reject(error),
  };
}

describe("ImportFlow ordinary path", () => {
  it("is two deliberate actions: choose input, then Import", async () => {
    const { onPublished, onRunStarted, onRunSettled } = await toPreflight();
    expect(
      screen.getByText(/Ready to import — 4 sources/),
    ).toBeTruthy();
    // Import stays disabled until SoftWrite confirmation, with the reason inline.
    const importButton = screen.getByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Tick the SoftWrite confirmation to enable Import."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    expect((importButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(importButton);
    expect(onRunStarted).toHaveBeenCalledOnce();
    expect(onRunStarted).toHaveBeenCalledWith("directory");
    await screen.findByRole("region", { name: "Import finished" });
    expect(onPublished).toHaveBeenCalledWith("mock-corpus-0001");
    expect(onRunSettled).toHaveBeenCalledOnce();
    expect(onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        sourceKind: "directory",
        report: expect.objectContaining({ corpusId: "mock-corpus-0001" }),
      }),
    );
    // Atomic-publication honesty on the summary.
    expect(screen.getByText(/Import finished — corpus mock-corpus-0001/)).toBeTruthy();
  });

  it("keeps the selector out of the ordinary path but one action away", async () => {
    await toPreflight();
    expect(screen.queryByRole("treegrid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review selection…" }));
    expect(screen.getByRole("treegrid", { name: "Discovered items" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("region", { name: "Ready to import" });
  });
});

describe("ImportFlow zero-importable guard", () => {
  it("disables Import with an inline reason when everything is deselected", async () => {
    await toPreflight();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review selection…" }));
    const grid = screen.getByRole("treegrid", { name: "Discovered items" });
    // Deselect every selected leaf via its checkbox.
    for (const checkbox of within(grid).getAllByRole("checkbox")) {
      if ((checkbox as HTMLInputElement).checked && !(checkbox as HTMLInputElement).disabled) {
        fireEvent.click(checkbox);
      }
    }
    expect(
      screen.getAllByText(
        "Nothing selected would import as log events. Select at least one log source.",
      ).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const importButton = await screen.findByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ImportFlow failure, cancel, and retry", () => {
  it("failure leaves the library unchanged and offers retry back to review", async () => {
    const client = createMockEngineClient({ failNextRun: "disk full while staging" });
    const onRunSettled = vi.fn();
    await toPreflight(client, onRunSettled);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Import failed: disk full while staging/)).toBeTruthy();
    expect(screen.getByText(/Nothing was published/)).toBeTruthy();
    expect(onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        sourceKind: "directory",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    await screen.findByRole("region", { name: "Ready to import" });
    // Retry succeeds; the SoftWrite confirmation persists across retry.
    const retryCheckbox = screen.getByRole("checkbox", {
      name: /I understand and want to proceed/,
    }) as HTMLInputElement;
    expect(retryCheckbox.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("region", { name: "Import finished" });
  });

  it("cancellation reports honestly and never claims publication", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    const onRunSettled = vi.fn();
    render(
      <ImportFlow
        engine={client}
        variant="pane"
        onRunSettled={onRunSettled}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    // Preview parks behind manualFlush; release it once it is parked.
    await screen.findByText(/Looking at what/);
    await waitFor(() => {
      client.flush();
    });
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("button", { name: "Cancel ingest" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel ingest" }));
    await screen.findByText(/Import cancelled\. Nothing was published/);
    expect(onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        sourceKind: "directory",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    await screen.findByRole("region", { name: "Ready to import" });
  });
});

describe("ImportFlow hostOwnsProgress (defect: duplicated reviewed-import progress panel)", () => {
  it("renders no progress panel of its own while running when the host owns progress", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    render(<ImportFlow engine={client} variant="pane" hostOwnsProgress />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/Looking at what/);
    await waitFor(() => {
      client.flush();
    });
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I understand and want to proceed/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The run is now in flight (manualFlush parks it there); a host-owned
    // ImportFlow must show none of its own progress chrome or cancel
    // control for it — the host is the single visible surface.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Ready to import" })).toBeNull(),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel ingest" })).toBeNull();
    expect(document.querySelector(".process-progress")).toBeNull();

    client.flush();
    await screen.findByRole("region", { name: "Import finished" });
  });

  it("still owns and shows its own progress panel by default (no host)", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    render(<ImportFlow engine={client} variant="pane" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/Looking at what/);
    await waitFor(() => {
      client.flush();
    });
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I understand and want to proceed/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("button", { name: "Cancel ingest" });
    expect(document.querySelector(".process-progress")).not.toBeNull();
    client.flush();
    await screen.findByRole("region", { name: "Import finished" });
  });
});

describe("ImportFlow preview cancellation lifecycle", () => {
  it("keeps close pending until the preview itself acknowledges cancellation", async () => {
    const { client, cancel, acknowledge } = await controlledPreviewClient();
    const onExit = vi.fn();
    const { rerender } = render(
      <ImportFlow engine={client} variant="guided" exitSignal={0} onExit={onExit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/Looking at what/);

    rerender(
      <ImportFlow engine={client} variant="guided" exitSignal={1} onExit={onExit} />,
    );
    await screen.findByText("Cancelling preview — waiting for the engine to acknowledge…");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Ready to import" })).toBeNull();

    acknowledge();
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Ready to import" })).toBeNull();
  });

  it("requests cancellation on unmount and ignores the late preview result", async () => {
    const { client, cancel, acknowledge } = await controlledPreviewClient();
    const onExit = vi.fn();
    const view = render(
      <ImportFlow engine={client} variant="pane" onExit={onExit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/Looking at what/);

    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    acknowledge();
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.queryByText(/Ready to import/)).toBeNull();
  });

  it("treats a terminal preview error as safe close acknowledgement", async () => {
    const { client, cancel, reject } = await controlledPreviewClient();
    const onExit = vi.fn();
    const { rerender } = render(
      <ImportFlow engine={client} variant="guided" exitSignal={0} onExit={onExit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(/Looking at what/);

    rerender(
      <ImportFlow engine={client} variant="guided" exitSignal={1} onExit={onExit} />,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();

    reject(new Error("preview cancelled"));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("completes an ordinary preview without requesting cancellation", async () => {
    const client = createMockEngineClient();
    const cancel = vi.spyOn(client.import, "cancel");
    render(<ImportFlow engine={client} variant="pane" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByRole("region", { name: "Ready to import" });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("ImportFlow timezone tail", () => {
  it("renders after publication when empty confidence arrays are omitted on the wire", async () => {
    const client = createMockEngineClient();
    const report: ImportRunReport = {
      corpusId: "mixed-time-corpus",
      lines: 12,
      templates: 3,
      reductionRatio: 4,
      embedded: 0,
      files: 2,
      discoveredFiles: 2,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: false,
      sourceBytes: 120,
      corpusBytes: 80,
      tsMin: null,
      tsMax: null,
      formatCounts: { wildfly: 5 },
      confidence: {
        corpusTimeQuality: "order_only",
        counts: {
          wall: 0,
          orderOnly: 2,
          mixed: 0,
          matched: 1,
          ambiguous: 0,
          unknown: 1,
          unresolved: 1,
        },
        sources: [
          {
            source: "raw-without-time.log",
            lines: 7,
            outcome: "unknown",
            timeQuality: "order_only",
          },
          {
            source: "local-calendar.log",
            lines: 5,
            formatId: "wildfly",
            outcome: "matched",
            timeQuality: "order_only",
            unresolvedReasons: ["no_timezone"],
          },
        ],
      },
      // Hosts always send a class. Unresolved timezones are a follow-up, not
      // an import defect — this fixture is a complete publication.
      outcome: {
        schemaId: "contextdesk.import_outcome.v1",
        schemaVersion: 1,
        class: "complete",
        published: true,
        corpusId: "mixed-time-corpus",
        counts: {
          sourcesDiscovered: 2,
          sourcesImported: 2,
          sourcesFailed: 0,
          sourcesExcluded: 0,
          sourcesIgnored: 0,
          recordsImported: 12,
          recordsMalformed: 0,
        },
        defects: [],
        defectCounts: {},
        privacy: {
          redactionMode: "identity_structural_only",
          policySummary: "structural identity only",
          defectsTruncated: false,
        },
        manifestDigest: "sha256:mixed-time",
      },
    };
    vi.spyOn(client.import, "run").mockResolvedValue(report);

    await toPreflight(client);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand and want to proceed/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("region", { name: "Import finished" }),
    ).toBeTruthy();
    expect(screen.getByText("Place local timestamps")).toBeTruthy();
    expect(screen.getByText("1 source unresolved")).toBeTruthy();
  });

  it("shows the corpus-wide time card only when sources are unresolved", async () => {
    await toPreflight();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("region", { name: "Import finished" });
    expect(screen.getByText("Place local timestamps")).toBeTruthy();
    expect(
      screen.getByText(/ContextDesk did not guess a timezone\./),
    ).toBeTruthy();
    // Dismissal never blocks: the summary stays.
    fireEvent.click(
      screen.getByRole("button", { name: "Decide later — keep order-only" }),
    );
    expect(screen.queryByText("Place local timestamps")).toBeNull();
    expect(screen.getByRole("region", { name: "Import finished" })).toBeTruthy();
  });
});

describe("ImportFlow classified outcome", () => {
  it("does not present a partial import as finished", async () => {
    const client = createMockEngineClient();
    const report: ImportRunReport = {
      corpusId: "partial-corpus",
      lines: 8,
      templates: 2,
      reductionRatio: 4,
      embedded: 0,
      files: 2,
      discoveredFiles: 2,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: false,
      sourceBytes: 80,
      corpusBytes: 40,
      tsMin: null,
      tsMax: null,
      formatCounts: { jsonl: 2 },
      confidence: {
        corpusTimeQuality: "wall",
        counts: {
          wall: 2,
          orderOnly: 0,
          mixed: 0,
          matched: 2,
          ambiguous: 0,
          unknown: 0,
          unresolved: 0,
        },
        sources: [],
      },
      outcome: {
        schemaId: "contextdesk.import_outcome.v1",
        schemaVersion: 1,
        class: "partial",
        published: true,
        corpusId: "partial-corpus",
        counts: {
          sourcesDiscovered: 2,
          sourcesImported: 2,
          sourcesFailed: 0,
          sourcesExcluded: 0,
          sourcesIgnored: 0,
          recordsImported: 8,
          recordsMalformed: 2,
        },
        defects: [
          {
            code: "malformed_structured_record",
            severity: "degraded",
            source: {
              identity: "logs/malformed.jsonl",
              archiveChain: [],
              member: "malformed.jsonl",
              archiveDepth: 0,
            },
            location: { line: 2, byteOffset: 40 },
            occurrences: 2,
          },
        ],
        defectCounts: { malformed_structured_record: 2 },
        privacy: {
          redactionMode: "identity_structural_only",
          policySummary: "structural identity only",
          defectsTruncated: false,
        },
        manifestDigest: "sha256:mock-partial",
      },
    };
    vi.spyOn(client.import, "run").mockResolvedValue(report);

    const { onRunSettled } = await toPreflight(client);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I understand and want to proceed/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("region", { name: "Import finished with defects" }),
    ).toBeTruthy();
    expect(screen.getByText(/Import finished with defects \(PARTIAL\)/)).toBeTruthy();
    expect(screen.getByText(/logs\/malformed.jsonl — malformed_structured_record/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Import finished" })).toBeNull();
    expect(screen.queryByText(/^Import finished — corpus/)).toBeNull();
    expect(onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "partial",
        sourceKind: "directory",
        report: expect.objectContaining({ corpusId: "partial-corpus" }),
      }),
    );
  });

  it("does not present a published report with no outcome as finished", async () => {
    const client = createMockEngineClient();
    const report: ImportRunReport = {
      corpusId: "omitted-outcome",
      lines: 8,
      templates: 2,
      reductionRatio: 4,
      embedded: 0,
      files: 2,
      discoveredFiles: 2,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: true,
      sourceBytes: 80,
      corpusBytes: 40,
      tsMin: null,
      tsMax: null,
      formatCounts: { jsonl: 2 },
      confidence: {
        corpusTimeQuality: "wall",
        counts: {
          wall: 2,
          orderOnly: 0,
          mixed: 0,
          matched: 2,
          ambiguous: 0,
          unknown: 0,
          unresolved: 0,
        },
        sources: [],
      },
    };
    vi.spyOn(client.import, "run").mockResolvedValue(report);

    const { onRunSettled } = await toPreflight(client);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I understand and want to proceed/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(
      await screen.findByRole("region", { name: "Import finished with defects" }),
    ).toBeTruthy();
    expect(screen.getByText(/Import finished with defects \(PARTIAL\)/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Import finished" })).toBeNull();
    expect(screen.queryByText(/^Import finished — corpus/)).toBeNull();
    expect(onRunSettled).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "partial" }),
    );
  });

  it("surfaces a rejected ingest outcome instead of a finished import", async () => {
    const client = createMockEngineClient();
    const outcome: ImportOutcomeReport = {
      schemaId: "contextdesk.import_outcome.v1",
      schemaVersion: 1,
      class: "rejected",
      published: false,
      counts: {
        sourcesDiscovered: 1,
        sourcesImported: 0,
        sourcesFailed: 1,
        sourcesExcluded: 0,
        sourcesIgnored: 0,
        recordsImported: 0,
        recordsMalformed: 0,
      },
      defects: [
        {
          code: "archive_unreadable",
          severity: "fatal",
          source: {
            identity: "bundles/inner.zip",
            archiveChain: ["bundles"],
            member: "inner.zip",
            archiveDepth: 1,
          },
          occurrences: 1,
        },
      ],
      defectCounts: { archive_unreadable: 1 },
      privacy: {
        redactionMode: "identity_structural_only",
        policySummary: "structural identity only",
        defectsTruncated: false,
      },
      manifestDigest: "sha256:rejected",
    };
    vi.spyOn(client.import, "run").mockRejectedValue(
      new EngineError("failed", "zip open: missing end record", outcome),
    );

    await toPreflight(client);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I understand and want to proceed/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Import rejected:");
    expect(alert.textContent).toContain("zip open: missing end record");
    expect(alert.textContent).toContain("bundles/inner.zip — archive_unreadable");
    expect(alert.textContent).toContain("Nothing was published — the library is unchanged.");
    expect(alert.textContent).not.toContain("[member=");
    expect(screen.queryByRole("region", { name: "Import finished" })).toBeNull();
    expect(screen.queryByText(/^Import finished — corpus/)).toBeNull();
  });
});

describe("ImportFlow second seal", () => {
  it("never shows a leftover [member= marker from a leaky host string", async () => {
    const client = createMockEngineClient();
    vi.spyOn(client.import, "preview").mockRejectedValue(
      new Error(
        "zip open: missing end record [member=foo [member=sk-abcdefghijklmnopqrst]]",
      ),
    );
    dialogMocks.openFileDialog.mockResolvedValueOnce("/tmp/outer.zip");
    render(<ImportFlow engine={client} variant="pane" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose file or ZIP…" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("zip open: missing end record");
    expect(alert.textContent).not.toContain("[member=");
    expect(alert.textContent).not.toContain("abcdefghijklmnopqrst");
  });
});
