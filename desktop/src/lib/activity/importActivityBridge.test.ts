import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportRunInput } from "./types";
import {
  IMPORT_ACTIVITY_CHANGED_EVENT,
  loadCorpusImportActivity,
  publishImportRunActivity,
  subscribeImportRunActivity,
} from "./importActivityBridge";

function completedRun(corpusId = "corpus-a"): ImportRunInput {
  return {
    startedAtMs: 1_000,
    endedAtMs: 2_500,
    outcome: "completed",
    sourceKind: "zip",
    report: {
      corpusId,
      lines: 120,
      templates: 12,
      reductionRatio: 10,
      embedded: 0,
      files: 2,
      discoveredFiles: 3,
      excludedFiles: 1,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: { unsupported: 1 },
      exclusionExamples: ["ignored-markup.xml"],
      partial: false,
      sourceBytes: 4_000,
      corpusBytes: 2_000,
      tsMin: null,
      tsMax: null,
      formatCounts: { wildfly: 2 },
      embedding: { state: "keyword_only", modelId: null },
      confidence: {
        corpusTimeQuality: "order_only",
        counts: {
          wall: 0,
          orderOnly: 120,
          mixed: 0,
          matched: 2,
          ambiguous: 0,
          unknown: 0,
          unresolved: 120,
        },
        sources: [
          {
            source: "/sensitive/tenant-a/runtime.log",
            lines: 120,
            formatId: "wildfly",
            outcome: "matched",
            timeQuality: "order_only",
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
});

describe("corpus import activity bridge", () => {
  it("persists and broadcasts only bounded projected metadata", async () => {
    const custom = vi.fn();
    const emit = vi.fn(async () => undefined);
    window.addEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    await publishImportRunActivity(completedRun(), emit);
    window.removeEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);

    const loaded = loadCorpusImportActivity("corpus-a");
    expect(loaded.length).toBeGreaterThan(3);
    expect(loaded.every((event) => event.corpusId === "corpus-a")).toBe(true);
    expect(loaded.some((event) => event.label === "Corpus published")).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain("/sensitive/tenant-a");
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-a"),
    ).not.toContain("runtime.log");

    expect(custom).toHaveBeenCalledOnce();
    const payload = (custom.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(emit).toHaveBeenCalledWith(IMPORT_ACTIVITY_CHANGED_EVENT, payload);
  });

  it("does not persist or announce failed/cancelled attempts without a corpus", async () => {
    const custom = vi.fn();
    window.addEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    await publishImportRunActivity({
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "failed",
      sourceKind: "file",
    });
    window.removeEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    expect(custom).not.toHaveBeenCalled();
    expect(loadCorpusImportActivity("corpus-a")).toEqual([]);
  });

  it("delivers one matching safe payload once across same-window and Tauri", async () => {
    const received = vi.fn();
    let tauriHandler:
      | ((event: {
          payload: {
            corpusId?: unknown;
            eventId?: unknown;
            events?: unknown;
          };
        }) => void)
      | undefined;
    const unsubscribe = subscribeImportRunActivity(
      received,
      async (_name, handler) => {
        tauriHandler = handler;
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    await publishImportRunActivity(completedRun(), async (_name, payload) => {
      tauriHandler?.({ payload });
    });
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(
      "corpus-a",
      expect.arrayContaining([
        expect.objectContaining({ label: "Corpus published" }),
      ]),
    );
    unsubscribe();
  });

  it("rejects malformed or cross-corpus stored activity", () => {
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-b",
      JSON.stringify({
        version: 1,
        events: [
          {
            ...completedRun("corpus-a"),
            label: "forged",
          },
        ],
      }),
    );
    expect(loadCorpusImportActivity("corpus-b")).toEqual([]);
  });
});
