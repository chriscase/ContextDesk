import { describe, expect, it } from "vitest";
import { defaultMockPreview, mockPlanToken } from "@contextdesk/client";
import {
  INITIAL_IMPORT_FLOW_STATE,
  containerPrefixes,
  containerState,
  importDisabledReason,
  importFlowReducer,
  preselectedIdentities,
  selectedForRun,
  selectedImportableCount,
  selectorRows,
  timezoneGroups,
  type ImportFlowState,
} from "./importFlowState";
import type { ImportRunReport } from "@contextdesk/client";

function planOf(report = defaultMockPreview()) {
  return { report, planToken: mockPlanToken(report), planVersion: 1 };
}

function previewedState(): ImportFlowState {
  const afterPath = importFlowReducer(INITIAL_IMPORT_FLOW_STATE, {
    type: "PATH_CHOSEN",
    path: "/incidents",
  });
  return importFlowReducer(afterPath, { type: "PREVIEW_OK", plan: planOf() });
}

describe("importFlowReducer flow-through", () => {
  it("lands on preflight when the preview preselects importable sources", () => {
    const state = previewedState();
    expect(state.stage).toBe("preflight");
    expect(selectedImportableCount(state)).toBe(4);
    expect(importDisabledReason(state)).toBeNull();
  });

  it("forces the selector when nothing importable is preselected", () => {
    const report = defaultMockPreview();
    for (const item of report.items) item.selected = false;
    const afterPath = importFlowReducer(INITIAL_IMPORT_FLOW_STATE, {
      type: "PATH_CHOSEN",
      path: "/incidents",
    });
    const state = importFlowReducer(afterPath, { type: "PREVIEW_OK", plan: planOf(report) });
    expect(state.stage).toBe("selector");
    expect(importDisabledReason(state)).toBe(
      "Nothing selected would import as log events. Select at least one log source.",
    );
  });

  it("refuses RUN_STARTED while zero importable sources are selected", () => {
    const state = previewedState();
    const emptied = importFlowReducer(state, {
      type: "SET_ALL_VISIBLE",
      identities: state.report!.items.map((item) => item.identity),
      selected: false,
    });
    const attempted = importFlowReducer(emptied, { type: "RUN_STARTED" });
    expect(attempted.stage).toBe("preflight");
  });
});

describe("selection model", () => {
  it("preselection follows the trusted preview exactly", () => {
    const report = defaultMockPreview();
    const selected = preselectedIdentities(report);
    expect(selected.has("api/api-gateway.log")).toBe(true);
    expect(selected.has("support.zip!/host-a.zip!/logs/app.log")).toBe(true);
    expect(selected.has("support.zip!/host-a.zip!/inner.zip!/deep.log")).toBe(false);
  });

  it("selectedForRun is an exact event-importable allowlist", () => {
    const state = previewedState();
    const selected = selectedForRun(state);
    // Every importable log-role row is preselected — never supporting,
    // blocked, or unreviewed tail.
    expect(selected).toEqual([
      "api/api-gateway.log",
      "api/payments.jsonl",
      "support.zip!/host-a.zip!/logs/app.log",
      "logs/console-fallback.log",
    ]);
    // Even a forced selection of a supporting row never reaches the wire.
    const forced = {
      ...state,
      selected: new Set([...state.selected, "metrics/gateway-metrics.json"]),
    };
    expect(selectedForRun(forced)).not.toContain("metrics/gateway-metrics.json");
  });

  it("blocked leaves are never selectable, even via container or set-all", () => {
    const state = previewedState();
    const blocked = "support.zip!/host-a.zip!/inner.zip!/deep.log";
    const direct = importFlowReducer(state, { type: "TOGGLE_LEAF", identity: blocked });
    expect(direct.selected.has(blocked)).toBe(false);
    const viaAll = importFlowReducer(state, {
      type: "SET_ALL_VISIBLE",
      identities: [blocked],
      selected: true,
    });
    expect(viaAll.selected.has(blocked)).toBe(false);
    const viaContainer = importFlowReducer(state, {
      type: "TOGGLE_CONTAINER",
      prefix: "support.zip!/",
    });
    expect(viaContainer.selected.has(blocked)).toBe(false);
  });

  it("shift-range paints leaf rows only, with the anchor's value", () => {
    const state = previewedState();
    const visibleLeaves = state.report!.items.map((item) => item.identity);
    // Anchor on a selected row, then extend across the preselected review row.
    const anchored = importFlowReducer(state, {
      type: "TOGGLE_LEAF",
      identity: "api/payments.jsonl",
    });
    // payments now OFF; re-toggle to anchor it ON.
    const reAnchored = importFlowReducer(anchored, {
      type: "TOGGLE_LEAF",
      identity: "api/payments.jsonl",
    });
    const ranged = importFlowReducer(reAnchored, {
      type: "RANGE_TO_LEAF",
      identity: "logs/console-fallback.log",
      visibleLeaves,
    });
    // Everything between payments and notes (selectable) becomes selected.
    expect(ranged.selected.has("support.zip!/host-a.zip!/logs/app.log")).toBe(true);
    expect(ranged.selected.has("logs/console-fallback.log")).toBe(true);
    // The blocked row inside the range stays unselected.
    expect(ranged.selected.has("support.zip!/host-a.zip!/inner.zip!/deep.log")).toBe(false);
  });

  it("container toggle flips all selectable descendants and derives tri-state", () => {
    const state = previewedState();
    const report = state.report!;
    const apiLeaves = ["api/api-gateway.log", "api/payments.jsonl"];
    expect(containerState(apiLeaves, report, state.selected)).toBe("checked");
    const off = importFlowReducer(state, { type: "TOGGLE_CONTAINER", prefix: "api/" });
    expect(containerState(apiLeaves, report, off.selected)).toBe("unchecked");
    const one = importFlowReducer(off, {
      type: "TOGGLE_LEAF",
      identity: "api/api-gateway.log",
    });
    expect(containerState(apiLeaves, report, one.selected)).toBe("mixed");
  });
});

