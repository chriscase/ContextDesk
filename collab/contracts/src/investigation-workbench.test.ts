import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  TIMESTAMP_SHAPE_PARSER_ID,
  WORKBENCH_LIMITS,
  classifyTimestampShape,
  applyHostTimestamps,
  extractShapeCandidates,
  mergeChronology,
  pageLogLines,
  parseWorkbenchBookmark,
  parseWorkbenchChronology,
  parseWorkbenchReviewRule,
  parseWorkbenchSearchRequest,
  parseWorkbenchSearchResult,
  parseWorkbenchShareSafeLocator,
  parseWorkbenchTimestampCandidate,
  parseWorkbenchView,
  previewReviewRule,
  privacySafeNotFound,
  resolveLocatorAgainstEvidence,
  rotationFamilyOf,
  searchLogLines,
  splitLogText,
  virtualizedWindow,
  workbenchShareSafeToken,
  type WorkbenchLine,
  type WorkbenchSearchRequestV1,
} from "./investigation-workbench.js";

const Ajv2020 = (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(here, "..", dir, name), "utf8")) as unknown;

function validator(schemaName: string) {
  const AjvCtor = Ajv2020 as unknown as new (opts: object) => {
    compile: (schema: object) => (data: unknown) => boolean;
  };
  const ajv = new AjvCtor({ strict: true, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  return ajv.compile(load("schemas", schemaName) as object);
}

const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_B = "55555555-5555-4555-8555-555555555555";
const DIGEST = "a".repeat(64);

function emptyFilters(): WorkbenchSearchRequestV1["filters"] {
  return {
    includeTerms: [],
    excludeTerms: [],
    severity: null,
    component: null,
    file: null,
    rotationFamily: null,
    timeFrom: null,
    timeTo: null,
    evidenceIds: [],
  };
}

function searchRequest(
  overrides: Partial<WorkbenchSearchRequestV1> = {},
): WorkbenchSearchRequestV1 {
  return {
    schemaId: "cd-collab.log_workbench_search_request.v1",
    query: "timeout",
    mode: "case_insensitive",
    filters: emptyFilters(),
    contextBefore: 1,
    contextAfter: 1,
    cursor: 0,
    limit: 50,
    expectedNormalizationRevision: 3,
    ...overrides,
  };
}

describe("workbench search contract", () => {
  it("accepts the synthetic fixture through both the parser and the JSON Schema", () => {
    const fixture = load("fixtures", "log-workbench-search-request.valid.json");
    expect(parseWorkbenchSearchRequest(fixture).query).toBe("upstream timeout");
    expect(validator("log-workbench-search-request.v1.json")(fixture)).toBe(true);
  });

  it("rejects an unknown field rather than silently ignoring a guessed zone", () => {
    const drifted = load("fixtures", "log-workbench-search-request.unknown-field.json");
    expect(() => parseWorkbenchSearchRequest(drifted)).toThrow(/unknown key/);
    expect(validator("log-workbench-search-request.v1.json")(drifted)).toBe(false);
  });

  it("refuses nested-quantifier regex instead of running it", () => {
    expect(() =>
      parseWorkbenchSearchRequest(
        searchRequest({ query: "(a+)+", mode: "regex" }),
      ),
    ).toThrow(/safely bounded/);
  });
});

describe("workbench saved view contract", () => {
  it("accepts a two-pane view and rejects a grant sidecar", () => {
    const valid = load("fixtures", "log-workbench-view.valid.json");
    const view = parseWorkbenchView(valid);
    expect(view.selectedPanes).toHaveLength(2);
    expect(view.name).toBe("Timeout window, two panes");
    expect(validator("log-workbench-view.v1.json")(valid)).toBe(true);
    const drifted = load("fixtures", "log-workbench-view.unknown-field.json");
    expect(() => parseWorkbenchView(drifted)).toThrow(/unknown key/);
    expect(validator("log-workbench-view.v1.json")(drifted)).toBe(false);
  });

  it("refuses a view with zero panes or a bare timezone abbreviation", () => {
    const raw = load("fixtures", "log-workbench-view.valid.json") as Record<string, unknown>;
    raw.selectedPanes = [];
    expect(() => parseWorkbenchView(raw)).toThrow(/1 and 4 panes/);
    const zone = load("fixtures", "log-workbench-view.valid.json") as Record<string, unknown>;
    (zone.display as Record<string, unknown>).displayTimezone = "CST";
    expect(() => parseWorkbenchView(zone)).toThrow(/Bare abbreviations/);
  });
});

describe("workbench bookmarks and locators", () => {
  it("accepts a bookmark whose share-safe token matches the bound locator", () => {
    const fixture = load("fixtures", "log-workbench-bookmark.valid.json");
    const bookmark = parseWorkbenchBookmark(fixture);
    expect(bookmark.shareSafeToken).toBe(
      workbenchShareSafeToken(bookmark.investigationId, bookmark.locator),
    );
    expect(validator("log-workbench-bookmark.v1.json")(fixture)).toBe(true);
  });

  it("explains a digest mismatch instead of silently retargeting the line", () => {
    const bookmark = parseWorkbenchBookmark(
      load("fixtures", "log-workbench-bookmark.valid.json"),
    );
    const stale = resolveLocatorAgainstEvidence(bookmark.locator, {
      digest: "b".repeat(64),
      lineNumber: 3,
      byteOffset: 12,
      lineCount: 10,
    });
    expect(stale.status).toBe("stale");
    expect(stale.staleReason).toMatch(/was not moved/);
  });

  it("privacy-safe not-found discloses neither path nor investigation", () => {
    const missing = parseWorkbenchShareSafeLocator({
      schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
      token: "c".repeat(64),
    });
    expect(missing.token).toHaveLength(64);
    const denied = privacySafeNotFound();
    expect(denied.relativePath).toBeNull();
    expect(denied.investigationId).toBeNull();
    expect(denied.found).toBe(false);
  });
});

describe("timestamp shape classifier", () => {
  it("never guesses a zone for a local wall clock", () => {
    const shape = classifyTimestampShape("2024-03-10 02:30:00 WARN heartbeat late");
    expect(shape.parseClass).toBe("local_ambiguous");
    expect(shape.explicitOffset).toBeNull();
    expect(shape.unknownReason).toBe("ambiguous_timezone");
  });

  it("keeps an explicit offset as parser-proven rather than a declaration", () => {
    const shape = classifyTimestampShape("2024-03-10T07:30:00Z INFO edge accepted");
    expect(shape.parseClass).toBe("explicit_offset");
    expect(shape.explicitOffset).toBe("Z");
  });

  it("accepts the candidate fixture and refuses an offset on an ambiguous local", () => {
    const fixture = load("fixtures", "log-time-candidate.valid.json");
    const candidate = parseWorkbenchTimestampCandidate(fixture);
    expect(candidate.parserId).toBe(TIMESTAMP_SHAPE_PARSER_ID);
    expect(validator("log-time-candidate.v1.json")(fixture)).toBe(true);
    const smuggled = {
      ...(fixture as Record<string, unknown>),
      explicitOffset: "-06:00",
    };
    expect(() => parseWorkbenchTimestampCandidate(smuggled)).toThrow(/must not smuggle/);
  });
});

describe("review rule preview", () => {
  it("lists exactly the rotation-family items a rule would affect", () => {
    const rule = parseWorkbenchReviewRule(
      load("fixtures", "log-time-review-rule.valid.json"),
    );
    expect(validator("log-time-review-rule.v1.json")(load("fixtures", "log-time-review-rule.valid.json"))).toBe(true);
    const preview = previewReviewRule(rule, [
      {
        evidenceId: EVIDENCE_A,
        relativePath: "worker/batch.log",
        rotationFamily: "worker/batch.log",
        parseClass: "local_ambiguous",
      },
      {
        evidenceId: EVIDENCE_B,
        relativePath: "worker/batch.log.1",
        rotationFamily: "worker/batch.log",
        parseClass: "local_ambiguous",
      },
      {
        evidenceId: "77777777-7777-4777-8777-777777777777",
        relativePath: "gateway/edge.log",
        rotationFamily: "gateway/edge.log",
        parseClass: "explicit_offset",
      },
    ]);
    expect(preview.affectedEvidenceIds).toEqual([EVIDENCE_A, EVIDENCE_B]);
    expect(preview.affectedRelativePaths).not.toContain("gateway/edge.log");
    expect(preview.notes.some((note) => note.includes("will not be applied to the rest"))).toBe(
      true,
    );
  });

  it("refuses a source-scoped rule that names no source", () => {
    const raw = load("fixtures", "log-time-review-rule.valid.json") as Record<string, unknown>;
    raw.scope = "source";
    raw.rotationFamily = null;
    expect(() => parseWorkbenchReviewRule(raw)).toThrow(/must name the source/);
  });
});

describe("bounded search over synthetic lines", () => {
  const text = [
    "2024-03-10T07:30:00Z INFO  edge accepted request rid-0001",
    "2024-03-10T07:45:00Z INFO  edge accepted request rid-0002",
    "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
    '<script>alert("xss")</script> filename looks like html.log',
  ].join("\n");
  const lines = splitLogText(EVIDENCE_A, "gateway/edge.log", DIGEST, text, null);

  it("returns the timeout line with honest bounded counts", () => {
    const result = parseWorkbenchSearchResult(
      searchLogLines(lines, searchRequest({ query: "timeout" })),
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toContain("upstream timeout");
    expect(result.matches[0]?.text).not.toContain("<");
    expect(result.bounded).toBe(false);
    expect(result.atLeast).toBe(1);
  });

  it("keeps HTML-looking payload as inert text", () => {
    const result = searchLogLines(lines, searchRequest({ query: "<script>", mode: "literal" }));
    expect(result.matches[0]?.text).toContain("<script>alert");
  });

  it("reports at least N when the match cap is hit", () => {
    const many: WorkbenchLine[] = Array.from({ length: 40 }, (_, index) => ({
      ...lines[2]!,
      lineNumber: index + 1,
      byteOffset: index * 20,
    }));
    const result = searchLogLines(many, searchRequest({ query: "timeout", limit: 5 }));
    expect(result.returned).toBe(5);
    expect(result.bounded).toBe(true);
    expect(result.atLeast).toBe(40);
    expect(result.nextCursor).toBe(5);
  });

  it("does not invent a zone to satisfy a time range", () => {
    const local = splitLogText(
      EVIDENCE_A,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 02:30:00 WARN heartbeat late\n",
      null,
    );
    const result = searchLogLines(
      local,
      searchRequest({
        query: "heartbeat",
        filters: {
          ...emptyFilters(),
          timeFrom: "2024-03-10T07:00:00.000Z",
          timeTo: "2024-03-10T09:00:00.000Z",
        },
      }),
    );
    expect(result.matches).toHaveLength(0);
    expect(result.timeFilterUnknownReason).toMatch(/normalized timestamp/);
  });

  it("stops when cancelled rather than draining the rest of the corpus", () => {
    let calls = 0;
    const result = searchLogLines(lines, searchRequest({ query: "edge" }), {
      cancelled: () => {
        calls += 1;
        return calls > 1;
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.bounded).toBe(true);
  });
});

describe("virtualized window", () => {
  it("keeps resident rows bounded on a 100k-line fixture", () => {
    const window = virtualizedWindow({
      totalRows: 100_000,
      scrollTop: 48_000,
      rowHeight: 24,
      viewportHeight: 480,
      overscan: 8,
    });
    expect(window.resident).toBeLessThanOrEqual(40);
    expect(window.end - window.start).toBe(window.resident);
  });
});

describe("rotation family and paging", () => {
  it("groups rotated generation files without collapsing distinct identities", () => {
    expect(rotationFamilyOf("worker/batch.log.1")).toBe("worker/batch.log");
    expect(rotationFamilyOf("worker/batch.log-2026-08-25")).toBe("worker/batch.log");
    expect(rotationFamilyOf("gateway/edge.log")).toBe("gateway/edge.log");
  });

  it("pages without mounting the rest of the file", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "worker/batch.log",
      DIGEST,
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
      null,
    );
    const page = pageLogLines(lines, EVIDENCE_A, 10, 5);
    expect(page.rows).toHaveLength(5);
    expect(page.rows[0]?.lineNumber).toBe(10);
    expect(page.nextStartLine).toBe(15);
    expect(page.bounded).toBe(true);
  });
});

describe("chronology", () => {
  it("accepts the fixture and refuses heuristic ground-truth wording", () => {
    const fixture = load("fixtures", "log-workbench-chronology.valid.json");
    expect(parseWorkbenchChronology(fixture).events[0]?.correlationKind).toBe(
      "observed_identifier",
    );
    expect(validator("log-workbench-chronology.v1.json")(fixture)).toBe(true);
    const drifted = structuredClone(fixture) as {
      events: { adjacencyReason: string; correlationKind: string }[];
    };
    drifted.events[0]!.correlationKind = "heuristic_similarity";
    drifted.events[0]!.adjacencyReason = "These look similar so they are ground truth.";
    expect(() => parseWorkbenchChronology(drifted)).toThrow(/cannot claim ground truth/);
  });

  it("clusters events by the requested grouping key", () => {
    const edge = splitLogText(
      EVIDENCE_A,
      "gateway/edge.log",
      DIGEST,
      [
        "2024-03-10T07:30:00Z INFO edge accepted request rid-0001",
        "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
      ].join("\n"),
      "batch-a",
    );
    const worker = splitLogText(
      EVIDENCE_B,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 01:30:00 INFO sweep",
      "batch-b",
    );
    const byFile = mergeChronology([...worker, ...edge], "file", 1);
    expect(byFile.events.map((event) => event.groupKey)).toEqual([
      "gateway/edge.log",
      "gateway/edge.log",
      "worker/batch.log",
    ]);
    expect(byFile.events[1]?.adjacencyReason).toMatch(/file group \(gateway\/edge\.log\)/);
    const byEntity = mergeChronology([...worker, ...edge], "entity", 1);
    expect(byEntity.events.map((event) => event.groupKey).sort()).toEqual([
      "0001",
      "0003",
      "no-observed-id",
    ]);
    const byComponent = mergeChronology([...worker, ...edge], "component", 1);
    expect(new Set(byComponent.events.map((event) => event.groupKey))).toEqual(
      new Set(["edge.log", "batch.log"]),
    );
    const pinned = mergeChronology(edge, "none", 1, new Map([
      [`${EVIDENCE_A}:1`, "pinned"],
    ]));
    expect(pinned.events[0]?.anchorStatus).toBe("pinned");
    const ground = mergeChronology(edge, "none", 1, new Map([
      [`${EVIDENCE_A}:1`, "human_ground_truth"],
    ]));
    expect(ground.events[0]?.anchorStatus).toBe("human_ground_truth");
  });

  it("takes wall-clock UTC from the host corpus, not Date.parse on local text", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 01:30:00 INFO sweep\n",
      null,
    );
    expect(lines[0]?.normalizedUtc).toBeNull();
    const overlaid = applyHostTimestamps(lines, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "2024-03-10 01:30:00",
      },
    ]);
    expect(overlaid[0]?.normalizedUtc).toBe(new Date(1_710_045_000 * 1000).toISOString());
    const orderOnly = applyHostTimestamps(lines, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 3,
        timeQuality: "order only (not calendar time)",
        unresolvedLocalTimestamp: "2024-03-10 01:30:00",
      },
    ]);
    expect(orderOnly[0]?.normalizedUtc).toBeNull();
    const redacted = applyHostTimestamps(lines, [
      {
        source: "worker/batch.log",
        message: "sweep <*>",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "2024-03-10 01:30:00",
      },
    ]);
    expect(redacted[0]?.normalizedUtc).toBe(new Date(1_710_045_000 * 1000).toISOString());
  });

  it("marks files with no usable timestamps instead of inventing a clock", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "notes/chat.txt",
      DIGEST,
      "operator: the checkout lane stalled\n",
      null,
    );
    const chronology = mergeChronology(lines, "file", null);
    expect(chronology.unknownBuckets[0]?.category).toBe("timestamps");
    expect(chronology.events[0]?.uncertainty).toContain("no usable timestamp");
  });

  it("extracts shape candidates with parser identity and no guessed zone", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 01:30:00 INFO sweep\n",
      null,
    );
    const candidates = extractShapeCandidates(lines);
    expect(candidates[0]?.parserId).toBe(TIMESTAMP_SHAPE_PARSER_ID);
    expect(candidates[0]?.parseClass).toBe("local_ambiguous");
    expect(candidates[0]?.explicitOffset).toBeNull();
  });

  it("does not re-queue a local timestamp after the host resolves it", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 01:30:00 INFO sweep\n",
      null,
    );
    const resolved = applyHostTimestamps(lines, [
      {
        source: "worker/batch.log",
        message: "sweep",
        ts: 1_710_045_000,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: "2024-03-10 01:30:00",
      },
    ]);
    expect(resolved[0]?.normalizedUtc).toBeTruthy();
    expect(extractShapeCandidates(resolved)).toEqual([]);
    expect(mergeChronology(resolved, "file", 3).unknownBuckets).toEqual([]);
    expect(mergeChronology(resolved, "file", 3).events[0]?.uncertainty).toEqual([]);
  });
});

