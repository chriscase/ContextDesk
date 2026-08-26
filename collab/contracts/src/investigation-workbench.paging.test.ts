/**
 * Bounded reading and resumable search cursors.
 *
 * These pin the two properties the corpus limit used to violate: a reader must
 * never have to hold a whole investigation in memory to search it, and a page
 * that stops early must be able to say *where* it stopped rather than only how
 * many matches it had handed out.
 */
import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  WORKBENCH_LIMITS,
  WORKBENCH_PAGE_CURSOR_VERSION,
  WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
  countLogTextLines,
  createHostTimestampOverlay,
  createLogSearchScan,
  decodeWorkbenchPageCursor,
  encodeWorkbenchPageCursor,
  fileInScope,
  iterateLogLineWindows,
  parseWorkbenchSearchRequest,
  scopeFromSearchFilters,
  splitLogText,
  workbenchCorpusScopeDigest,
  type WorkbenchLine,
} from "./investigation-workbench.js";

const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const FILE = {
  evidenceId: EVIDENCE_A,
  relativePath: "gateway/edge.log",
  digest: DIGEST,
  intakeBatchId: null,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: WORKBENCH_SEARCH_REQUEST_SCHEMA_ID,
    query: "needle",
    mode: "literal",
    filters: {
      includeTerms: [],
      excludeTerms: [],
      severity: null,
      component: null,
      file: null,
      rotationFamily: null,
      timeFrom: null,
      timeTo: null,
      evidenceIds: [],
    },
    contextBefore: 1,
    contextAfter: 1,
    cursor: 0,
    limit: 10,
    expectedNormalizationRevision: 3,
    ...overrides,
  };
}