describe("selector rows", () => {
  it("emits container rows for directories and archive chains", () => {
    const report = defaultMockPreview();
    const rows = selectorRows(report, {
      collapsed: new Set(),
      statusFilter: null,
      query: "",
    });
    const containers = rows
      .filter((row) => row.kind === "container")
      .map((row) => (row as { prefix: string }).prefix);
    expect(containers).toContain("api/");
    expect(containers).toContain("support.zip!/");
    expect(containers).toContain("support.zip!/host-a.zip!/");
  });

  it("collapsing a container hides its members but keeps the container", () => {
    const report = defaultMockPreview();
    const rows = selectorRows(report, {
      collapsed: new Set(["support.zip!/"]),
      statusFilter: null,
      query: "",
    });
    const identities = rows
      .filter((row) => row.kind === "leaf")
      .map((row) => (row as { item: { identity: string } }).item.identity);
    expect(identities).not.toContain("support.zip!/host-a.zip!/logs/app.log");
    expect(identities).toContain("api/api-gateway.log");
  });

  it("filters never mutate selection", () => {
    const state = previewedState();
    const filtered = selectorRows(state.report!, {
      collapsed: new Set(),
      statusFilter: new Set(["blocked"]),
      query: "",
    });
    expect(filtered.filter((row) => row.kind === "leaf")).toHaveLength(1);
    // The state object is untouched by row derivation.
    expect(state.selected.has("api/api-gateway.log")).toBe(true);
  });

  it("containerPrefixes walks directories and archive boundaries", () => {
    expect(containerPrefixes("support.zip!/host-a.zip!/logs/app.log")).toEqual([
      "support.zip!/",
      "support.zip!/host-a.zip!/",
      "support.zip!/host-a.zip!/logs/",
    ]);
    expect(containerPrefixes("plain.log")).toEqual([]);
  });
});

describe("run lifecycle", () => {
  it("cancel and failure return to a retryable stage without losing review", () => {
    let state = previewedState();
    const selectedBefore = state.selected;
    state = importFlowReducer(state, { type: "RUN_STARTED" });
    expect(state.stage).toBe("running");
    state = importFlowReducer(state, { type: "RUN_FAILED", message: "disk full" });
    expect(state.stage).toBe("run_failed");
    state = importFlowReducer(state, { type: "RETRY" });
    expect(state.stage).toBe("preflight");
    expect(state.selected).toBe(selectedBefore);
  });
});

describe("timezone groups", () => {
  it("ignores time-less order-only sources whose empty wire arrays are omitted", () => {
    const report: ImportRunReport = {
      corpusId: "c",
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
            // Rust omits both empty vectors from the camelCase JSON wire.
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
    };

    expect(timezoneGroups(report)).toEqual([
      {
        key: "wildfly·no_timezone",
        label: "wildfly · no timezone",
        sources: ["local-calendar.log"],
        records: 5,
      },
    ]);
  });

  it("groups unresolved sources deterministically by format and reason", () => {
    const report: ImportRunReport = {
      corpusId: "c",
      lines: 0,
      templates: 0,
      reductionRatio: 0,
      embedded: 0,
      files: 0,
      discoveredFiles: 0,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: false,
      sourceBytes: 0,
      corpusBytes: 0,
      tsMin: null,
      tsMax: null,
      formatCounts: {},
      confidence: {
        corpusTimeQuality: "order_only",
        counts: {
          wall: 0,
          orderOnly: 3,
          mixed: 0,
          matched: 3,
          ambiguous: 0,
          unknown: 0,
          unresolved: 3,
        },
        sources: [
          {
            source: "b.log",
            lines: 10,
            formatId: "wildfly",
            outcome: "matched",
            timeQuality: "order_only",
            unresolvedReasons: ["no_timezone"],
            timestampPrefixSamples: [],
          },
          {
            source: "a.log",
            lines: 20,
            formatId: "wildfly",
            outcome: "matched",
            timeQuality: "order_only",
            unresolvedReasons: ["no_timezone"],
            timestampPrefixSamples: [],
          },
          {
            source: "c.log",
            lines: 5,
            formatId: "classic-syslog-record",
            outcome: "matched",
            timeQuality: "order_only",
            unresolvedReasons: ["zone_abbreviation_not_resolved"],
            timestampPrefixSamples: [],
          },
        ],
      },
    };
    const groups = timezoneGroups(report);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).toBe("classic-syslog-record · zone abbreviation not resolved");
    expect(groups[1]!.sources).toEqual(["b.log", "a.log"]);
    expect(groups[1]!.records).toBe(30);
  });
});