describe("workbench limits", () => {
  it("pins the resource bounds the server and host must share", () => {
    expect(WORKBENCH_LIMITS.maxPageRows).toBe(200);
    expect(WORKBENCH_LIMITS.maxReturnedMatches).toBe(200);
    expect(WORKBENCH_LIMITS.maxSearchWorkLines).toBe(50_000);
    expect(WORKBENCH_LIMITS.maxRegexChars).toBe(256);
    expect(WORKBENCH_LIMITS.maxPanes).toBe(4);
  });
});

/**
 * Regressions for the honesty defects found in triage review: a partial answer
 * must never read as a complete one, and a time bound is refused rather than
 * compared as text.
 */
describe("bounded answers stay honest", () => {
  const utc = (line: number) =>
    `2024-03-10T0${line}:00:00Z INFO edge request rid-000${line}`;
  const three = splitLogText(
    EVIDENCE_A,
    "gateway/edge.log",
    DIGEST,
    `${utc(1)}\n${utc(2)}\n${utc(3)}\n`,
    null,
  );

  it("does not add a phantom row for the newline that ends a file", () => {
    expect(three).toHaveLength(3);
    expect(three.every((line) => line.text.trim().length > 0)).toBe(true);
    // A file with a genuinely blank last line still keeps it.
    expect(
      splitLogText(EVIDENCE_A, "gateway/edge.log", DIGEST, "one\n\n", null),
    ).toHaveLength(2);
  });

  it("reports a corpus the host could not read to the end as bounded", () => {
    const result = searchLogLines(three, searchRequest({ query: "edge" }), {
      corpusTruncated: true,
    });
    expect(result.corpusTruncated).toBe(true);
    expect(result.bounded).toBe(true);
  });

  it("refuses a result that claims a partial corpus was a complete answer", () => {
    expect(() =>
      parseWorkbenchSearchResult({
        schemaId: "cd-collab.log_workbench_search_result.v1",
        matches: [],
        returned: 0,
        bounded: false,
        atLeast: 0,
        nextCursor: null,
        nextPageCursor: null,
        cancelled: false,
        corpusTruncated: true,
        coverageComplete: false,
        scannedLines: 0,
        scannedLinesTotal: 0,
        scopeFileCount: 1,
        timeFilterApplied: false,
        timeFilterUnknownReason: null,
        timeAuthorityUnavailableReason: null,
        expectedNormalizationRevision: 3,
      }),
    ).toThrow(/partly read corpus/);
  });

  it("only offers a cursor when advancing it can reach an uncounted match", () => {
    const complete = searchLogLines(three, searchRequest({ query: "edge" }));
    expect(complete.nextCursor).toBeNull();
    const firstPage = searchLogLines(three, searchRequest({ query: "edge", limit: 2 }));
    expect(firstPage.nextCursor).toBe(2);
    const lastPage = searchLogLines(
      three,
      searchRequest({ query: "edge", limit: 2, cursor: 2 }),
    );
    expect(lastPage.returned).toBe(1);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("does not warn about more lines on a final page", () => {
    const page = pageLogLines(three, EVIDENCE_A, 3, 2);
    expect(page.rows).toHaveLength(1);
    expect(page.nextStartLine).toBeNull();
    expect(page.bounded).toBe(false);
    expect(pageLogLines(three, EVIDENCE_A, 1, 2).bounded).toBe(true);
  });
});

describe("time range bounds are instants, never text", () => {
  const lines = splitLogText(
    EVIDENCE_A,
    "gateway/edge.log",
    DIGEST,
    "2024-03-10T07:30:00Z INFO edge early\n2024-03-10T08:30:00Z INFO edge late\n",
    null,
  );

  it("refuses a bound that is not a real instant instead of filtering by it", () => {
    for (const bad of ["yesterday", "2024-03-10 08:00", "2024-03-10", "08:00Z"]) {
      expect(() =>
        parseWorkbenchSearchRequest(
          searchRequest({ filters: { ...emptyFilters(), timeFrom: bad } }),
        ),
      ).toThrow(/full UTC instant/);
    }
  });

  it("refuses an inverted window rather than returning nothing", () => {
    expect(() =>
      parseWorkbenchSearchRequest(
        searchRequest({
          filters: {
            ...emptyFilters(),
            timeFrom: "2024-03-10T09:00:00Z",
            timeTo: "2024-03-10T08:00:00Z",
          },
        }),
      ),
    ).toThrow(/earlier than the start/);
  });

  it("compares instants, so an equivalent bound spelling filters the same way", () => {
    const zulu = searchLogLines(
      lines,
      searchRequest({ query: "edge", filters: { ...emptyFilters(), timeFrom: "2024-03-10T08:00:00Z" } }),
    );
    const offset = searchLogLines(
      lines,
      searchRequest({
        query: "edge",
        filters: { ...emptyFilters(), timeFrom: "2024-03-10T09:00:00+01:00" },
      }),
    );
    expect(zulu.returned).toBe(1);
    expect(zulu.matches[0]?.text).toMatch(/late/);
    expect(offset.returned).toBe(1);
    expect(offset.matches[0]?.text).toMatch(/late/);
  });

  it("counts the lines a window could not place instead of naming only the first", () => {
    const mixed = splitLogText(
      EVIDENCE_B,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 01:30:00 INFO sweep one\n2024-03-10 02:30:00 INFO sweep two\n",
      null,
    );
    const result = searchLogLines(
      mixed,
      searchRequest({
        query: "sweep",
        filters: {
          ...emptyFilters(),
          timeFrom: "2024-03-10T07:00:00Z",
          timeTo: "2024-03-10T09:00:00Z",
        },
      }),
    );
    expect(result.returned).toBe(0);
    expect(result.timeFilterUnknownReason).toMatch(/^2 lines were left out/);
    expect(result.timeFilterUnknownReason).toMatch(/Timezone review/);
  });

  it("holds a saved view to the same bound rule", () => {
    const view = load("fixtures", "log-workbench-view.valid.json") as Record<string, unknown>;
    expect(() => parseWorkbenchView({ ...view, timeFrom: "sometime tuesday" })).toThrow(
      /full UTC instant/,
    );
  });
});

describe("chronology unknowns are countable", () => {
  it("counts each line in exactly one unknown bucket", () => {
    const lines = splitLogText(
      EVIDENCE_B,
      "worker/batch.log",
      DIGEST,
      "2024-03-10 02:30:00 WARN heartbeat late\nno timestamp at all here\n",
      null,
    );
    const chronology = mergeChronology(lines, "none", 3);
    const total = chronology.unknownBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(2);
    expect(chronology.unknownBuckets.find((b) => b.category === "timezone")?.count).toBe(1);
    expect(chronology.unknownBuckets.find((b) => b.category === "timestamps")?.count).toBe(1);
  });

  it("names the lines a truncated corpus left out of the chronology", () => {
    const lines = splitLogText(EVIDENCE_A, "gateway/edge.log", DIGEST, "2024-03-10T07:30:00Z INFO edge\n", null);
    const chronology = mergeChronology(lines, "none", 3, new Map(), { corpusTruncated: true });
    expect(chronology.bounded).toBe(true);
    expect(chronology.unknownBuckets.some((bucket) => bucket.category === "corpus")).toBe(true);
  });
});