describe("a file is read in bounded windows", () => {
  const shapes = [
    ["empty file", ""],
    ["one line, no terminator", "only"],
    ["one line, terminated", "only\n"],
    ["blank last line kept", "one\n\n"],
    ["CRLF endings", "one\r\ntwo\r\nthree\r\n"],
    ["mixed endings", "one\r\ntwo\nthree"],
    ["lone carriage return is text", "one\rtwo"],
    ["leading blank line", "\nsecond\n"],
    ["only a newline", "\n"],
    ["unicode", "café ✅\nnaïve\n"],
  ] as const;

  it.each(shapes)("windows %s exactly as a whole-file read", (_label, text) => {
    const whole = splitLogText(EVIDENCE_A, FILE.relativePath, DIGEST, text, null);
    const windowed: WorkbenchLine[] = [];
    for (const window of iterateLogLineWindows(FILE, text, { windowLines: 3 })) {
      for (const row of window) windowed.push(row);
    }
    // Byte offsets and line numbers must be identical: a locator bound from a
    // windowed read and one bound from a whole read name the same line.
    expect(windowed).toEqual(whole);
    expect(countLogTextLines(text)).toBe(whole.length);
  });

  it("never holds more than the window bound, over 200,000 lines", () => {
    const text = `${Array.from({ length: 200_000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    let widest = 0;
    let rows = 0;
    let lastLine = 0;
    for (const window of iterateLogLineWindows(FILE, text)) {
      widest = Math.max(widest, window.length);
      rows += window.length;
      // Windows arrive in order and never overlap.
      expect(window[0]!.lineNumber).toBe(lastLine + 1);
      lastLine = window.at(-1)!.lineNumber;
    }
    expect(rows).toBe(200_000);
    expect(widest).toBeLessThanOrEqual(WORKBENCH_LIMITS.corpusWindowLines);
    expect(countLogTextLines(text)).toBe(200_000);
  });

  it("skips ahead without allocating the rows before the resume line", () => {
    const text = `${Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const rows: WorkbenchLine[] = [];
    for (const window of iterateLogLineWindows(FILE, text, { startLine: 4_990 })) {
      for (const row of window) rows.push(row);
    }
    expect(rows).toHaveLength(11);
    expect(rows[0]!.lineNumber).toBe(4_990);
    // Byte offsets are absolute, not relative to the resume point.
    const whole = splitLogText(EVIDENCE_A, FILE.relativePath, DIGEST, text, null);
    expect(rows[0]!.byteOffset).toBe(whole[4_989]!.byteOffset);
  });

  it("clamps an oversized window request to the resident bound", () => {
    const text = `${Array.from({ length: 6_000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    let widest = 0;
    for (const window of iterateLogLineWindows(FILE, text, { windowLines: 1_000_000 })) {
      widest = Math.max(widest, window.length);
    }
    expect(widest).toBe(WORKBENCH_LIMITS.corpusWindowLines);
  });
});

describe("scope is a predicate over file metadata", () => {
  const file = { evidenceId: EVIDENCE_A, relativePath: "gateway/edge.log.1" };

  it("selects by evidence id, path, and rotation family", () => {
    expect(fileInScope({ evidenceIds: [], file: null, rotationFamily: null }, file)).toBe(true);
    expect(fileInScope({ evidenceIds: [EVIDENCE_A], file: null, rotationFamily: null }, file))
      .toBe(true);
    expect(fileInScope({ evidenceIds: ["other"], file: null, rotationFamily: null }, file))
      .toBe(false);
    expect(fileInScope({ evidenceIds: [], file: "gateway/edge.log.1", rotationFamily: null }, file))
      .toBe(true);
    expect(fileInScope({ evidenceIds: [], file: "gateway/other.log", rotationFamily: null }, file))
      .toBe(false);
    expect(
      fileInScope({ evidenceIds: [], file: null, rotationFamily: "gateway/edge.log" }, file),
    ).toBe(true);
  });

  it("reads the same selection a search request already carries", () => {
    const scope = scopeFromSearchFilters(
      parseWorkbenchSearchRequest(
        request({ filters: { ...request().filters, evidenceIds: [EVIDENCE_A] } }),
      ).filters,
    );
    expect(scope.evidenceIds).toEqual([EVIDENCE_A]);
  });

  it("gives a different digest to a different file set or a changed file", () => {
    const one = workbenchCorpusScopeDigest([{ evidenceId: "a", relativePath: "a.log", digest: "d1" }]);
    const added = workbenchCorpusScopeDigest([
      { evidenceId: "a", relativePath: "a.log", digest: "d1" },
      { evidenceId: "b", relativePath: "b.log", digest: "d2" },
    ]);
    const changed = workbenchCorpusScopeDigest([
      { evidenceId: "a", relativePath: "a.log", digest: "d9" },
    ]);
    expect(one).not.toBe(added);
    expect(one).not.toBe(changed);
    expect(one).toBe(
      workbenchCorpusScopeDigest([{ evidenceId: "a", relativePath: "a.log", digest: "d1" }]),
    );
  });
});

describe("a resume cursor is a bounded, checkable record", () => {
  const cursor = {
    version: WORKBENCH_PAGE_CURSOR_VERSION,
    scopeDigest: "f".repeat(64),
    normalizationRevision: 3,
    evidenceId: EVIDENCE_A,
    lineNumber: 50_001,
    matchOrdinal: 4,
    scannedLines: 50_000,
  } as const;

  it("round-trips", () => {
    expect(decodeWorkbenchPageCursor(encodeWorkbenchPageCursor(cursor))).toEqual(cursor);
  });

  it("stays inside its length bound", () => {
    expect(encodeWorkbenchPageCursor(cursor).length).toBeLessThanOrEqual(
      WORKBENCH_LIMITS.maxPageCursorChars,
    );
  });

  it("refuses junk, an oversized token, and a foreign version", () => {
    expect(() => decodeWorkbenchPageCursor("")).toThrow(ContractViolation);
    expect(() => decodeWorkbenchPageCursor("not-base64-json")).toThrow(ContractViolation);
    expect(() => decodeWorkbenchPageCursor("x".repeat(2_000))).toThrow(/bounded resume token/);
    const foreign = Buffer.from(JSON.stringify({ ...cursor, version: 99 }), "utf8")
      .toString("base64url");
    expect(() => decodeWorkbenchPageCursor(foreign)).toThrow(/different contract/);
  });

  it("refuses a token with an unknown key rather than ignoring it", () => {
    const extra = Buffer.from(JSON.stringify({ ...cursor, sneak: 1 }), "utf8")
      .toString("base64url");
    expect(() => decodeWorkbenchPageCursor(extra)).toThrow(ContractViolation);
  });
});

describe("the search request contract accepts old and new callers", () => {
  it("validates a request that omits the resume token entirely", () => {
    const parsed = parseWorkbenchSearchRequest(request());
    expect(parsed.pageCursor).toBeUndefined();
    expect(parsed.cursor).toBe(0);
  });

  it("validates an explicit null and a real token", () => {
    expect(parseWorkbenchSearchRequest(request({ pageCursor: null })).pageCursor).toBeNull();
    expect(parseWorkbenchSearchRequest(request({ pageCursor: "abc" })).pageCursor).toBe("abc");
  });

  it("still refuses an unknown key", () => {
    expect(() => parseWorkbenchSearchRequest(request({ pageCursorr: "abc" })))
      .toThrow(ContractViolation);
  });
});

describe("a scan stops where it says it stopped", () => {
  const rows = (count: number, needleAt: number[]): WorkbenchLine[] =>
    splitLogText(
      EVIDENCE_A,
      FILE.relativePath,
      DIGEST,
      `${Array.from({ length: count }, (_, index) =>
        needleAt.includes(index + 1)
          ? `line ${index + 1} the needle is here`
          : `line ${index + 1} ordinary`,
      ).join("\n")}\n`,
      null,
    );

  it("reports a budget stop as bounded but resumable, not truncated", () => {
    const scan = createLogSearchScan(parseWorkbenchSearchRequest(request()), {
      scanBudgetLines: 100,
    });
    scan.feed(rows(500, [400]));
    const result = scan.finish({ scopeFileCount: 1, mintCursor: () => "token" });
    expect(scan.stop).toBe("budget");
    expect(result.returned).toBe(0);
    expect(result.bounded).toBe(true);
    expect(result.corpusTruncated).toBe(false);
    expect(result.coverageComplete).toBe(false);
    expect(result.nextPageCursor).toBe("token");
    expect(result.scannedLines).toBe(100);
  });

  it("offers no cursor, and admits truncation, when none can be offered", () => {
    const scan = createLogSearchScan(parseWorkbenchSearchRequest(request()), {
      scanBudgetLines: 100,
    });
    scan.feed(rows(500, [400]));
    const result = scan.finish({ scopeFileCount: 1, offerResume: false });
    expect(result.nextPageCursor).toBeNull();
    expect(result.corpusTruncated).toBe(true);
    expect(result.bounded).toBe(true);
  });

  it("resumes on the exact line the previous page stopped at", () => {
    const first = createLogSearchScan(parseWorkbenchSearchRequest(request()), {
      scanBudgetLines: 100,
    });
    first.feed(rows(500, [400]));
    const stopped = first.finish({
      scopeFileCount: 1,
      mintCursor: (point) => JSON.stringify(point),
    });
    const point = JSON.parse(stopped.nextPageCursor!) as {
      lineNumber: number;
      matchOrdinal: number;
      scannedLines: number;
      evidenceId: string;
    };
    expect(point.lineNumber).toBe(101);
    expect(point.matchOrdinal).toBe(0);
    expect(point.scannedLines).toBe(100);

    const second = createLogSearchScan(parseWorkbenchSearchRequest(request()), {
      resume: {
        matchOrdinal: point.matchOrdinal,
        scannedLines: point.scannedLines,
        evidenceId: point.evidenceId,
        lineNumber: point.lineNumber,
      },
    });
    second.feed(rows(500, [400]).slice(99));
    second.markComplete();
    const done = second.finish({ scopeFileCount: 1, mintCursor: () => "" });
    expect(done.matches.map((match) => match.lineNumber)).toEqual([400]);
    expect(done.coverageComplete).toBe(true);
    expect(done.scannedLinesTotal).toBe(500);
  });

  it("counts matches past the page limit so `at least` stays honest", () => {
    const scan = createLogSearchScan(parseWorkbenchSearchRequest(request({ limit: 3 })));
    scan.feed(rows(50, [1, 2, 3, 4, 5, 6, 7]));
    scan.markComplete();
    const result = scan.finish({ scopeFileCount: 1, mintCursor: () => "more" });
    expect(result.returned).toBe(3);
    expect(result.atLeast).toBe(7);
    expect(result.nextCursor).toBe(3);
    expect(result.nextPageCursor).toBe("more");
    expect(result.coverageComplete).toBe(true);
  });

  it("takes context only from the file the match is in", () => {
    const scan = createLogSearchScan(parseWorkbenchSearchRequest(request()));
    scan.feed(rows(3, [1]));
    scan.endFile();
    scan.markComplete();
    const result = scan.finish({ scopeFileCount: 1, mintCursor: () => "" });
    expect(result.matches[0]?.contextBefore).toEqual([]);
    expect(result.matches[0]?.contextAfter).toEqual(["line 2 ordinary"]);
  });
});

describe("the host timestamp overlay spends each stamp once", () => {
  it("applies across windows and never reuses a stamp", () => {
    const lines = splitLogText(
      EVIDENCE_A,
      "gateway/edge.log",
      DIGEST,
      "2024-03-10 01:00:00 INFO repeated message\n2024-03-10 01:00:00 INFO repeated message\n",
      null,
    );
    const overlay = createHostTimestampOverlay([
      {
        source: "edge.log",
        message: "repeated message",
        ts: 1_710_037_800,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      },
    ]);
    const first = overlay.apply([lines[0]!]);
    const second = overlay.apply([lines[1]!]);
    expect(first[0]?.normalizedUtc).not.toBeNull();
    // Only one host event existed, so only one line may claim it.
    expect(second[0]?.normalizedUtc).toBeNull();
  });

  it("leaves lines alone when the host reported nothing", () => {
    const lines = splitLogText(EVIDENCE_A, "gateway/edge.log", DIGEST, "one\n", null);
    expect(createHostTimestampOverlay([]).apply(lines)).toEqual(lines);
  });
});
