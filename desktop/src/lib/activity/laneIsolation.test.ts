/**
 * Requirement 2, and the "no fixture theater" rule, as enforceable checks.
 *
 * Both are properties of the whole tree rather than of one function, so they
 * are tested by reading the source the same way the boundary ratchet does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appendActivities, createActivityLog } from "./activityLog";
import {
  beginImportActivityAttempt,
  recordImportProgress,
  settleImportActivityAttempt,
} from "./importProgressActivity";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  isNondeterministicOrigin,
  ACTIVITY_ORIGINS,
  type ImportRunInput,
} from "./types";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadSrcFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.set(
          relative(DESKTOP_ROOT, full).split(sep).join("/"),
          readFileSync(full, "utf8"),
        );
      }
    }
  };
  walk(join(DESKTOP_ROOT, "src"));
  return files;
}

const isTestFile = (path: string) =>
  /\.(test|stories)\.tsx?$/.test(path) || path.includes("/__tests__/");

/**
 * Strip comments before scanning. A doc comment explaining that fixtures were
 * REMOVED must not read as a fixture leak — the check is about code.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const IMPORT_RUN: ImportRunInput = {
  startedAtMs: 1_000,
  endedAtMs: 5_000,
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
    excludedFiles: 1,
    failedFiles: 0,
    ignoredFiles: 1,
    exclusionCounts: { binary: 1 },
    exclusionExamples: ["a.bin"],
    partial: false,
    sourceBytes: 1_000,
    corpusBytes: 500,
    tsMin: 1,
    tsMax: 2,
    formatCounts: { syslog: 12 },
    embedding: { state: "complete", modelId: "local-embed" },
    confidence: {
      corpusTimeQuality: "wall",
      counts: {
        wall: 12,
        orderOnly: 0,
        mixed: 0,
        matched: 12,
        ambiguous: 0,
        unknown: 0,
        unresolved: 0,
      },
      sources: [],
    },
  },
};

function importActivities(run: ImportRunInput) {
  let attempt = beginImportActivityAttempt("import:lane-isolation", run.sourceKind);
  for (const [phase, elapsed] of [
    ["starting", 0],
    ["scan", 10],
    ["stream", 20],
    ["embed", 30],
    ["validate", 40],
    ["publish", 50],
    [run.outcome === "completed" ? "completed" : run.outcome, 60],
  ] as const) {
    attempt = recordImportProgress(attempt, {
      kind: "log_ingest",
      phase,
      message: "deliberately ignored",
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: null,
      templates: null,
      cancellable: phase !== "publish",
      elapsed_ms: elapsed,
      phase_elapsed_ms: null,
    });
  }
  return settleImportActivityAttempt(attempt, run).events;
}

describe("customer evidence and ContextDesk activity are separate groups", () => {
  it("stamps EVERY activity entry with the ContextDesk lane group", () => {
    const log = appendActivities(
      createActivityLog(),
      importActivities(IMPORT_RUN),
    );
    expect(log.entries.length).toBeGreaterThan(0);
    for (const entry of log.entries) {
      expect(entry.laneGroup).toBe(ACTIVITY_LANE_GROUP);
    }
  });

  it("has no constructor that can put activity in the customer group", () => {
    // The guarantee is structural: `ACTIVITY_LANE_GROUP` is a const, and
    // `laneGroup` is typed as that literal, so there is no other value to
    // assign. Assert the constant so a widening of the type fails here.
    expect(ACTIVITY_LANE_GROUP).toBe("contextdesk");
  });

  it("keeps activity out of the customer corpus, facets, search, and citations", () => {
    // A ContextDesk event carries no field any customer-evidence surface
    // reads: those are ExplorerEventDtos keyed by event id / source / lane.
    const [entry] = appendActivities(
      createActivityLog(),
      importActivities(IMPORT_RUN),
    ).entries;
    for (const forbidden of [
      "eventId",
      "sourceId",
      "lane",
      "laneId",
      "message",
      "templateId",
      "suppressed",
    ]) {
      expect(entry).not.toHaveProperty(forbidden);
    }
  });

  it("scopes an import to its corpus WITHOUT joining that corpus's events", () => {
    const entries = importActivities(IMPORT_RUN);
    // corpusId is a scope label so the reader knows what the work concerned.
    expect(entries.every((e) => e.corpusId === "corpus-1")).toBe(true);
    // One correlation id per attempt: selecting it highlights the import
    // chain across ContextDesk lanes only.
    expect(new Set(entries.map((e) => e.correlationId)).size).toBe(1);
  });

  it("no production module outside lib/activity constructs a lane group", () => {
    const offenders = [...loadSrcFiles()]
      .filter(([path]) => !isTestFile(path))
      .filter(([path]) => !path.startsWith("src/lib/activity/"))
      .filter(([, source]) => /laneGroup\s*:\s*["'`]/.test(codeOnly(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("fixtures never reach production", () => {
  it("no production file imports the activity fixtures module", () => {
    const offenders = [...loadSrcFiles()]
      .filter(([path]) => !isTestFile(path))
      .filter(([, source]) =>
        /from\s+["'][^"']*activity\/fixtures["']/.test(codeOnly(source)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("no activity module carries a live-vs-fixture provenance field", () => {
    // The earlier draft tagged every value `source: "live" | "fixture"` and
    // rendered "(placeholder)" beside invented numbers in production.
    const offenders = [...loadSrcFiles()]
      .filter(([path]) => path.startsWith("src/lib/activity/"))
      .filter(([path]) => !isTestFile(path))
      .filter(([, source]) => /["']fixture["']/.test(codeOnly(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("deterministic and model work are distinguishable", () => {
  it("classifies a heuristic as repeatable but NEVER deterministic", () => {
    expect(determinismForOrigin("repeatable_heuristic")).toBe("repeatable");
    expect(determinismForOrigin("repeatable_heuristic")).not.toBe(
      "deterministic",
    );
    // ...and it belongs to the deterministic HALF of the coarse split, which
    // is a weaker, separate claim than being a proof.
    expect(isNondeterministicOrigin("repeatable_heuristic")).toBe(false);
  });

  it("puts model and external work on the nondeterministic side, alone", () => {
    const nondeterministic = ACTIVITY_ORIGINS.filter(isNondeterministicOrigin);
    expect([...nondeterministic].sort()).toEqual([
      "external_connector",
      "probabilistic_model",
    ]);
  });

  it("labels the import pipeline's fixed stages as deterministic host work", () => {
    const entries = importActivities(IMPORT_RUN);
    for (const label of [
      "Discovering and reading sources",
      "Reading, parsing, normalizing, and indexing",
      "Validating staged corpus",
    ]) {
      const step = entries.find((e) => e.label.startsWith(label))!;
      expect(step, label).toBeDefined();
      expect(step.origin, label).toBe("deterministic_host");
      expect(isNondeterministicOrigin(step.origin), label).toBe(false);
    }
  });

  it("records the confirmed import start as a human decision", () => {
    const start = importActivities(IMPORT_RUN).find(
      (event) => event.label === "Import started",
    )!;
    expect(start.origin).toBe("user_decision");
    expect(start.determinism).toBe("human");
  });

  it("labels the optional embedding phase as model work, with disclosure", () => {
    const embed = importActivities(IMPORT_RUN).find((e) =>
      e.label.startsWith("Running optional local embedding"),
    )!;
    expect(embed.origin).toBe("probabilistic_model");
    expect(isNondeterministicOrigin(embed.origin)).toBe(true);
    // The union makes this mandatory — a model event cannot be built without it.
    expect(embed.hook).toEqual({
      trigger: "import → optional local embedding phase",
      dataScope: "learned templates of the selected import only",
    });
  });

  it("records publication as a governed write and cancellation as cancelled", () => {
    const published = importActivities(IMPORT_RUN).at(-1)!;
    expect(published.origin).toBe("governed_write");
    expect(published.status).toBe("ok");

    const cancelled = importActivities({
      ...IMPORT_RUN,
      outcome: "cancelled",
      report: null,
    }).at(-1)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.label).toMatch(/nothing published/i);
  });

  it("uses host elapsed clocks rather than invented calendar timestamps", () => {
    for (const entry of importActivities(IMPORT_RUN)) {
      expect(entry.clock.kind).toBe("elapsed");
    }
  });
});
